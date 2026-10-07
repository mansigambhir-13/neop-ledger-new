import {sqlIdent} from '@neop/pgkit';
// v3 S1 · the platform writes THROUGH to each NEOP's own schema (WP v3 §4, §5, §11): the switchboard,
// the install and the standing yeses live in <app>.switchboard, <app>.installs and <app>.grants (template
// t010), and are read from there too; neos.installs is the platform's own record (what NeuralChat offers and
// the desk lists) and is written in the same call. v3 S9: everything else the desk does to an app goes through
// the app's own SECURITY DEFINER functions here too (cancel_job, set_schedule, list_schedules, job_transcript,
// block_read — template t018): the platform has no other way into an app.
//
// How the platform reaches an app's schema: the platform pool's role (neos_app) is a member of neos_desk
// WITH INHERIT FALSE (migratePlatform), so it holds none of the desk's rights until a transaction says
// `SET LOCAL ROLE neos_desk`. SET LOCAL lasts until the end of that transaction only, so the same pool
// works through PgBouncer in transaction mode; nothing is left on a pooled connection. neos_desk may write
// switchboard and installs, read the board history and the grants, and call answer_proposal / answer_wait /
// create_grant / revoke_grant / set_schedule and t018's functions — nothing else in the app's schema (pgkit deskGrantsSql).

import { strictest, type Manifest, type Setting } from '@neop/contracts';
import { assertIdent, DESK_ROLE, tx, type Pool, type PoolClient } from '@neop/pgkit';

export interface ApproverPolicyDoc {
  roles?: ('admin' | 'member')[];
  four_eyes?: boolean;
}

/** A company's board for one app, in the shape the platform has always served it. */
export interface BoardDoc {
  version: number;
  settings: Record<string, Setting>;
  rules: unknown[];
  budget: Record<string, number>;
  approvals: Record<string, ApproverPolicyDoc>;
}

/** What a line is, from the app's manifest (own abilities, package abilities, doors, skills). */
export interface LineMeta {
  kind: string | null;
  floor: Setting | null;
}

export const EMPTY_BOARD: BoardDoc = { version: 0, settings: {}, rules: [], budget: {}, approvals: {} };

const isUuid = (s: unknown): s is string => typeof s === 'string' && /^[0-9a-f-]{36}$/i.test(s);

export class AppBoards {
  readonly db: Pool;
  private readonly log: (msg: string, extra?: Record<string, unknown>) => void;
  constructor(db: Pool, log: (msg: string, extra?: Record<string, unknown>) => void = () => {}) {
    this.db = db;
    this.log = log;
  }

  /**
   * One transaction as the desk, scoped to one company (row-level security in the app's schema).
   * `fn` gets null when the app has no NEOP schema (at t010 or later) on this database.
   */
  async asDesk<T>(app: string, companyId: string, fn: (c: PoolClient, schema: string | null) => Promise<T>, actor?: string): Promise<T> {
    assertIdent(app);
    if (!isUuid(companyId)) throw Object.assign(new Error('company_id required'), { status: 400, code: 'bad_request' });
    return tx(this.db, async (c) => {
      await c.query(`set local role ${DESK_ROLE}`);
      await c.query("select set_config('neos.company_id', $1, true)", [companyId]);
      if (actor) await c.query("select set_config('neos.actor', $1, true)", [actor.slice(0, 200)]);
      const ok = (
        await c.query<{ ok: boolean }>(
          `select case when to_regnamespace($1) is null then false when not has_schema_privilege($1, 'usage') then false
                       else to_regclass($2) is not null end as ok`,
          [app, `${sqlIdent(app)}.switchboard_history`],
        )
      ).rows[0]?.ok;
      return fn(c, ok ? app : null);
    });
  }

  /** The board (version, the company's switches, rules, budget, approver policies) from <app>.switchboard. */
  async read(app: string, companyId: string): Promise<BoardDoc | null> {
    if (!/^[a-z][a-z0-9_]{0,40}$/.test(app)) return null;
    return this.asDesk(app, companyId, (c, s) => (s ? readBoard(c, s, companyId) : Promise.resolve(null)));
  }

