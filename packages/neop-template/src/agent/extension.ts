// The pi extension: every call through the gate, every step into the book,
// settle → job. The harness gets no file, shell or fetch tools — only the
// gate-generated ones plus book.note, card.raise and job.finish.

import { Agent, type AgentTool } from '@mariozechner/pi-agent-core';
import type { Model } from '@mariozechner/pi-ai';
import { Tracer, type Span } from '@neop/contracts';
import { strictToolArguments } from './arguments.ts';
import type { JobBundle } from './bundle.ts';
import { jobMessage, systemPrompt, untrusted } from './prompt.ts';

export interface SessionModel {
  model: Model<any>;
  /** Per-app virtual key from the LLM proxy; never a raw provider key. */
  getApiKey?: (provider: string) => string | undefined;
}

export type EndReason = 'finished' | 'waiting' | 'no_report' | 'timeout' | 'cap' | 'session_lost' | `budget:${string}` | `transient:${string}` | `error:${string}`;

class SessionLost extends Error {}

const wrapUntrusted = (source: string, value: unknown) => untrusted(source, value);

/** A transcript larger than this keeps its first message and as many of the latest as fit. */
export const MAX_TRANSCRIPT_BYTES = 2_000_000;

/** Model inputs and outputs, tool calls and results, as this session saw them (WP §12). */
export function transcriptOf(system: string, messages: unknown[], reason: string): { reason: string; system_prompt: string; messages: unknown[]; bytes: number; truncated: boolean } {
  const size = (m: unknown) => Buffer.byteLength(JSON.stringify(m) ?? 'null');
  let total = messages.reduce<number>((s, m) => s + size(m), 0);
  if (total <= MAX_TRANSCRIPT_BYTES) return { reason, system_prompt: system, messages, bytes: total, truncated: false };
  const [first, ...rest] = messages;
  const kept: unknown[] = [];
  total = size(first);
  for (let i = rest.length - 1; i >= 0 && total + size(rest[i]) <= MAX_TRANSCRIPT_BYTES; i--) {
    total += size(rest[i]);
    kept.unshift(rest[i]);
  }
  return { reason, system_prompt: system, messages: [first, { role: 'note', text: `${rest.length - kept.length} messages left out: the transcript was over ${MAX_TRANSCRIPT_BYTES} bytes` }, ...kept], bytes: total, truncated: true };
}

/** A 402 from the NEOS LLM proxy: the job or day budget is used up. Final, never retried (S9). */
export function budgetStop(errorMessage: string): string | null {
  if (!/\b402\b|budget_exceeded|NEOS budget reached/i.test(errorMessage)) return null;
  const m = /(the model budget for this job \([^)]*\)|today's model budget for this app \([^)]*\))/i.exec(errorMessage);
  return m ? m[1]! : 'the model budget';
}

/** Test/ops hook: `kill` simulates a crashed session (no heartbeat, no session.end). */
export interface SessionControl {
  kill?: () => void;
  tracer?: Tracer;
}

