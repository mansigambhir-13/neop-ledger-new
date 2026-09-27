import type { ProposalCreatedPayload, QuestionField, TaskResult } from '@neop/contracts';


/** Plain-text room renderings of typed events. The room is a mirror; the book is the truth. */
export const roomText = {
  card(appName: string, p: ProposalCreatedPayload): string {
    return [
      `${appName} asks first — ${p.card.what}`,
      `Why: ${p.card.why}`,
      `What changes: ${p.card.changes}`,
      `If nobody answers: ${p.card.if_no_answer}`,
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
    if (r.changed.length) lines.push(`What changed: ${r.changed.join('; ')}`);
    if (r.could_not.length) lines.push(`Could not: ${r.could_not.join('; ')}`);
    if (r.sources.length) lines.push(`Sources: ${r.sources.join('; ')}`);
    return lines.join('\n');
  },
};
