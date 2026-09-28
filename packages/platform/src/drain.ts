// v3 S2 DRAIN · the platform no longer drives approvals (no approvals worker, no execution token): a person's
// answer goes straight to <app>.answer_proposal() and the app's runner carries a yes out. What the old worker had
// in hand at deploy time is handed over here, once:
//   · RECORDED — a person answered on the desk, the app had not heard it yet → the same answer, the same
//     fingerprint, the same person, through answer_proposal() (as neos_desk, with that person's roles);
//   · RESOLVED — the app already holds the yes (APPROVED): the call is an idempotent repeat, and the runner, which
//     polls APPROVED rows, carries it out.
// Idempotent by construction: answer_proposal() returns `idempotent` for an answer it already holds, and
// neos.approvals is never written (frozen by 020). A card that closed meanwhile (expired, withdrawn, answered
// elsewhere) is reported, not forced.
import type { Pool } from '@neop/pgkit';
import { AppBoards } from './boards.ts';

export interface DrainReport {
  approval_id: string;
  app: string;
  company_id: string;
  proposal_id: string;
  decision: string;
  /** answered: the app now holds it · already: it did · refused/closed/not_found/no_schema/error: see detail */
  result: 'answered' | 'already' | 'refused' | 'closed' | 'not_found' | 'no_schema' | 'error';
  status: string | null;
  detail: string | null;
}

export async function drainApprovals(db: Pool, opts: { app?: string; log?: (m: string, extra?: Record<string, unknown>) => void } = {}): Promise<DrainReport[]> {
  const exists = (await db.query<{ ok: boolean }>("select to_regclass('neos.approvals') is not null as ok")).rows[0]?.ok;
  if (!exists) return [];
  const rows = (
    await db.query<{ id: string; app_key: string; company_id: string; proposal_id: string; decision: string; fingerprint_seen: string; feedback: string | null; decided_by: string; role: string | null }>(
      `select a.id, a.app_key, a.company_id, a.proposal_id, a.decision, a.fingerprint_seen, a.feedback, a.decided_by, u.role
         from neos.approvals a left join neos.users u on u.id = a.decided_by
        where a.status in ('RECORDED', 'RESOLVED') and a.decision is not null and a.decided_by is not null
          and ($1::text is null or a.app_key = $1)
        order by a.decided_at nulls last, a.created_at`,
      [opts.app ?? null],
    )
  ).rows;
  const boards = new AppBoards(db);
  const out: DrainReport[] = [];
  for (const a of rows) {
    const base = { approval_id: a.id, app: a.app_key, company_id: a.company_id, proposal_id: a.proposal_id, decision: a.decision };
    let rep: DrainReport;
    try {
      const r = await boards.answer(a.app_key, a.company_id, {
        proposal_id: a.proposal_id,
        fingerprint_seen: a.fingerprint_seen,
        decision: a.decision,
        by: `user:${a.decided_by}`,
        feedback: a.feedback,
        roles: a.role ? [a.role] : null,
      });
      rep = r.refused
        ? { ...base, result: 'refused', status: r.status, detail: r.refused }
        : { ...base, result: r.idempotent ? 'already' : 'answered', status: r.status, detail: null };
    } catch (e) {
      const err = e as { code?: string; message?: string };
      const m = /^([a-z_]+): /.exec(String(err.message ?? ''));
      const code = err.code === 'no_app_schema' ? 'no_schema' : m?.[1];
      const result: DrainReport['result'] = code === 'no_schema' ? 'no_schema' : code === 'not_found' ? 'not_found' : code === 'not_open' || code === 'expired' ? 'closed' : code === 'not_an_approver' || code === 'four_eyes' ? 'refused' : 'error';
      rep = { ...base, result, status: null, detail: String(err.message ?? e).slice(0, 300) };
    }
    out.push(rep);
    if (rep.result !== 'already') {
      await db
        .query(`insert into neos.audit (company_id, actor, app_key, action, outcome, detail) values ($1, 'migration:v3-s2', $2, 'approval.drained', $3, $4)`, [
          a.company_id,
          a.app_key,
          rep.result,
          JSON.stringify({ approval_id: a.id, proposal_id: a.proposal_id, decision: a.decision, status: rep.status, detail: rep.detail }),
        ])
        .catch(() => {});
    }
    opts.log?.(`drain ${a.app_key} ${a.proposal_id}: ${rep.result}`, rep.detail ? { detail: rep.detail } : undefined);
  }
  return out;
}
