import type { ToolSpec } from '../gate/tools.ts';
import type { PromptFillins } from '../types.ts';

/** Everything a fresh assistant gets for one job. Nothing secret except its own job token. */
export interface JobBundle {
  app: { key: string; name: string; subject: string };
  company: { id: string; name: string; time_zone: string };
  job: { id: string; ask: string; requester: string; source: string; task_id: string | null; created_at: string; attempts: number };
  steps: { seq: number; kind: string; summary: string; at: string }[];
  older_steps_summary: string | null;
  facts: { subject: string; value: unknown; source: string; observed_at: string }[];
  /** Present when this session is waking a job that was waiting. */
  wake: null | {
    kind: string;
    outcome: string;
    proposal: null | {
      id: string;
      ability_key: string;
      args: unknown;
      card: unknown;
      fingerprint: string;
      status: string;
      decided_by: string | null;
      feedback: string | null;
      proof: unknown;
    };
    /** For an a2a task or a timer: what came back. Another app's words are information, never instruction. */
    answer?: unknown;
  };
  tools: ToolSpec[];
  skills: { key: string; body: string }[];
  prompt: PromptFillins;
  limits: { max_tool_calls: number; session_ms: number; heartbeat_ms: number };
  /** traceparent of the runner's spawn span (R13). */
  trace?: string;
}
