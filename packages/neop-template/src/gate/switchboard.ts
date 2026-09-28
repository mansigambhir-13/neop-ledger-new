import { strictest, type Manifest, type ManifestAbility, type Setting } from '@neop/contracts';
import { assertIdent, withCompany, type Pool } from '@neop/pgkit';
import { forcedAskFirst, parseRules, type Rule } from '../domain/rules.ts';

/** Who may say yes to a write (the company sets it; checked by the desk). */
export interface ApproverPolicy {
  roles?: ('admin' | 'member')[];
  four_eyes?: boolean;
}

/** One company's board, as <schema>.switchboard and <schema>.installs hold it (t010). */
export interface SwitchboardDoc {
  version: number;
  /** The company's own switch by line (it can only tighten the floor). */
  settings: Record<string, Setting>;
  rules: unknown[];
  budget: { per_job_usd?: number; per_day_usd?: number };
  /** Approver policy by write ability, and '*' for the company's default. */
  approvals: Record<string, ApproverPolicy>;
  company: { id: string; name: string; time_zone: string };
}

export interface BoardSnapshot {
  version: number;
  /** The effective setting of every line (min of floor and the company's switch; rules may force ask-first). */
  settings: Record<string, Setting>;
  /** The company's switches as the board holds them. */
  company_settings: Record<string, Setting>;
  rules: unknown[];
  budget: SwitchboardDoc['budget'];
}

export interface EffectiveBoard {
  version: number;
  rules: Rule[];
  budget: SwitchboardDoc['budget'];
  company: SwitchboardDoc['company'];
  setting(ability: ManifestAbility): Setting;
  /** The company's own setting for a key this app does not own (borrowed lines). */
  hostSetting(key: string): Setting;
  /** The company's own row for a line, if it has set one (v3 S6: a borrowed line is off until the company sets it). */
  companySetting(key: string): Setting | undefined;
  /** The board as a job runs on it (jobs.switchboard_snapshot, t007). */
  snapshot(): BoardSnapshot;
}

/** The app is not installed (or no longer) for this company: the gate acts for nobody there. */
export class NotInstalled extends Error {
  readonly status = 403;
  readonly code = 'not_installed';
}

/** How long a board is trusted without a NOTIFY. The poll is the truth; 'board:<company>' is latency. */
export const BOARD_TTL_MS = 5_000;

/**
 * Read one company's board from the app's own schema (WP v3 §4 "one table, one truth"):
 * <schema>.switchboard (lines, the company row '*' with rules, caps and the default approver policy),
 * the board version (history included, so a deleted line still moves it) and <schema>.installs.
 */
export async function loadBoard(pool: Pool, schema: string, companyId: string): Promise<SwitchboardDoc> {
  assertIdent(schema);
  const r = await pool.query<{ sb: any[] | null; version: number; install: any | null }>(
    `select (select json_agg(json_build_object('line', s.line, 'setting', s.setting, 'caps', s.caps, 'rules', s.rules, 'approvers', s.approvers))
               from ${schema}.switchboard s where s.company_id = $1) as sb,
            greatest(coalesce((select max(version) from ${schema}.switchboard where company_id = $1), 0),
                     coalesce((select max(version) from ${schema}.switchboard_history where company_id = $1), 0))::int as version,
            (select row_to_json(i) from (select status, company_name, time_zone from ${schema}.installs where company_id = $1) i) as install`,
    [companyId],
  );
  const row = r.rows[0]!;
  const inst = row.install as { status: string; company_name: string | null; time_zone: string | null } | null;
  if (!inst || inst.status !== 'active') throw new NotInstalled(`${schema} is not installed for this company`);
  if (!inst.time_zone) throw new NotInstalled(`${schema}'s install for this company has no time zone yet (run scripts/v3/backfill-boards.ts)`);
  const doc: SwitchboardDoc = {
    version: row.version,
    settings: {},
    rules: [],
    budget: {},
    approvals: {},
    company: { id: companyId, name: inst.company_name ?? '', time_zone: inst.time_zone },
  };
  for (const l of row.sb ?? []) {
    if (l.line === '*') {
      doc.rules = Array.isArray(l.rules) ? l.rules : [];
      doc.budget = l.caps && typeof l.caps === 'object' ? l.caps : {};
      if (l.approvers) doc.approvals['*'] = l.approvers;
      continue;
    }
    doc.settings[l.line] = l.setting;
    if (l.approvers) doc.approvals[l.line] = l.approvers;
  }
  return doc;
}

