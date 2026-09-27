// Builds THIS JOB from the book: ask, steps, facts, and the answer if waking.

import type { PoolClient } from '@neop/pgkit';
import type { Core } from '../core.ts';
import type { JobRow, ProposalRow, StepRow, WaitRow } from '../data/book.ts';
import { MAX_TOOL_CALLS } from '../gate/gate.ts';
import type { EffectiveBoard } from '../gate/switchboard.ts';
import { buildTools } from '../gate/tools.ts';
import type { JobBundle } from './bundle.ts';

const RECENT_STEPS = 20;

const SUMMARY_MAX = 1_800;

/**
 * The rolling summary (plan: the last 20 steps in full, "older ones as a rolling
 * summary written to steps"). Steps past the window are folded into a `summary`
 * step once; later sessions extend it with only what rolled out since.
 */
async function rollingSummary(core: Core, c: PoolClient, job: JobRow, all: StepRow[], persist: boolean): Promise<{ recent: StepRow[]; summary: string | null }> {
  const steps = all.filter((s) => s.kind !== 'summary');
  const last = all.filter((s) => s.kind === 'summary').at(-1);
  const recent = steps.slice(-RECENT_STEPS);
  const older = steps.slice(0, -RECENT_STEPS);
  const prev = (last?.output_ref ?? {}) as { through_seq?: number; covers?: number; body?: string };
  const fresh = older.filter((s) => s.seq > (prev.through_seq ?? 0));
  if (!fresh.length) return { recent, summary: last?.summary ?? null };
  let body = [prev.body, ...fresh.filter((s) => s.kind !== 'ability').map((s) => `[${s.kind}] ${s.summary.slice(0, 80)}`)].filter(Boolean).join(' · ');
  if (body.length > SUMMARY_MAX) body = `${body.slice(0, 400)} … ${body.slice(body.length - (SUMMARY_MAX - 403))}`;
  const covers = (prev.covers ?? 0) + fresh.length;
  const summary = `${covers} earlier steps (through step ${fresh.at(-1)!.seq}): ${body || 'reads only'}`;
  if (!persist) return { recent, summary };
  await core.book.addStep(c, {
    company_id: job.company_id,
    job_id: job.id,
    kind: 'summary',
    summary,
    output_ref: { through_seq: fresh.at(-1)!.seq, covers, body },
    mirror: false,
  });
  return { recent, summary };
}

/** `persist: false` builds without writing the summary step (the runner's look before it writes why it woke). */
export async function buildBundle(core: Core, c: PoolClient, job: JobRow, board: EffectiveBoard, opts: { persist?: boolean } = {}): Promise<JobBundle> {
  const { recent, summary } = await rollingSummary(core, c, job, await core.book.listSteps(c, job.id), opts.persist !== false);
  const facts = await core.book.factsFor(c, job, 20);
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
  // A follow-up continues from the job before it: its ask and what it reported (its facts come first in `facts`).
  const pj = job.parent_job_id ? await core.book.getJob(c, job.parent_job_id) : null;
  const parent: JobBundle['parent'] = pj ? { job_id: pj.id, ask: pj.ask, status: pj.status, summary: typeof (pj.result as any)?.summary === 'string' ? (pj.result as any).summary : null } : null;
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
    // A skill line is on or off (WP §10); off means it is not loaded even when its tools are on.
    .filter((s) => board.hostSetting(`skill:${s.key}`) !== 'off')
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
      on_behalf_of: job.on_behalf_of ?? null,
    },
    parent,
    steps: recent.map((s) => ({ seq: s.seq, kind: s.kind, summary: s.summary, at: s.created_at.toISOString() })),
    older_steps_summary: summary,
    facts: facts.map((f) => ({ subject: f.subject, value: f.value, source: f.source, observed_at: f.observed_at.toISOString() })),
    wake,
    tools,
    skills,
    prompt: core.app.prompt,
    limits: { max_tool_calls: MAX_TOOL_CALLS, session_ms: core.cfg.timings.sessionMaxMs, heartbeat_ms: core.cfg.timings.heartbeatMs },
  };
}
