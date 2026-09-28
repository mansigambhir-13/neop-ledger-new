// PRESENCE · the typed events, thread helpers and dedupe (v3 §8, §13 `events.ts`).
// The seven types, their JSON Schemas, the sender-class rule and the thread helpers are the shared contract in
// @neop/contracts (matrix-events.ts) — the same code the platform's roads used; this file adds what the NEOP
// keeps for itself: the once-per-event_id record (<schema>.inbound_events, t012) and deterministic transaction
// ids, so Matrix's redelivery never opens a job twice and a resend is never a second message.

import { createHash } from 'node:crypto';
import type { Pool } from '@neop/pgkit';

export {
  isTypedEventType,
  maySend,
  shortType,
  threadRelation,
  threadRootOf,
  typedContent,
  validateTypedBody,
  TYPED_EVENT_TYPES,
  TYPED_SENDERS,
  type SenderClass,
  type TypedBodies,
  type TypedEventType,
} from '@neop/contracts';

const SAFE = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._~-';
const safe = (s: string) => [...String(s)].map((c) => (SAFE.includes(c) ? c : '_')).join('');

/** The txnId of the one reply to an event: derived from its id, so a resend is the same transaction. */
export const replyTxnId = (eventId: string): string => `reply-${safe(eventId)}`.slice(0, 255);

/** A txn id for anything this app says (the outbound key): the same key is the same transaction, never twice. */
export const keyTxnId = (key: string): string => {
  const s = safe(key);
  return s.length <= 200 ? s : `${s.slice(0, 150)}-${createHash('sha256').update(key).digest('hex').slice(0, 40)}`;
};

/** The job's task id for a Matrix event: derived from the event id, so a redelivery finds the same job (openJobAtomic). */
export function taskIdForEvent(eventId: string): string {
  const h = createHash('sha256').update(`matrix-event:${eventId}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export interface InboundClaim {
  event_id: string;
  company_id: string;
  account: string;
  room_id: string;
  road: 'appservice' | 'client';
  sender: string;
  sender_class: 'person' | 'agent' | 'neop' | null;
  person_id: string | null;
  type: string;
}

/**
 * Record an inbound event once (the dedupe on event_id, v3 §8 "Matrix will redeliver"). True the first time;
 * false for a redelivery — the caller then does nothing at all (no job, no reply).
 */
export async function claimInbound(pool: Pool, schema: string, ev: InboundClaim, outcome = 'received'): Promise<boolean> {
  const r = await pool.query(
    `insert into ${schema}.inbound_events (event_id, company_id, account, room_id, road, sender, sender_class, person_id, type, outcome)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) on conflict (event_id) do nothing`,
    [ev.event_id, ev.company_id, ev.account, ev.room_id, ev.road, ev.sender, ev.sender_class, ev.person_id, ev.type, outcome],
  );
  return (r.rowCount ?? 0) > 0;
}
