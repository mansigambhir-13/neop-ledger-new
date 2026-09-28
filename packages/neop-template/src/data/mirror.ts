// The book's read-only mirrors of the platform (t009, WP v3 §11 "the nine standard tables"):
// <schema>.switchboard, <schema>.installs, <schema>.grants. The platform is the source of truth;
// the runner role writes what the backend last loaded from it, so a DBA, a desk view or the app
// role can read the lines in force with plain SQL. Nothing here is ever read back to decide a call.

import { assertIdent, type Pool } from '@neop/pgkit';
import type { SwitchboardDoc } from '../platform-client.ts';
import type { BoardObserver, EffectiveBoard } from '../gate/switchboard.ts';
import type { Manifest } from '@neop/contracts';

export class PlatformMirror implements BoardObserver {
  private readonly s: string;
  private readonly pool: Pool;
  private readonly manifest: Manifest;
  /** The board version last written per company, so a cache refresh with nothing new writes nothing. */
  private readonly written = new Map<string, number>();

  constructor(pool: Pool, schema: string, manifest: Manifest) {
    assertIdent(schema);
    this.s = schema;
    this.pool = pool;
    this.manifest = manifest;
  }

  async loaded(companyId: string, doc: SwitchboardDoc, board: EffectiveBoard): Promise<void> {
    if (this.written.get(companyId) === doc.version) return;
    const snap = board.snapshot();
    const lines = Object.entries(snap.settings).map(([line, setting]) => {
      const own = this.manifest.abilities.find((a) => a.key === line);
      return {
        line,
        kind: own ? own.kind : line.startsWith('skill:') ? 'skill' : null,
        floor: own ? own.floor : null,
        setting,
      };
    });
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      // One writer at a time per company: an older board never lands after a newer one.
      await client.query('select pg_advisory_xact_lock(hashtext($1))', [`${this.s}:mirror:${companyId}`]);
      const cur = (await client.query<{ v: number | null }>(`select max(version) as v from ${this.s}.switchboard where company_id = $1`, [companyId])).rows[0]?.v;
      if (cur === null || cur === undefined || cur <= doc.version) {
        await client.query(
          `insert into ${this.s}.switchboard (company_id, line, kind, floor, setting, caps, rules, version, updated_at)
           select $1, l->>'line', l->>'kind', l->>'floor', l->>'setting', $3::jsonb, $4::jsonb, $5, now()
             from jsonb_array_elements($2::jsonb) l
           on conflict (company_id, line) do update
             set kind = excluded.kind, floor = excluded.floor, setting = excluded.setting, caps = excluded.caps,
                 rules = excluded.rules, version = excluded.version, updated_at = now()`,
          [companyId, JSON.stringify(lines), JSON.stringify(snap.budget ?? {}), JSON.stringify(snap.rules), doc.version],
        );
        // A line the platform no longer lists (a package uninstalled) leaves the mirror.
        await client.query(`delete from ${this.s}.switchboard where company_id = $1 and not (line = any($2::text[]))`, [companyId, lines.map((l) => l.line)]);
      }
      // The platform only hands a board to an app installed for the company.
      await client.query(
        `insert into ${this.s}.installs as i (company_id, status, updated_at) values ($1, 'active', now())
         on conflict (company_id) do update set status = 'active', updated_at = now() where i.status <> 'active'`,
        [companyId],
      );
      await client.query('commit');
      this.written.set(companyId, doc.version);
    } catch (e) {
      await client.query('rollback').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }

  async notInstalled(companyId: string): Promise<void> {
    this.written.delete(companyId);
    await this.pool.query(
      `insert into ${this.s}.installs as i (company_id, status, updated_at) values ($1, 'not_installed', now())
       on conflict (company_id) do update set status = 'not_installed', updated_at = now() where i.status <> 'not_installed'`,
      [companyId],
    );
  }

  /** A grant lookup came back with a standing yes: the book notes that it exists and is active. */
  async grantSeen(companyId: string, grantId: string, abilityKey: string): Promise<void> {
    await this.pool.query(
      `insert into ${this.s}.grants (company_id, grant_id, ability_key, status, updated_at) values ($1, $2, $3, 'ACTIVE', now())
       on conflict (company_id, grant_id) do update set status = 'ACTIVE', ability_key = excluded.ability_key, updated_at = now()`,
      [companyId, grantId, abilityKey],
    );
  }
}
