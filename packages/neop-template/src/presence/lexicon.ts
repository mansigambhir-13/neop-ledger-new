// PRESENCE · what a plain message says (v3 S4). Deterministic, no model: ported unchanged from the platform's
// Matrix roads (packages/platform/src/bridge/client-sync.ts, bridge.ts, matrix.ts) so NeuralChat #143's plain
// text keeps exactly today's meaning when the NEOP speaks for itself. Everything a message says is data: it
// becomes a job's ask (fenced by the app), an answer (information for the job), or a decision parsed from a
// fixed vocabulary. A bridge's go-ahead is recognised only to refuse it clearly — nothing approves on a
// person's behalf.

import type { Decision } from '@neop/contracts';

/** A person's reply to a card: "yes", "no", "change: …", "withdraw" — anything else is unclear. */
export function parseDecision(text: string): { decision: Decision; feedback?: string } | null {
  const t = text.trim();
  const change = /^change\s*[:\-–]\s*([\s\S]+)$/i.exec(t);
  if (change) return { decision: 'change', feedback: change[1]!.trim() };
  if (/^(yes|y|approve|approved)\b/i.test(t)) return { decision: 'yes' };
  if (/^(no|n|reject|decline)\b/i.test(t)) return { decision: 'no' };
  if (/^withdraw\b/i.test(t)) return { decision: 'withdraw' };
  return null;
}

/** Strip the quoted fallback Matrix clients put in front of a reply. */
export function stripReplyFallback(body: string): string {
  const lines = body.split('\n');
  let i = 0;
  while (i < lines.length && lines[i]!.startsWith('> ')) i++;
  if (i > 0 && lines[i] === '') i++;
  return lines.slice(i).join('\n');
}