  /**
   * Write a whole board (already validated by the caller) as one new version: the company row '*' always
   * (so every save is a version, recorded with who saved it), and each line whose switch or policy changed.
   * Returns the new version. Throws `no_app_schema` when the app has no schema here.
   */
  async write(app: string, companyId: string, by: string, next: Omit<BoardDoc, 'version'>, meta: (line: string) => LineMeta): Promise<number> {
    return this.asDesk(
      app,
      companyId,
      async (c, s) => {
        if (!s) throw Object.assign(new Error(`${app} has no schema on this database: its board cannot be written`), { status: 409, code: 'no_app_schema' });
        await writeBoard(c, s, companyId, by, next, meta, null);
        return (await readBoard(c, s, companyId)).version;
      },
      by,
    );
  }

  /** The install row in the app's schema; false when the app has no schema here (nothing to write). */
  async writeInstall(app: string, companyId: string, row: { status: 'active' | 'removed' | 'suspended'; company_name: string; time_zone: string; installed_by?: string | null }): Promise<boolean> {
    return this.asDesk(
      app,
      companyId,
      async (c, s) => {
        if (!s) return false;
        await c.query(
          `insert into ${sqlIdent(s)}.installs as i (company_id, status, company_name, time_zone, installed_by, installed_at, updated_at)
           values ($1, $2, $3, $4, $5, case when $2 = 'active' then now() end, now())
           on conflict (company_id) do update
             set status = excluded.status, company_name = excluded.company_name, time_zone = excluded.time_zone,
                 installed_by = coalesce(excluded.installed_by, i.installed_by),
                 installed_at = case when excluded.status = 'active' and i.status <> 'active' then now() else coalesce(i.installed_at, excluded.installed_at) end,
                 updated_at = now()
             where (i.status, i.company_name, i.time_zone) is distinct from (excluded.status, excluded.company_name, excluded.time_zone)
                or (excluded.installed_by is not null and i.installed_by is distinct from excluded.installed_by)`,
          [companyId, row.status, row.company_name, row.time_zone, row.installed_by ?? null],
        );
        return true;
      },
      row.installed_by ?? undefined,
    );
  }

