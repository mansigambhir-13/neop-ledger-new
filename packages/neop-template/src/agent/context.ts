import {sqlIdent} from '@neop/pgkit';
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
  // What the requester has waiting for a yes: stated in every job, so an answer about "that proposal" is never guessed.
  const open = (
    await c.query<{ id: string; ability_key: string; card: any; fingerprint: string; expires_at: Date }>(
      `select p.id, p.ability_key, p.card, p.fingerprint, p.expires_at from ${sqlIdent(core.key)}.proposals p join ${sqlIdent(core.key)}.jobs j on j.id = p.job_id
        where p.company_id = $2 and j.company_id = $2 and j.requester = $1 and p.status = 'PROPOSED' and p.expires_at > now() order by p.created_at desc limit 10`,
      [job.requester, job.company_id],
    )
  ).rows.map((p) => ({ id: p.id, ability_key: p.ability_key, what: String(p.card?.what ?? '').slice(0, 300), fingerprint: p.fingerprint, expires_at: p.expires_at.toISOString() }));
  const borrowed = await core.borrowed.list(job.company_id, board);
  // Do not depend on an earlier assistant remembering the peer's question while it asks its person.
  // This is scoped context, not send authority; a2a.answer rechecks the ID under job/thread locks.
  const pendingPeerQuestions = (await c.query<NonNullable<JobBundle['pending_peer_questions']>[number]>(
    `select t.id::text as task_id, t.question->>'wait_id' as question_wait_id, t.peer_app as from_app,
       t.question->'question' as question, t.question->>'due' as due,
       case when i.id is not null then jsonb_build_object('intent_id',i.id,'answers',i.answers) end as prepared_answer
     from ${sqlIdent(core.key)}.bus_threads t left join ${sqlIdent(core.key)}.bus_answer_intents i
       on i.company_id=t.company_id and i.job_id=t.job_id and i.thread_id=t.id and i.question_wait_id=t.question->>'wait_id'
     where t.company_id=$1 and t.job_id=$2 and t.direction='out' and t.kind='task' and t.status='open'
       and t.root_event_id is not null and jsonb_typeof(t.question->'wait_id')='string'
       and char_length(t.question->>'wait_id') between 1 and 200
     order by t.updated_at desc,t.id limit 10`, [job.company_id, job.id])).rows;
  const installed = await core.packages.forCompany(job.company_id).catch((e) => {
    core.log('installed packages unreadable; packages and pinned skills skipped', { e: String(e) });
    return { abilities: [], skills: [], skipped: [] as { key: string; version: string; reason: string }[] };
  });
  // v3 S7: a package that fails verification (a hand-edited file, a changed registry row) is not offered — and the
  // job's book says so, once per job, so the desk's activity shows why a line is missing.
  if (installed.skipped.length) {
    const said = new Set(recent.filter((s) => s.kind === 'note' && s.summary.startsWith('Not loaded: ')).map((s) => s.summary));
    for (const s of installed.skipped) {
      const summary = `Not loaded: ${s.key}@${s.version} — ${s.reason}`.slice(0, 500);
      if (said.has(summary)) continue;
      await core.book.addStep(c, { company_id: job.company_id, job_id: job.id, kind: 'note', summary, mirror: false });
    }
  }
  const tools = buildTools(core.manifest, board, borrowed, core.borrowed.a2aTargets(), installed.abilities.map((a) => a.meta), { bus: true });
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
    open_proposals: open,
    pending_peer_questions: pendingPeerQuestions,
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
