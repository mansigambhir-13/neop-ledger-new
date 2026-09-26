import type { Manifest, ProposalCard } from '@neop/contracts';
import type { PoolClient } from '@neop/pgkit';
import type { Doors } from './doors/index.ts';

/** Who is asking, as the gate or L3 saw it. */
export interface CallerCtx {
  company_id: string;
  /** `user:<id>`, `app:<key>`, `platform`, or `assistant:<job>` for gate calls. */
  caller: string;
  job_id: string | null;
  /** Database clock, never the app clock. */
  now: Date;
}

export interface ReadCtx extends CallerCtx {
  /** Company-scoped transaction (RLS set). */
  db: PoolClient;
}

export interface ExecCtx extends CallerCtx {
  /** The company's display name (from the platform), for documents that leave the company. */
  company_name: string;
  /** Stable across retries of the same proposal; pass to the door. */
  idempotencyKey: string;
  doors: Doors;
  /** Run a company-scoped transaction. */
  withDb<T>(fn: (db: PoolClient) => Promise<T>): Promise<T>;
}

export interface Measure {
  amount_minor?: number;
  currency?: string;
  recipients?: string[];
}

export interface ReadAbility {
  kind: 'read';
  run(args: any, ctx: ReadCtx): Promise<unknown>;
}

export interface WriteAbility {
  kind: 'write';
  /** Optional: compute money/recipients for rules when a JSON pointer is not enough (may read the books). */
  measure?(args: any, db?: PoolClient): Measure | Promise<Measure>;
  /**
   * Optional: fill in what the call will really do before it is proposed (e.g. the
   * customer's email as the recipient), so the card shows it, the fingerprint binds
   * it and the rules check it. Runs at the gate; the result is validated again.
   */
  normalize?(args: any, ctx: ReadCtx): Promise<any>;
  /** Optional: refuse content that could never be carried out, before anyone is asked. */
  check?(args: any): string | null;
  /**
   * Optional: the same, against the books (company-scoped, read-only use) —
   * e.g. "that period is locked", "that invoice is already paid". Runs at the
   * gate before a proposal is written, so nobody is asked to approve the impossible.
   */
  validate?(args: any, ctx: ReadCtx): Promise<string | null>;
  /** Do the thing once. Throw DoorError({definite:true}) when it certainly did not happen. */
  execute(args: any, ctx: ExecCtx): Promise<{ external_ref: string | null; detail?: unknown }>;
  /** Look for the effect. `found` must be true only when the effect is really there. */
  readBack(args: any, ctx: ExecCtx, externalRef: string | null): Promise<{ found: boolean; data: unknown }>;
}

export type AbilityHandler = ReadAbility | WriteAbility;

export interface PromptFillins {
  name: string;
  subject: string;
  looks_after: string;
  who_you_talk_to: string;
}

export interface SkillFile {
  key: string;
  requires: string[];
  body: string;
}

/** What an app team provides. Everything else ships with the template. */
export interface AppDefinition {
  manifest: Manifest;
  /** Directory holding 002_*.sql onward. */
  migrationsDir: string;
  abilities: Record<string, AbilityHandler>;
  prompt: PromptFillins;
  skills: SkillFile[];
}

export interface Timings {
  pollMs: number;
  expiryMs: number;
  reconcileMs: number;
  claimMs: number;
  heartbeatMs: number;
  sessionMaxMs: number;
  proposalTtlMs: number;
  maxAttempts: number;
}

export const DEFAULT_TIMINGS: Timings = {
  pollMs: 5_000,
  expiryMs: 30_000,
  reconcileMs: 30_000,
  claimMs: 120_000,
  heartbeatMs: 15_000,
  sessionMaxMs: 15 * 60_000,
  proposalTtlMs: 72 * 3_600_000,
  maxAttempts: 5,
};

export interface NeopConfig {
  /** App role connection (RLS enforced). */
  appDbUrl: string;
  /** Runner role connection (BYPASSRLS, standard tables only). */
  runnerDbUrl: string;
  platformUrl: string;
  /** Service secret the backend uses for platform-internal calls (switchboard, vault, grant tokens). */
  serviceSecret: string;
  /** HMAC secret(s) for job tokens; never leave the backend. Comma-separated or a list: first signs, all verify. */
  jobTokenSecret: string | string[];
  /** Where the assistant worker pool listens. */
  agentUrl: string;
  /** Public-to-the-agent URL of this backend's gate endpoint. */
  gateUrl?: string;
  poolSize: number;
  runnerId: string;
  appPoolSize?: number;
  runnerPoolSize?: number;
  /** Concurrent executions per backend (each holds one session for its advisory lock). */
  execLockPoolSize?: number;
  /** Where verified package artifacts are unpacked (read-only). */
  packageCacheDir?: string;
  /** How long a fetched gateway JWKS is trusted (default 60 s): bounds exposure after a key is retired. */
  jwksCacheMs?: number;
  /** Acked outbox events older than this are pruned (default 7 days). */
  outboxRetentionMs?: number;
  timings: Timings;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

export type { ProposalCard };