  /**
   * v3 S4 (template t012): who may talk to the app in Matrix at this company, written into the app's own schema
   * so its presence (src/presence) never reads schema neos. `people` replaces the company's rows (every person
   * linked to a Matrix id; `chat_person` = on this app's allowlist as a person); `agent_senders` /
   * `agent_acts_for` are the allowlisted non-people (bridges, the reasoning agent, other NEOPs) and the person
   * each relays for. `identity` (the app's own Matrix name here, its rooms) is written only when given.
   * False when the app has no schema at t012 or later here (nothing to write).
   */
  async writeChat(
    app: string,
    companyId: string,
    d: {
      people?: { matrix_id: string; user_id: string; name: string | null; role: string | null; chat_person: boolean }[];
      /** t017: the people a bridge relays for (they need no Matrix id of their own); replaces the company's rows. */
      acted_for?: { user_id: string; name: string | null; role: string | null }[];
      agent_senders?: string[];
      agent_acts_for?: Record<string, string>;
      company_slug?: string;
      identity?: { matrix_user?: string | null; room_ids?: string[]; bus_room_id?: string | null; bus_peers?: Record<string, string> };
    },
    actor?: string,
  ): Promise<boolean> {
    return this.asDesk(
      app,
      companyId,
      async (c, s) => {
        if (!s) return false;
        const has = (await c.query<{ ok: boolean }>('select to_regclass($1) is not null as ok', [`${sqlIdent(s)}.people`])).rows[0]?.ok;
        if (!has) return false;
        const inst = await c.query(`select 1 from ${sqlIdent(s)}.installs where company_id = $1`, [companyId]);
        if (!inst.rowCount) return false;
        if (d.people) {
          const ids = d.people.map((p) => p.matrix_id);
          await c.query(`delete from ${sqlIdent(s)}.people where company_id = $1 and not (matrix_id = any($2::text[]))`, [companyId, ids]);
          for (const p of d.people) {
            await c.query(
              `insert into ${sqlIdent(s)}.people as p (company_id, matrix_id, user_id, name, role, chat_person, updated_at) values ($1, $2, $3, $4, $5, $6, now())
               on conflict (company_id, matrix_id) do update set user_id = excluded.user_id, name = excluded.name, role = excluded.role, chat_person = excluded.chat_person, updated_at = now()
                 where (p.user_id, p.name, p.role, p.chat_person) is distinct from (excluded.user_id, excluded.name, excluded.role, excluded.chat_person)`,
              [companyId, p.matrix_id, p.user_id, p.name, p.role, p.chat_person],
            );
          }
        }
        if (d.acted_for && (await c.query<{ ok: boolean }>('select to_regclass($1) is not null as ok', [`${sqlIdent(s)}.acted_for`])).rows[0]?.ok) {
          const ids = d.acted_for.map((p) => p.user_id);
          await c.query(`delete from ${sqlIdent(s)}.acted_for where company_id = $1 and not (user_id = any($2::text[]))`, [companyId, ids]);
          for (const p of d.acted_for) {
            await c.query(
              `insert into ${sqlIdent(s)}.acted_for as p (company_id, user_id, name, role, updated_at) values ($1, $2, $3, $4, now())
               on conflict (company_id, user_id) do update set name = excluded.name, role = excluded.role, updated_at = now()
                 where (p.name, p.role) is distinct from (excluded.name, excluded.role)`,
              [companyId, p.user_id, p.name, p.role],
            );
          }
        }
        if (d.agent_senders || d.agent_acts_for) {
          await c.query(
            `update ${sqlIdent(s)}.installs set agent_senders = coalesce($2::text[], agent_senders), agent_acts_for = coalesce($3::jsonb, agent_acts_for), updated_at = now()
              where company_id = $1 and (agent_senders, agent_acts_for) is distinct from (coalesce($2::text[], agent_senders), coalesce($3::jsonb, agent_acts_for))`,
            [companyId, d.agent_senders ?? null, d.agent_acts_for ? JSON.stringify(d.agent_acts_for) : null],
          );
        }
        if (d.company_slug) await c.query(`update ${sqlIdent(s)}.installs set company_slug = $2 where company_id = $1 and company_slug is distinct from $2`, [companyId, d.company_slug]);
        if (d.identity) {
          if (d.identity.matrix_user !== undefined) await c.query(`update ${sqlIdent(s)}.installs set matrix_user = $2, updated_at = now() where company_id = $1`, [companyId, d.identity.matrix_user]);
          if (d.identity.room_ids) await c.query(`update ${sqlIdent(s)}.installs set room_ids = $2::text[], updated_at = now() where company_id = $1`, [companyId, d.identity.room_ids]);
          // v3 S6 (template t015): the company's bus room and the other apps on it — written by rooms-setup.
          if (d.identity.bus_room_id !== undefined || d.identity.bus_peers !== undefined) {
            if (!(await hasColumn(c, s, 'installs', 'bus_room_id'))) throw Object.assign(new Error(`${app} has no bus room columns (template t015) on this database`), { status: 409, code: 'no_bus_columns' });
            if (d.identity.bus_room_id !== undefined) await c.query(`update ${sqlIdent(s)}.installs set bus_room_id = $2, updated_at = now() where company_id = $1`, [companyId, d.identity.bus_room_id]);
            if (d.identity.bus_peers !== undefined) await c.query(`update ${sqlIdent(s)}.installs set bus_peers = $2::jsonb, updated_at = now() where company_id = $1`, [companyId, JSON.stringify(d.identity.bus_peers)]);
          }
        }
        return true;
      },
      actor,
    );
  }

  /** The app's Matrix identity and rooms at this company, as its own schema holds them (null: no t012 schema). */
  async readChatIdentity(
    app: string,
    companyId: string,
  ): Promise<{ matrix_user: string | null; room_ids: string[]; agent_senders: string[]; agent_acts_for: Record<string, string>; bus_room_id?: string | null; bus_peers?: Record<string, string> } | null> {
    return this.asDesk(app, companyId, async (c, s) => {
      if (!s) return null;
      const has = (await c.query<{ ok: boolean }>('select to_regclass($1) is not null as ok', [`${sqlIdent(s)}.people`])).rows[0]?.ok;
      if (!has) return null;
      // bus_room_id / bus_peers (t015) are read through to_jsonb, so a schema before t015 still answers.
      const row = (
        await c.query(
          `select matrix_user, room_ids, agent_senders, agent_acts_for, to_jsonb(i)->>'bus_room_id' as bus_room_id, to_jsonb(i)->'bus_peers' as bus_peers from ${sqlIdent(s)}.installs i where company_id = $1`,
          [companyId],
        )
      ).rows[0];
      if (!row) return null;
      const { bus_room_id, bus_peers, ...rest } = row;
      return bus_room_id || (bus_peers && Object.keys(bus_peers).length) ? { ...rest, bus_room_id, bus_peers: bus_peers ?? {} } : rest;
    });
  }