/**
 * The gate evaluates the board from a local cache stamped with its version. It is dropped on
 * NOTIFY 'board:<company>' (a change to the switchboard, the install or a grant — the runner's
 * listener calls invalidate), when older than BOARD_TTL_MS, or when a caller needs a newer version.
 */
export class SwitchboardCache {
  private cache = new Map<string, { doc: SwitchboardDoc; at: number }>();
  readonly pool: Pool;
  readonly schema: string;
  readonly manifest: Manifest;
  constructor(pool: Pool, schema: string, manifest: Manifest) {
    this.pool = pool;
    this.schema = schema;
    this.manifest = manifest;
  }

  invalidate(companyId: string): void {
    this.cache.delete(companyId);
  }

  /** One read of the company's board from the database (spy on this to count reads). */
  load(companyId: string): Promise<SwitchboardDoc> {
    return loadBoard(this.pool, this.schema, companyId);
  }

  async get(companyId: string, minVersion = 0): Promise<EffectiveBoard> {
    let hit = this.cache.get(companyId);
    if (!hit || Date.now() - hit.at > BOARD_TTL_MS || hit.doc.version < minVersion) {
      hit = { doc: await this.load(companyId), at: Date.now() };
      this.cache.set(companyId, hit);
    }
    return this.effective(hit.doc);
  }

  private effective(doc: SwitchboardDoc): EffectiveBoard {
    const rules = parseRules(doc.rules);
    const manifest = this.manifest;
    const board: EffectiveBoard = {
      version: doc.version,
      rules,
      budget: doc.budget ?? {},
      company: doc.company,
      hostSetting(key) {
        return strictest('on', doc.settings[key]);
      },
      companySetting(key) {
        return doc.settings[key];
      },
      setting(ability) {
        // effective = min(app floor, company setting); require_person forces ask-first.
        let s = strictest(ability.floor, doc.settings[ability.key]);
        if (s === 'on' && ability.kind === 'write' && forcedAskFirst(rules, ability.key)) s = 'ask_first';
        return s;
      },
      snapshot() {
        const settings: Record<string, Setting> = {};
        for (const a of manifest.abilities) settings[a.key] = board.setting(a);
        for (const k of Object.keys(doc.settings ?? {})) if (!(k in settings)) settings[k] = board.hostSetting(k);
        return { version: doc.version, settings, company_settings: { ...(doc.settings ?? {}) }, rules: Array.isArray(doc.rules) ? doc.rules : [], budget: doc.budget ?? {} };
      },
    };
    return board;
  }

  /**
   * After a release: the app's own floors and kinds are re-stamped on the lines the company has set
   * (the runner's right, t010). A floor that tightened pulls the company's switch up with it; a line
   * the company never set follows the manifest by itself (no row means "the floor").
   */
  async syncFloors(runnerPool: Pool): Promise<number> {
    const lines = [
      ...this.manifest.abilities.map((a) => ({ line: a.key, kind: a.kind, floor: a.floor })),
      ...this.manifest.doors.map((d) => ({ line: `door:${d.key}`, kind: 'door', floor: d.floor ?? 'on' })),
    ];
    const s = this.schema;
    const manifest = `jsonb_to_recordset($1::jsonb) as l(line text, kind text, floor text)`;
    const stale = `where s.line = l.line and (s.kind is distinct from l.kind or s.floor is distinct from l.floor
                                   or ${s}.setting_rank(s.setting) < ${s}.setting_rank(l.floor))`;
    const json = JSON.stringify(lines);
    const companies = (await runnerPool.query<{ company_id: string }>(`select distinct s.company_id from ${s}.switchboard s, ${manifest} ${stale}`, [json])).rows;
    let n = 0;
    // One company per transaction: a board version (and its history) belongs to one company.
    for (const { company_id } of companies) {
      n += await withCompany(runnerPool, company_id, async (c) => {
        const r = await c.query(
          `update ${s}.switchboard s
              set kind = l.kind, floor = l.floor,
                  setting = case when ${s}.setting_rank(s.setting) < ${s}.setting_rank(l.floor) then l.floor else s.setting end,
                  updated_by = 'app:${s}'
             from ${manifest} ${stale} and s.company_id = $2`,
          [json, company_id],
        );
        return r.rowCount ?? 0;
      });
    }
    return n;
  }
}