export const CONSENT = /\b(go ahead|proceed|do it|carry (it )?out|confirm(ed)?)\b/i;
/** A clear "no" to a card: never mistaken for a yes (a decline wins over any consent word next to it). */
export const DECLINE = /\b(no|decline[sd]?|reject(ed)?|drop(ped)?|cancel(led|ed)?|discard(ed)?|withdraw|don'?t (do|send|go ahead|proceed)|do not (do|send|go ahead|proceed))\b/i;
/** A decline that names no card (a plain message) binds only when it says so outright — a bare "no" is not enough —
 *  and never when it only postpones ("don't go ahead yet", "wait", "later"): the card then stays open. */
export const POSTPONE = /\b(yet|wait|later|hold( on| off)?|for now|not now|until|tomorrow|next week)\b/i;
export const PLAIN_DECLINE = /\b(declined?|reject(ed)?|(drop|cancel|discard|withdraw)\s+(it|that|this|the)\b|don'?t (go ahead|proceed|do it)|do not (go ahead|proceed|do it)|(user|they|she|he|i) (said|says|say) no)\b/i;

/**
 * THE GO-AHEAD LEXICON (kept for recognising a go-ahead, only to refuse it):
 *   a clear go-ahead = at least one `affirmative` AND no `hold` anywhere in the text.
 *   affirmative + hold = ambiguous → NOT a go-ahead (it is then an ordinary request).
 */
export const GO_AHEAD_LEXICON = {
  affirmative: /\b(yes|yeah|yep|go ahead|proceed|approved?|confirm(ed)?|do it|ok|okay|sure|carry on|apply it)\b/i,
  hold: /\b(no|not|don'?t|do not|cancel(led|ed|s)?|stop|hold|wait|later|never|decline[sd]?|reject(ed|s)?|drop(ped|s)?)\b|n't\b|^\s*change\b|\bchange\s*[:\-–]|\b(change[sd]?|changing) (it|this|that|the|to|them|its|his|her|their|my|our|a|an)\b|\b(with|some|a few|few|more|any|make) changes?\b|\bplease change\b/i,
} as const;

/** 'go_ahead' (a clear affirmative, no hold), 'ambiguous' (both), or 'none' (no affirmative). */
export function goAheadOf(text: string): 'go_ahead' | 'ambiguous' | 'none' {
  const t = String(text ?? '').replace(/[‘’ʼ]/g, "'");
  if (!GO_AHEAD_LEXICON.affirmative.test(t)) return 'none';
  return GO_AHEAD_LEXICON.hold.test(t) ? 'ambiguous' : 'go_ahead';
}

/** Is this a bridge consenting (which is never a yes)? The same test the platform's client road applied. */
export function isConsent(text: string): boolean {
  return parseDecision(text)?.decision === 'yes' || (CONSENT.test(text) && goAheadOf(text) !== 'ambiguous');
}

/** Every number in a text, as a value ("₹500" = "₹500.00" = 500; "5,00,000" = 500000; "₹5k" is 5). */
export function numbersIn(text: string): number[] {
  const t = String(text ?? '').replace(/\b(rs|inr)\.?\s*/gi, ' ');
  const out: number[] = [];
  for (const m of t.matchAll(/(?<![\d.,])(\d{1,3}(?:,\d{2,3})+(?![\d])|\d+)(?:\.(\d+))?/g)) {
    const v = Number(`${m[1]!.replace(/,/g, '')}${m[2] ? `.${m[2]}` : ''}`);
    if (Number.isFinite(v)) out.push(v);
  }
  return out;
}

/** The numbers of a go-ahead that are NOT on the card (empty: every number it names is the card's). */
export function numbersNotOn(goAhead: string, cardText: string): number[] {
  const on = numbersIn(cardText);
  return numbersIn(goAhead).filter((v) => !on.some((w) => Math.abs(w - v) < 1e-9));
}

/** What a card says, for the number check: its words, its exact args, and every *_minor amount in major units. */
export function cardTextOf(card: any, args: any): string {
  const parts = [card?.what, card?.why, card?.changes, card?.if_no_answer].map((x) => String(x ?? ''));
  parts.push(JSON.stringify(args ?? {}));
  const walk = (v: any) => {
    if (!v || typeof v !== 'object') return;
    for (const [k, x] of Object.entries(v)) {
      if (/_minor$/.test(k) && typeof x === 'number' && Number.isFinite(x)) parts.push((x / 100).toFixed(2));
      else walk(x);
    }
  };
  walk(args);
  return parts.join('\n');
}

/**
 * Answers read from a plain (non-reply) message: the whole text for a one-field question (not when the text is
 * itself a question, ending in "?") — for a PERSON in their own DM only (`wholeText`); else `key: value`
 * (or `label: value`) pairs, one per line or `;`-separated. Null when the text names none of the question's
 * fields — it is then a new request, not an answer. `missing` lists required fields it left out.
 * A bridge (NeuralChat keeps ONE DM for all its tasks) answers plainly only with explicit pairs.
 */
export function plainAnswers(
  q: { fields: { key: string; label: string; required?: boolean }[] },
  text: string,
  o: { wholeText?: boolean } = {},
): { answers: Record<string, string>; missing: { key: string; label: string }[] } | null {
  const body = text.trim();
  if (!body || !q.fields.length) return null;
  if (q.fields.length === 1 && o.wholeText !== false) {
    const f = q.fields[0]!;
    const m = /^\s*([^:=]{1,200}?)\s*[:=]\s*(.+)$/s.exec(body);
    if (m && [f.key.toLowerCase(), f.label.toLowerCase()].includes(m[1]!.trim().toLowerCase())) return { answers: { [f.key]: m[2]!.trim() }, missing: [] };
    if (body.endsWith('?')) return null;
    return { answers: { [f.key]: body }, missing: [] };
  }
  const answers: Record<string, string> = {};
  for (const part of body.split(/\r?\n|;/)) {
    const m = /^\s*([^:=]{1,200}?)\s*[:=]\s*(.*)$/.exec(part);
    if (!m) continue;
    const name = m[1]!.trim().toLowerCase();
    const f = q.fields.find((x) => x.key.toLowerCase() === name || x.label.toLowerCase() === name);
    if (f && m[2]!.trim()) answers[f.key] = m[2]!.trim();
  }
  if (!Object.keys(answers).length) return null;
  return { answers, missing: q.fields.filter((f) => f.required !== false && !(f.key in answers)).map((f) => ({ key: f.key, label: f.label })) };
}