  /** Is the app installed for the company, as its own schema says? null when the app has no schema here. */
  async installStatus(app: string, companyId: string): Promise<string | null> {
    return this.asDesk(app, companyId, async (c, s) => (s ? ((await c.query<{ status: string }>(`select status from ${sqlIdent(s)}.installs where company_id = $1`, [companyId])).rows[0]?.status ?? 'none') : null));
  }

  /** create_grant, as the desk (the function validates the limits and the expiry again). */
  async createGrant(app: string, companyId: string, g: { ability_key: string; limits: Record<string, unknown>; expires_at: Date; by: string }): Promise<string> {
    return this.asDesk(app, companyId, async (c, s) => {
      if (!s) throw Object.assign(new Error(`${app} has no schema on this database`), { status: 409, code: 'no_app_schema' });
      return (await c.query<{ id: string }>(`select ${sqlIdent(s)}.create_grant($1, $2::jsonb, $3, $4) as id`, [g.ability_key, JSON.stringify(g.limits), g.expires_at, g.by])).rows[0]!.id;
    });
  }

  /** revoke_grant, as the desk: {changed:false} when it was already revoked; null when this app never had it. */
  async revokeGrant(app: string, companyId: string, id: string, by: string): Promise<{ changed: boolean; ability_key: string } | null> {
    return this.asDesk(app, companyId, async (c, s) => {
      if (!s) return null;
      const has = await c.query(`select 1 from ${sqlIdent(s)}.grants where grant_id = $1`, [id]);
      if (!has.rowCount) return null;
      const r = (await c.query<{ r: { changed: boolean; ability_key: string } }>(`select ${sqlIdent(s)}.revoke_grant($1, $2) as r`, [id, by])).rows[0]!.r;
      return r;
    });
  }

  /** The company's standing yeses in one app, with what they were used for (this month in the company's time zone). */
  async listGrants(app: string, companyId: string, timeZone: string): Promise<any[]> {
    return this.asDesk(app, companyId, async (c, s) => {
      if (!s) return [];
      return (
        await c.query(
          `select g.grant_id as id, $1::text as app_key, g.ability_key, g.limits, g.status, g.expires_at, g.created_at, g.suspended_reason, g.created_by,
                  (select count(*)::int from ${sqlIdent(s)}.grant_uses u where u.grant_id = g.grant_id) as uses,
                  (select coalesce(sum(u.amount_minor), 0)::bigint from ${sqlIdent(s)}.grant_uses u
                    where u.grant_id = g.grant_id and u.at >= (date_trunc('month', now() at time zone $2) at time zone $2)) as used_this_month_minor,
                  (select max(u.at) from ${sqlIdent(s)}.grant_uses u where u.grant_id = g.grant_id) as last_used_at
             from ${sqlIdent(s)}.grants g`,
          [app, timeZone],
        )
      ).rows;
    });
  }

  /**
   * v3 S2: a person's answer on a card, written through to the app's own proposal row by the one function that
   * takes answers (<app>.answer_proposal, template t011): fingerprint, expiry, the legal transition and the
   * approver policy (roles, four-eyes) are all checked there. `roles` are the person's roles as the platform
   * knows them. Returns the function's result ({status, idempotent, job_id[, refused]}); a refusal the function
   * raises comes back as the database error (message `<code>: …`). Throws `no_app_schema` when the app has no
   * schema here.
   */
  async answer(
    app: string,
    companyId: string,
    a: { proposal_id: string; fingerprint_seen: string; decision: string; by: string; feedback?: string | null; roles?: string[] | null },
  ): Promise<{ status: string; idempotent: boolean; job_id: string; refused?: string }> {
    return this.asDesk(
      app,
      companyId,
      async (c, s) => {
        if (!s) throw Object.assign(new Error(`${app} has no schema on this database: the answer cannot be recorded`), { status: 409, code: 'no_app_schema' });
        const r = await c.query<{ r: { status: string; idempotent: boolean; job_id: string; refused?: string } }>(
          `select ${sqlIdent(s)}.answer_proposal($1, $2, $3, $4, $5, $6) as r`,
          [a.proposal_id, a.fingerprint_seen, a.decision, a.by, a.feedback ?? null, a.roles ?? null],
        );
        return r.rows[0]!.r; // a fingerprint refusal commits its proposal_events row and is reported by the caller
      },
      a.by,
    );
  }

