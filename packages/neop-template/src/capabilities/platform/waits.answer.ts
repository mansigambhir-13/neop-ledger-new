import type { Core } from '../../core.ts';
import { ExecError } from '../execute.ts';

/**
 * Where an answer came from. A person answering for themselves (the desk, their own
 * conversation, their own DM) gives the person's words; a bridge, the reasoning agent or
 * another app only relays — what they send is information for the assistant, never an order.
 */
export const PERSON_VIAS = ['desk', 'conversation', 'chat'] as const;
export const RELAY_VIAS = ['bridge', 'reasoning_agent', 'app'] as const;
export type AnswerVia = (typeof PERSON_VIAS)[number] | (typeof RELAY_VIAS)[number];

export interface AnswerInput {
  wait_id: string;
  answers: Record<string, unknown>;
  /** user:<id> (a person) · bridge:<matrix id> · agent:<name> · app:<key | matrix id> */
  answered_by: string;
  via?: AnswerVia;
}

/**
 * An answer to a question the job asked (WP §8 `answer`), through `<schema>.answer_wait()` (template t013, v3 S3) —
 * the one place the rules live: who may answer, the wait is open, the answers cover the required fields, idempotent
 * on the wait. The NEOS v1 `answer` capability and the runner's Matrix inbound (runner/inbound.ts) come here; the
 * desk calls the same function as neos_desk. The L3 route `waits.answer` is gone (nothing called it after the platform
 * moved to the function). Errors as before: 404 not_found, 409 stale, 400 bad_answer / bad_request, 403 not_their_wait.
 */
export async function answerWait(core: Core, companyId: string, input: AnswerInput): Promise<{ status: 'answered'; wait_id: string; job_id: string; idempotent: boolean }> {
  let r: { status: 'answered' | 'stale'; wait_id: string; job_id: string; idempotent?: boolean; reason?: string };
  try {
    r = await core.company(companyId, async (c) =>
      (await c.query(`select ${core.key}.answer_wait($1, $2::jsonb, $3, $4) as r`, [input.wait_id, JSON.stringify(input.answers ?? null), input.answered_by, input.via ?? null])).rows[0].r,
    );
  } catch (e) {
    throw answerWaitError(e);
  }
  if (r.status === 'stale') throw new ExecError(409, 'stale', r.reason ?? 'the question is no longer open');
  return { status: 'answered', wait_id: r.wait_id, job_id: r.job_id, idempotent: !!r.idempotent };
}

/** answer_wait's refusals (`<code>: …`) as the HTTP-shaped errors the callers have always mapped. */
export function answerWaitError(e: unknown): unknown {
  const m = /^(not_found|bad_answer|bad_request|not_their_wait): (.*)$/s.exec(String((e as Error)?.message ?? ''));
  if (!m) {
    // A malformed id never reaches the row: the same 400 the route used to give.
    if ((e as { code?: string })?.code === '22P02') return new ExecError(400, 'bad_request', 'wait_id (uuid) required');
    return e;
  }
  const [, code, msg] = m as unknown as [string, string, string];
  const status = code === 'not_found' ? 404 : code === 'not_their_wait' ? 403 : 400;
  return new ExecError(status, code, msg);
}
