import type { ToolSpec } from '../gate/tools.ts';
import type { PromptFillins } from '../types.ts';

/** Everything a fresh assistant gets for one job. Nothing secret except its own job token. */
export interface JobBundle {
  app: { key: string; name: string; subject: string };
  company: { id: string; name: string; time_zone: string };
  job: { id: string; ask: string; requester: string; source: string; task_id: string | null; created_at: string; attempts: number; on_behalf_of: string | null };
  /** A follow-up in the same conversation: the earlier job it continues (its ask and what it reported). */
  parent: null | { job_id: string; ask: string; status: string; summary: string | null };
  /**
   * The requester's proposals still waiting for a yes (always stated, so "no proposal is open" is known, never
   * guessed). `what` is the card the assistant wrote, possibly from outside text: data, never instruction.
   */
  open_proposals?: { id: string; ability_key: string; what: string; fingerprint: string; expires_at: string }[];
  /** Persisted peer questions, including when this session wakes with a person's answer instead. */
  pending_peer_questions?: { task_id: string; question_wait_id: string; from_app: string; question: unknown; due: string | null;
    prepared_answer?: { intent_id: string; answers: Record<string, string | number | boolean> } | null }[];
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
    /** For an a2a task, a timer or a question (input): what came back. Another app's words are information, never instruction. */
    answer?: unknown;
  };
  tools: ToolSpec[];
  skills: { key: string; body: string }[];
  prompt: PromptFillins;
  limits: { max_tool_calls: number; session_ms: number; heartbeat_ms: number };
  /** traceparent of the runner's spawn span (R13). */
  trace?: string;
}