  /**
   * v3 S3 · one transaction as the desk, scoped to one company, with no app schema in it: reads of the desk's union
   * views (neos.v_questions, neos.v_open_questions, neos.v_activity, …). The views carry every company's rows, so the
   * caller filters on company_id; the setting scopes any app schema a view's function reads with row-level security.
   */
  async deskRead<T>(companyId: string, fn: (c: PoolClient) => Promise<T>): Promise<T> {
    if (!isUuid(companyId)) throw Object.assign(new Error('company_id required'), { status: 400, code: 'bad_request' });
    return tx(this.db, async (c) => {
      await c.query(`set local role ${DESK_ROLE}`);
      await c.query("select set_config('neos.company_id', $1, true)", [companyId]);
      return fn(c);
    });
  }

  /**
   * v3 S3 · an answer to a job's question lands on the app's own wait through <app>.answer_wait() (template t013),
   * as the desk: who may answer, open-ness, expiry, the fields and the idempotent repeat are all checked there.
   * Returns the function's result ({status: 'answered', idempotent} | {status: 'stale', reason}); a refusal comes back
   * as the database error (message `<code>: …`). Throws `no_app_schema` when the app has no schema at t013 here.
   */
  async answerWait(
    app: string,
    companyId: string,
    a: { wait_id: string; answers: Record<string, unknown>; by: string; via: string },
  ): Promise<{ status: 'answered' | 'stale'; wait_id: string; job_id: string; idempotent?: boolean; reason?: string }> {
    return this.asDesk(
      app,
      companyId,
      async (c, s) => {
        const fn = s ? (await c.query<{ ok: boolean }>('select to_regprocedure($1) is not null as ok', [`${sqlIdent(s)}.answer_wait(uuid, jsonb, text, text)`])).rows[0]?.ok : false;
        if (!s || !fn) throw Object.assign(new Error(`${app} has no answer_wait on this database: the answer cannot be recorded`), { status: 409, code: 'no_app_schema' });
        return (await c.query(`select ${sqlIdent(s)}.answer_wait($1, $2::jsonb, $3, $4) as r`, [a.wait_id, JSON.stringify(a.answers), a.by, a.via])).rows[0]!.r;
      },
      a.by,
    );
  }

  /**
   * v3 S9 (template t018) · the functions that replaced the gateway's platform doors, called as the desk under the
   * company: `cancel_job`, `set_schedule` / `list_schedules`, `job_transcript`, `block_read`. Each throws
   * `no_app_schema` (409) when the app has no such function on this database; a refusal the function raises comes back
   * as the database error (message `<code>: …`, with its SQLSTATE).
   */
  async deskCall<T>(app: string, companyId: string, fn: string, signature: string, args: unknown[], by?: string): Promise<T> {
    return this.asDesk(
      app,
      companyId,
      async (c, s) => {
        const ok = s ? (await c.query<{ ok: boolean }>('select to_regprocedure($1) is not null as ok', [`${sqlIdent(s)}.${fn}(${signature})`])).rows[0]?.ok : false;
        if (!s || !ok) throw Object.assign(new Error(`${app} has no ${fn} on this database (template t018 or later)`), { status: 409, code: 'no_app_schema' });
        const params = args.map((_, i) => `$${i + 1}`).join(', ');
        return (await c.query<{ r: T }>(`select ${sqlIdent(s)}.${fn}(${params}) as r`, args)).rows[0]!.r;
      },
      by,
    );
  }

  /** What standing yeses approved for one job (the task view's grant_uses). */
  async grantUsesForJob(app: string, companyId: string, jobId: string): Promise<{ at: Date; ability_key: string; detail: Record<string, unknown> }[]> {
    if (!isUuid(jobId)) return [];
    return this.asDesk(app, companyId, async (c, s) => {
      if (!s) return [];
      return (
        await c.query(
          `select at, ability_key, jsonb_build_object('grant_id', grant_id, 'proposal_id', proposal_id, 'fingerprint', fingerprint,
                    'amount_minor', amount_minor, 'currency', currency, 'job_id', job_id) as detail
             from ${sqlIdent(s)}.grant_uses where job_id = $1 order by at`,
          [jobId],
        )
      ).rows;
    });
  }

