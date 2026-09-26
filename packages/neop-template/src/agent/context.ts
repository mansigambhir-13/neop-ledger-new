// Builds THIS JOB from the book: ask, steps, facts, and the answer if waking.

import type { PoolClient } from '@neop/pgkit';
import type { Core } from '../core.ts';
import type { JobRow, ProposalRow, WaitRow } from '../data/book.ts';
import { MAX_TOOL_CALLS } from '../gate/gate.ts';
import type { EffectiveBoard } from '../gate/switchboard.ts';
import { buildTools } from '../gate/tools.ts';
import type { JobBundle } from './bundle.ts';

const RECENT_STEPS = 20;

export async function buildBundle(core: Core, c: PoolClient, job: JobRow, board: EffectiveBoard): Promise<JobBundle> {
  const steps = await core.book.listSteps(c, job.id);
  const recent = steps.slice(-RECENT_STEPS);
  const older = steps.slice(0, -RECENT_STEPS);
  const facts = await core.book.recentFacts(c, 20);
  const waits = (await core.book.openWaits(c, job.id)).filter((w: WaitRow) => w.status === 'ready');
  let wake: JobBundle['wake'] = null;
  const w = waits[0];
  if (w) {
    let proposal: NonNullable<JobBundle['wake']>['proposal'] = null;
    if (w.kind === 'proposal' && w.ref_id) {
      const p = (await core.book.getProposal(c, w.ref_id)) as ProposalRow;
      proposal = {
        id: p.id,
        ability_key: p.ability_key,
        args: p.args,
        card: p.card,
        fingerprint: p.fingerprint,
        status: p.status,
        decided_by: p.decided_by,
        feedback: p.feedback,
        proof: p.proof,
      };
    }
    wake = { kind: w.kind, outcome: w.outcome ?? 'unknown', proposal, answer: w.kind === 'proposal' ? null : (w.answer ?? null) };
  }
  const borrowed = await core.borrowed.list(job.company_id, board);
  const installed = await core.packages.forCompany(job.company_id).catch((e) => {
    core.log('registry unavailable; packages and borrowed skills skipped', { e: String(e) });
    return { abilities: [], skills: [] };
  });
  const tools = buildTools(core.manifest, board, borrowed, core.borrowed.a2aTargets(), installed.abilities.map((a) => a.meta));
  const on = new Set(tools.map((t) => t.key));
  // A skill loads only when every ability it requires is switched on — the app's own, a package's, or a borrowed skill.
  const skills = [
    ...core.app.skills.map((s) => ({ key: s.key, requires: s.requires, body: s.body })),
    ...installed.skills.map((s) => ({ key: s.key, requires: s.requires, body: `(From ${s.from}.)\n${s.body}` })),
  ]
    .filter((s) => s.requires.every((r) => on.has(r)))
    .map((s) => ({ key: s.key, body: s.body }));
  return {
    app: { key: core.key, name: core.manifest.name, subject: core.manifest.subject },
    company: board.company,
    job: {
      id: job.id,
      ask: job.ask,
      requester: job.requester,
      source: job.source,
      task_id: job.task_id,
      created_at: job.created_at.toISOString(),
      attempts: job.attempts,
    },
    steps: recent.map((s) => ({ seq: s.seq, kind: s.kind, summary: s.summary, at: s.created_at.toISOString() })),
    older_steps_summary: older.length
      ? `${older.length} earlier steps: ${older
          .filter((s) => s.kind !== 'ability')
          .map((s) => s.summary.slice(0, 80))
          .join(' · ')
          .slice(0, 1500)}`
      : null,
    facts: facts.map((f) => ({ subject: f.subject, value: f.value, source: f.source, observed_at: f.observed_at.toISOString() })),
    wake,
    tools,
    skills,
    prompt: core.app.prompt,
    limits: { max_tool_calls: MAX_TOOL_CALLS, session_ms: core.cfg.timings.sessionMaxMs, heartbeat_ms: core.cfg.timings.heartbeatMs },
  };
}