export async function runSession(bundle: JobBundle, token: string, gateUrl: string, m: SessionModel, control: SessionControl = {}): Promise<EndReason> {
  const tracer = control.tracer ?? new Tracer(`neop-agent-${bundle.app.key}`);
  const session: Span = tracer.start('agent.session', bundle.trace ?? null, { 'neop.job': bundle.job.id, 'neop.app': bundle.app.key });
  const gate = async (path: string, body: unknown, parent: Span = session): Promise<any> => {
    const res = await fetch(`${gateUrl.replace(/\/$/, '')}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', traceparent: parent.header() },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    if (res.status === 409) throw new SessionLost('session lost its claim');
    const json = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`gate ${path} ${res.status}: ${json?.error?.message ?? 'error'}`);
    return json;
  };

  let finished = false;
  let waiting = false;
  let lost = false;
  let capped = false;
  let calls = 0;

  // The harness may coerce booleans/numbers/nulls. Validate the original model
  // arguments first so missing evidence cannot silently become false or zero.
  const tools: AgentTool<any>[] = bundle.tools.map((t) => ({
    name: t.name,
    label: t.title,
    description: t.description,
    parameters: t.input as any,
    executionMode: 'sequential',
    prepareArguments: strictToolArguments(t.input),
    execute: async (_id: string, params: unknown) => {
      let r: any;
      const toolSpan = tracer.start(`agent.tool ${t.key}`, session);
      try {
        r = await gate('/gate/call', { tool: t.key, args: params }, toolSpan);
        toolSpan.set('neop.decision', r?.status).end();
      } catch (e) {
        toolSpan.end('error', String(e));
        if (e instanceof SessionLost) {
          lost = true;
          agent.abort();
        }
        throw e;
      }
      switch (r.status) {
        case 'done':
          return { content: [{ type: 'text', text: wrapUntrusted(t.key, r.output) }], details: r };
        case 'done_by_grant':
          return {
            content: [{ type: 'text', text: `Carried out under a standing yes (proposal ${r.proposal_id}). Proof: ${wrapUntrusted(t.key, r.proof)}` }],
            details: r,
          };
        case 'proposed':
          waiting = true;
          return {
            content: [
              {
                type: 'text',
                text: `Proposal ${r.proposal_id} is written and waits for a person (fingerprint ${r.fingerprint}, expires ${r.expires_at}). The job is now WAITING. Stop now; you will be woken with the answer.`,
              },
            ],
            details: r,
            terminate: true,
          };
        case 'waiting_until':
          waiting = true;
          return {
            content: [{ type: 'text', text: `The job now waits until ${r.at}. Stop now; you will be woken then.` }],
            details: r,
            terminate: true,
          };
        case 'asked':
          waiting = true;
          return {
            content: [{ type: 'text', text: `Your question is written (${r.wait_id}) and waits for an answer until ${r.due_at}. The job is now WAITING. Stop now; you will be woken with the answer, or told if nobody answered in time.` }],
            details: r,
            terminate: true,
          };
        case 'waiting_on_app':
          waiting = true;
          return {
            content: [{ type: 'text', text: `Handed to ${r.app} as task ${r.task_id}. The job is now WAITING for its result. Stop now; you will be woken with it.` }],
            details: r,
            terminate: true,
          };
        case 'ok':
          if (t.key === 'job.finish') finished = true;
          return { content: [{ type: 'text', text: 'Recorded.' }], details: r, terminate: t.key === 'job.finish' };
        case 'refused':
        default:
          // Anything another party said (an owner app, the platform) arrives as data (item 10).
          throw new Error(`Refused by the gate (${r.code}): ${r.reason}${r.detail !== undefined ? `\n${wrapUntrusted(r.detail_source ?? 'outside', r.detail)}` : ''}`);
      }
    },
  }));

  const agent = new Agent({
    initialState: { systemPrompt: systemPrompt(bundle), model: m.model, tools, thinkingLevel: 'off' },
    getApiKey: m.getApiKey,
    toolExecution: 'sequential',
    beforeToolCall: async (ctx) => {
      if (waiting || finished) return { block: true, reason: 'The job is already waiting or finished; stop now.' };
      calls++;
      // Past the cap only job_finish still goes through, so the person always gets a report.
      const name = ctx.toolCall.name;
      if (calls > bundle.limits.max_tool_calls && !(name === 'job__finish' && calls <= bundle.limits.max_tool_calls + 3)) {
        capped = true;
        return { block: true, reason: `Tool call cap (${bundle.limits.max_tool_calls}) reached for this job. Call job_finish now: say what you did and what you could not do.` };
      }
      return undefined;
    },
  });

  // Spend is metered by the LLM proxy, never reported from here (S9, item 12).
  const hb = setInterval(() => {
    gate('/gate/heartbeat', {}).catch((e) => {
      if (e instanceof SessionLost) {
        lost = true;
        agent.abort();
      }
    });
  }, bundle.limits.heartbeat_ms);
  let killed = false;
  control.kill = () => {
    killed = true;
    clearInterval(hb);
    agent.abort();
  };
  let timedOut = false;
  // The session limit holds even when a provider call ignores the abort: past the
  // deadline (plus a moment for a clean abort) the session stops waiting on it.
  let deadlineHit: () => void = () => {};
  const deadline = new Promise<void>((res) => (deadlineHit = res));
  let grace: NodeJS.Timeout | undefined;
  const timer = setTimeout(() => {
    timedOut = true;
    agent.abort();
    grace = setTimeout(deadlineHit, 1_000);
  }, bundle.limits.session_ms);
  const bounded = (p: Promise<void>) => Promise.race([p, deadline]);

  let reason: EndReason = 'no_report';
  try {
    await bounded(agent.prompt(jobMessage(bundle)));
    if (!finished && !waiting && !lost && !timedOut && !agent.state.errorMessage) {
      await bounded(agent.prompt('You stopped without calling job_finish. Finish now: call job_finish with what you did, what changed and what you could not do.'));
    }
    const stop = agent.state.errorMessage ? budgetStop(agent.state.errorMessage) : null;
    if (finished) reason = 'finished';
    else if (waiting) reason = 'waiting';
    else if (stop) reason = `budget:${stop}`;
    else if (lost) reason = 'session_lost';
    else if (timedOut) reason = 'timeout';
    else if (capped && !agent.state.errorMessage) reason = 'cap';
    else if (agent.state.errorMessage) {
      // Credentials or a refused request will not fix themselves on retry.
      const permanent = /\b(401|403|404)\b|authentication|invalid[ _-]?(x-)?api[ _-]?key|permission|not[ _]found/i.test(agent.state.errorMessage);
      reason = `${permanent ? 'error' : 'transient'}:${agent.state.errorMessage.slice(0, 200)}` as EndReason;
    }
  } catch (e) {
    reason = lost ? 'session_lost' : `error:${(e as Error).message.slice(0, 200)}`;
  } finally {
    clearInterval(hb);
    clearTimeout(timer);
    clearTimeout(grace);
  }
  session.set('neop.end', reason).end(reason === 'finished' || reason === 'waiting' ? 'ok' : 'error');
  void tracer.flush();
  if (killed) return 'error:killed';
  // The raw transcript goes to the book for audit (WP §12), however the session ended. It is never shown to a model again.
  await gate('/gate/transcript', transcriptOf(agent.state.systemPrompt, agent.state.messages as unknown[], reason)).catch(() => {});
  if (reason !== 'session_lost') await gate('/gate/session.end', { reason }).catch(() => {});
  return reason;
}
