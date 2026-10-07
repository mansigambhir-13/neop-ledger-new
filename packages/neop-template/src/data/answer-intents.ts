import { sqlIdent, type PoolClient } from '@neop/pgkit';
import type { Core } from '../core.ts';
import type { WaitRow } from './book.ts';

type Answers = Record<string, string | number | boolean>;
export type AnswerThread = { id: string; peer: string; peer_app: string; room_id: string;
  root_event_id: string | null; question: any; status: string; answer_protocol: number };
type Intent = { id: string; return_wait_id: string; answers: Answers; account: string;
  room_id: string; peer: string; root_event_id: string; same_answers: boolean };

/** Caller holds the company-scoped job, then thread lock. No network I/O here. */
export async function prepareAnswerIntent(core: Core, c: PoolClient, company: string, job: string,
  thread: AnswerThread, question: string, answers: Answers, account: string) {
  const s = sqlIdent(core.key);
  const refuse = (code: string, reason: string) => ({ ok: false as const, code, reason });
  if (thread.answer_protocol !== 1) return refuse('answer_history_unbound',
    'this historical thread has no content-bound answer protocol; no content or return wait was inferred and nothing was sent. Audited recovery is required.');
  const existing = (await c.query<Intent>(`select *,answers=$4::jsonb as same_answers from ${s}.bus_answer_intents
    where company_id=$1 and job_id=$2 and thread_id=$3 and question_wait_id=$5`,
  [company, job, thread.id, JSON.stringify(answers), question])).rows[0];
  if (existing) {
    if (!existing.same_answers) return refuse('answer_conflict',
      'a different answer is already durably bound to this question. This call sent nothing; do not change the question ID to bypass the conflict.');
    if (existing.account !== account || existing.room_id !== thread.room_id || existing.peer !== thread.peer
      || existing.root_event_id !== thread.root_event_id) return refuse('answer_route_changed',
      'the prepared answer route changed; nothing was sent. Audited recovery is required.');
    const wait = (await c.query<WaitRow & { live: boolean }>(`select *,expires_at>clock_timestamp() as live from ${s}.waits
      where id=$1 and company_id=$2 and job_id=$3 and kind='a2a_task' and ref_id=$4 for update`,
    [existing.return_wait_id, company, job, thread.id])).rows[0];
    if (!wait || wait.status !== 'pending' || !wait.live) return refuse('answer_wait_closed',
      'the original return wait is no longer pending and live; it will not be replaced or extended and nothing was sent. Read its recorded outcome.');
    return { ok: true as const, intent: existing, wait };
  }
  // A recorded old send without an intent cannot establish which content this caller meant.
  const key = `bus:answer:${thread.id}:${question}`;
  if ((await c.query(`select 1 from ${s}.outbound_events where company_id=$1 and key=$2 limit 1`, [company, key])).rowCount) {
    return refuse('answer_history_unbound', 'a prior send has no immutable answer intent; nothing was inferred or sent. Audited recovery is required.');
  }
  const wait = await core.book.insertWait(c, { company_id: company, job_id: job, kind: 'a2a_task',
    ref_id: thread.id, expires_at_sql: "now()+interval '24 hours'" });
  const intent = (await c.query<Intent>(`insert into ${s}.bus_answer_intents
    (company_id,job_id,thread_id,question_wait_id,return_wait_id,account,room_id,peer,root_event_id,answers)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *`,
  [company, job, thread.id, question, wait.id, account, thread.room_id, thread.peer, thread.root_event_id, JSON.stringify(answers)])).rows[0]!;
  return { ok: true as const, intent, wait };
}