  /** Every saved version of the board, newest first (replayed from <app>.switchboard_history). */
  async history(app: string, companyId: string, limit = 50): Promise<(BoardDoc & { updated_at: Date; updated_by: string | null })[]> {
    return this.asDesk(app, companyId, async (c, s) => {
      if (!s) return [];
      const rows = (await c.query<{ version: number; line: string; op: string; after: any; changed_by: string | null; at: Date }>(`select version, line, op, after, changed_by, at from ${sqlIdent(s)}.switchboard_history order by id`)).rows;
      const cur: BoardDoc = { version: 0, settings: {}, rules: [], budget: {}, approvals: {} };
      const out: (BoardDoc & { updated_at: Date; updated_by: string | null })[] = [];
      for (const h of rows) {
        if (h.line === '*') {
          if (h.op === 'delete') {
            cur.rules = [];
            cur.budget = {};
            delete cur.approvals['*'];
          } else {
            cur.rules = Array.isArray(h.after?.rules) ? h.after.rules : [];
            cur.budget = h.after?.caps ?? {};
            if (h.after?.approvers) cur.approvals['*'] = h.after.approvers;
            else delete cur.approvals['*'];
          }
        } else if (h.op === 'delete') {
          delete cur.settings[h.line];
          delete cur.approvals[h.line];
        } else {
          cur.settings[h.line] = h.after?.setting;
          if (h.after?.approvers) cur.approvals[h.line] = h.after.approvers;
          else delete cur.approvals[h.line];
        }
        const snap = { version: h.version, settings: { ...cur.settings }, rules: [...cur.rules], budget: { ...cur.budget }, approvals: { ...cur.approvals }, updated_at: h.at, updated_by: h.changed_by };
        if (out.at(-1)?.version === h.version) out[out.length - 1] = { ...snap, updated_by: out.at(-1)!.updated_by ?? h.changed_by };
        else out.push(snap);
      }
      return out.reverse().slice(0, limit);
    });
  }
}

/** Read one company's board inside a desk transaction. */
export async function readBoard(c: PoolClient, s: string, companyId: string): Promise<BoardDoc> {
  const rows = (await c.query<{ line: string; setting: Setting; caps: any; rules: any; approvers: any }>(`select line, setting, caps, rules, approvers from ${sqlIdent(s)}.switchboard where company_id = $1`, [companyId])).rows;
  const v = (
    await c.query<{ v: number }>(
      `select greatest(coalesce((select max(version) from ${sqlIdent(s)}.switchboard where company_id = $1), 0),
                       coalesce((select max(version) from ${sqlIdent(s)}.switchboard_history where company_id = $1), 0))::int as v`,
      [companyId],
    )
  ).rows[0]!.v;
  const doc: BoardDoc = { version: v, settings: {}, rules: [], budget: {}, approvals: {} };
  for (const r of rows) {
    if (r.line === '*') {
      doc.rules = Array.isArray(r.rules) ? r.rules : [];
      doc.budget = r.caps && typeof r.caps === 'object' ? r.caps : {};
      if (r.approvers) doc.approvals['*'] = r.approvers;
    } else {
      doc.settings[r.line] = r.setting;
      if (r.approvers) doc.approvals[r.line] = r.approvers;
    }
  }
  return doc;
}

/**
 * Write `next` as the company's board. `replace` (the backfill) also removes every line `next` does not
 * list and stamps the rows with the given version; otherwise only changed lines are written. A company
 * switch is never written looser than the line's floor (a floor that tightened since pulls it up).
 */
