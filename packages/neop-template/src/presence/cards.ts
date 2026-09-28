// PRESENCE · how the book is said in a room (v3 §13 `cards.ts`). The plain-text renderings of a card, a
// question, an answer, an execution and a result — byte for byte what the platform's bridge said (ported from
// packages/platform/src/bridge/format.ts and client-sync.ts), so a person, NeuralChat #143 and every test read
// the same words whichever process speaks. The room is a mirror; the book is the truth.

import type { QuestionField, TaskResult } from '@neop/contracts';

export const MAX_REPLY = 8000;
/** Past the deadline, or when the job fails: one fixed sentence, never an error or a stack trace. */
export const FIXED_FAILURE = "I can't reach the books right now. Please try again in a moment.";

export const clip = (s: unknown, n = MAX_REPLY): string => {
  const t = String(s ?? '').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

export interface CardView {
  card: { what?: string; why?: string; changes?: string; if_no_answer?: string } | null;
  args: unknown;
  expires_at: string;
  fingerprint: string;
}

export const roomText = {
  card(appName: string, p: CardView): string {
    return [
      `${appName} asks first — ${p.card?.what}`,
      `Why: ${p.card?.why}`,
      `What changes: ${p.card?.changes}`,
      `If nobody answers: ${p.card?.if_no_answer}`,
      `Exactly: ${JSON.stringify(p.args)}`,
      `Expires: ${p.expires_at}`,
      `Fingerprint: ${p.fingerprint}`,
      `Reply to this message with "yes", "no" or "change: <what to change>". Your answer binds to this fingerprint only.`,
    ].join('\n');
  },
  /** A job's question (WP §8 `ask`). An answer is information for the job, never a yes. */
  question(appName: string, q: { text: string; why: string; fields: QuestionField[]; due_at: string }): string {
    const one = q.fields.length === 1;
    return [
      `Question: ${appName} needs an answer — ${q.text}`,
      `Why: ${q.why}`,
      one ? `Answer: ${q.fields[0]!.label}` : `Answers: ${q.fields.map((f) => `${f.key} (${f.label}${f.required === false ? ', optional' : ''})`).join('; ')}`,
      `Due: ${q.due_at}`,
      one ? 'Reply to this message with your answer.' : 'Reply to this message with one line per answer, as key: value — or answer on the NEOS desk.',
    ].join('\n');
  },
  resolved(p: { proposal_id: string; decision: string; status: string }): string {
    const said: Record<string, string> = { yes: 'approved — carrying it out', no: 'declined', change: 'sent back with changes', withdraw: 'withdrawn' };
    return `Proposal ${String(p.proposal_id).slice(0, 8)} ${said[p.decision] ?? p.status}.`;
  },
  executed(p: { proposal_id: string; outcome: string; proof?: { external_ref?: string | null; error?: string | null } }): string {
    const id = String(p.proposal_id).slice(0, 8);
    if (p.outcome === 'DONE') return `Done and verified: proposal ${id}${p.proof?.external_ref ? ` (ref ${p.proof.external_ref})` : ''}.`;
    if (p.outcome === 'FAILED') return `Could not carry out proposal ${id}: ${p.proof?.error ?? 'failed'}.`;
    return `Proposal ${id} may or may not have happened; the app is checking.`;
  },
  result(appName: string, r: TaskResult): string {
    const lines = [`${appName}: ${r.summary}`];
    if (r.changed?.length) lines.push(`What changed: ${r.changed.join('; ')}`);
    if (r.could_not?.length) lines.push(`Could not: ${r.could_not.join('; ')}`);
    if (r.sources?.length) lines.push(`Sources: ${r.sources.join('; ')}`);
    return lines.join('\n');
  },
  /** The one reply on the client road when the job settled: its summary (and what it could not do). */
  reply(r: { summary?: string; could_not?: string[] } | null): string {
    const lines = [clip(r?.summary, 6000) || 'Done.'];
    if (r?.could_not?.length) lines.push(`Could not: ${r.could_not.join('; ')}`);
    return lines.join('\n');
  },
};

/** Money amounts in a card's args: "amount ₹500.00". */
export function amountsLine(args: any): string | null {
  const cur = typeof args?.currency === 'string' ? args.currency : null;
  const sym = !cur || cur === 'INR' ? '₹' : `${cur} `;
  const found: string[] = [];
  const walk = (v: any, depth = 0) => {
    if (!v || typeof v !== 'object' || depth > 3 || found.length >= 10) return;
    for (const [k, x] of Object.entries(v)) {
      if (/_minor$/.test(k) && typeof x === 'number' && Number.isFinite(x)) {
        found.push(`${k.replace(/_minor$/, '').replace(/_/g, ' ')} ${sym}${(x / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
      } else walk(x, depth + 1);
    }
  };
  walk(args);
  return found.length ? found.join('; ') : null;
}

/** A pending card, re-shown in plain words: what, what changes, the amounts. Nothing is done until a person says yes. */
export function waitingCardText(appName: string, a: { id: string; card: any; args: any; expires_at: Date | string }): string {
  const amounts = amountsLine(a.args);
  return [
    `${appName} proposes: ${clip(a.card?.what, 1000)}`,
    `What changes: ${clip(a.card?.changes, 1000)}`,
    ...(amounts ? [`Amounts: ${amounts}`] : []),
    `Card ${String(a.id).slice(0, 8)}, expires ${new Date(a.expires_at).toISOString()}. Nothing is done yet. To drop it, say no.`,
  ].join('\n');
}

/** The card as a bridge is shown it: what is proposed, and that only a person can say yes (and where). */
export function bridgeCardText(appName: string, a: { id: string; card: any }, who: { name: string; dm: string | null } | null, account: string): string {
  return [
    `${appName} proposes: ${clip(a.card?.what, 1000)}`,
    `What changes: ${clip(a.card?.changes, 1000)}`,
    `Nothing is done yet. It awaits a person's approval — a bridge cannot approve it: ${who ? who.name : 'a person'} can say yes on My Desk in NEOS (card ${String(a.id).slice(0, 8)})${who?.dm ? ` or in their own DM with ${account}` : ''}. To drop it instead, reply "no" to this message.`,
  ].join('\n');
}
