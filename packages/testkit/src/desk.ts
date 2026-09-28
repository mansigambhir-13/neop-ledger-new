// DeskHarness · a desk on the database, for tests (v3 S3; WP v3 §1, §6, §11). The desk is `neos_desk`: it reads the
// union views the DBA made (neos.v_pending_approvals, neos.v_desk_cards, neos.v_activity, neos.v_open_questions,
// neos.v_questions), answers a card through <app>.answer_proposal() and a question through <app>.answer_wait(), writes
// <app>.switchboard / <app>.installs — and never touches an app's own tables. neos_desk is NOLOGIN, so the harness holds
// an admin (or pilot) connection and says `SET LOCAL ROLE neos_desk` for one transaction per call, exactly as the
// platform does (boards.ts); `neos.company_id` is set for the app schemas' row-level security.

import { createPool, type Pool, type PoolClient } from '@neop/pgkit';

export type DeskDecision = 'yes' | 'no' | 'change' | 'withdraw';

export class DeskHarness {
  private readonly pool: Pool;
  private readonly c: PoolClient;
  private chain: Promise<unknown> = Promise.resolve();

  private constructor(pool: Pool, c: PoolClient) {
    this.pool = pool;
    this.c = c;
  }

  /** Connect over an admin URL (a pilot's `adminUrl`); every call then runs as neos_desk. */
  static async connect(adminUrl: string): Promise<DeskHarness> {
    const pool = createPool(adminUrl, 1);
    return new DeskHarness(pool, await pool.connect());
  }

  /**
   * One transaction as neos_desk for one company. Committed when `fn` resolves (an answer is a write), rolled back
   * when it throws. Calls are serialised on the one connection.
   */
  as<T>(companyId: string, fn: (c: PoolClient) => Promise<T>, o: { rollback?: boolean } = {}): Promise<T> {
    const run = async () => {
      await this.c.query('begin');
      try {
        await this.c.query('set local role neos_desk');
        await this.c.query("select set_config('neos.company_id', $1, true)", [companyId]);
        const out = await fn(this.c);
        await this.c.query(o.rollback ? 'rollback' : 'commit');
        return out;
      } catch (e) {
        await this.c.query('rollback').catch(() => {});
        throw e;
      }
    };
    const next = this.chain.then(run, run);
    this.chain = next.catch(() => {});
    return next;
  }

  /** Any SQL as the desk (rolled back): for proving what the desk may and may not do. Rejects with the database error. */
  query<T = any>(companyId: string, sql: string, params: unknown[] = []): Promise<T[]> {
    return this.as(companyId, async (c) => (await c.query(sql, params)).rows as T[], { rollback: true });
  }

  /** The SQLSTATE a statement fails with as the desk ('ok' when it runs). */
  async errorOf(companyId: string, sql: string, params: unknown[] = []): Promise<string> {
    try {
      await this.query(companyId, sql, params);
      return 'ok';
    } catch (e) {
      return (e as { code?: string }).code ?? String(e);
    }
  }

  /** A person's answer on a card: <app>.answer_proposal(), as the platform's desk calls it. */
  async answerProposal(
    app: string,
    companyId: string,
    a: { proposal_id: string; fingerprint: string; decision: DeskDecision; by: string; feedback?: string | null; roles?: string[] | null },
  ): Promise<{ status: string; idempotent: boolean; job_id: string; refused?: string }> {
    assertKey(app);
    return this.as(companyId, async (c) =>
      (await c.query(`select ${app}.answer_proposal($1, $2, $3, $4, $5, $6) as r`, [a.proposal_id, a.fingerprint, a.decision, a.by, a.feedback ?? null, a.roles ?? null])).rows[0].r,
    );
  }

  /** An answer to a job's question: <app>.answer_wait() (template t013). */
  async answerWait(
    app: string,
    companyId: string,
    a: { wait_id: string; answers: unknown; by: string; via?: string | null },
  ): Promise<{ status: 'answered' | 'stale'; wait_id: string; job_id: string; idempotent?: boolean; reason?: string }> {
    assertKey(app);
    return this.as(companyId, async (c) => (await c.query(`select ${app}.answer_wait($1, $2::jsonb, $3, $4) as r`, [a.wait_id, JSON.stringify(a.answers ?? null), a.by, a.via ?? null])).rows[0].r);
  }

  /** The questions open for a person now (neos.v_open_questions), this company's only. */
  openQuestions(companyId: string): Promise<any[]> {
    return this.query(companyId, 'select * from neos.v_open_questions where company_id = $1 order by created_at', [companyId]);
  }

  /** Every question asked, in any status (neos.v_questions). */
  questions(companyId: string): Promise<any[]> {
    return this.query(companyId, 'select * from neos.v_questions where company_id = $1 order by created_at', [companyId]);
  }

  /** The cards waiting for a person (neos.v_pending_approvals). */
  pendingApprovals(companyId: string): Promise<any[]> {
    return this.query(companyId, 'select * from neos.v_pending_approvals where company_id = $1 order by created_at', [companyId]);
  }

  /** Every person-facing card, in the desk's statuses (neos.v_desk_cards). */
  cards(companyId: string): Promise<any[]> {
    return this.query(companyId, 'select * from neos.v_desk_cards where company_id = $1 order by created_at', [companyId]);
  }

  /** Every app's steps (neos.v_activity), optionally for one job, oldest first. */
  activity(companyId: string, jobId?: string): Promise<any[]> {
    return this.query(companyId, 'select * from neos.v_activity where company_id = $1 and ($2::uuid is null or job_id = $2) order by created_at, seq', [companyId, jobId ?? null]);
  }

  async close(): Promise<void> {
    await this.chain.catch(() => {});
    this.c.release();
    await this.pool.end();
  }
}

function assertKey(app: string): void {
  if (!/^[a-z][a-z0-9_]{0,40}$/.test(app)) throw new Error(`not an app key: ${app}`);
}