export async function writeBoard(c: PoolClient, s: string, companyId: string, by: string, next: Omit<BoardDoc, 'version'>, meta: (line: string) => LineMeta, replace: { version: number } | null): Promise<void> {
  const cur = (await c.query<{ line: string; setting: string; approvers: any; floor: string | null }>(`select line, setting, approvers, floor from ${sqlIdent(s)}.switchboard where company_id = $1`, [companyId])).rows;
  const have = new Map(cur.map((r) => [r.line, r]));
  const version = replace?.version ?? null;
  // The company row: rules, caps, the default approver policy. Always written, so the save is a version.
  await c.query(
    `insert into ${sqlIdent(s)}.switchboard as t (company_id, line, kind, floor, setting, caps, rules, approvers, updated_by, version)
     values ($1, '*', 'company', null, 'on', $2::jsonb, $3::jsonb, $4::jsonb, $5, $6)
     on conflict (company_id, line) do update
       set caps = excluded.caps, rules = excluded.rules, approvers = excluded.approvers, updated_by = excluded.updated_by,
           version = coalesce($6, t.version)`,
    [companyId, JSON.stringify(next.budget ?? {}), JSON.stringify(next.rules ?? []), next.approvals?.['*'] ? JSON.stringify(next.approvals['*']) : null, by, version],
  );
  const lines = new Set([...Object.keys(next.settings ?? {}), ...Object.keys(next.approvals ?? {}).filter((k) => k !== '*')]);
  for (const line of lines) {
    const m = meta(line);
    const floor = (have.get(line)?.floor as Setting | null | undefined) ?? m.floor;
    const wanted = (next.settings?.[line] as Setting | undefined) ?? floor ?? 'on';
    const setting = floor ? strictest(floor, wanted) : wanted;
    const approvers = next.approvals?.[line] ?? null;
    const prev = have.get(line);
    if (!replace && prev && prev.setting === setting && JSON.stringify(prev.approvers ?? null) === JSON.stringify(approvers)) continue;
    await c.query(
      `insert into ${sqlIdent(s)}.switchboard as t (company_id, line, kind, floor, setting, approvers, updated_by, version)
       values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
       on conflict (company_id, line) do update
         set setting = excluded.setting, approvers = excluded.approvers, updated_by = excluded.updated_by,
             kind = coalesce(t.kind, excluded.kind), floor = coalesce(t.floor, excluded.floor), version = coalesce($8, t.version)`,
      [companyId, line, m.kind, m.floor, setting, approvers ? JSON.stringify(approvers) : null, by, version],
    );
  }
  if (replace) {
    await c.query(`delete from ${sqlIdent(s)}.switchboard where company_id = $1 and line <> '*' and not (line = any($2::text[]))`, [companyId, [...lines]]);
  }
}

async function hasColumn(c: PoolClient, schema: string, table: string, column: string): Promise<boolean> {
  return !!(await c.query('select 1 from information_schema.columns where table_schema = $1 and table_name = $2 and column_name = $3', [schema, table, column])).rowCount;
}

export function lineMetaFrom(manifest: Manifest | null | undefined, packageAbilities: { key: string; kind: string; floor: Setting }[]): (line: string) => LineMeta {
  const owned = new Set([...(manifest?.abilities ?? []).map((a) => a.key), ...packageAbilities.map((a) => a.key)]);
  const pinnedRequirements = new Set([
    ...(manifest?.registry_skills ?? []).flatMap((s) => s.requires ?? []),
    ...(manifest?.packages ?? []).flatMap((p) => [...(p.requires ?? []), ...(p.skills ?? []).flatMap((s) => s.requires ?? [])]),
  ]);
  return (line) => {
    if (line.startsWith('door:')) {
      const d = (manifest?.doors ?? []).find((x) => x.key === line.slice(5));
      return { kind: 'door', floor: d ? ((d.floor as Setting | undefined) ?? 'on') : null };
    }
    if (line.startsWith('skill:')) return { kind: 'skill', floor: null };
    const own = manifest?.abilities.find((a) => a.key === line);
    if (own) return { kind: own.kind, floor: own.floor };
    const pk = packageAbilities.find((a) => a.key === line);
    if (pk) return { kind: pk.kind, floor: pk.floor };
    // v3 S6/S7: a declared `uses` line, or an external requirement of a build-pinned package/skill, is the
    // company's own borrowed on/off switch. A pin makes the line available; it does not turn the line on.
    const u = (manifest?.uses ?? []).find((x) => x.ability === line && x.ability !== 'tasks.open');
    if (u) return { kind: 'borrowed', floor: (u.floor as Setting | undefined) ?? null };
    if (!owned.has(line) && pinnedRequirements.has(line)) return { kind: 'borrowed', floor: null };
    return { kind: null, floor: null };
  };
}
