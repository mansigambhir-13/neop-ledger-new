import type { Manifest, ProposalCard } from '@neop/contracts';
import type { PoolClient } from '@neop/pgkit';
import type { Doors } from './doors/index.ts';

/** Who is asking, as the gate (or the bus room, for a borrowed read) saw it. */
export interface CallerCtx {
  company_id: string;
  /** `user:<id>`, `app:<mxid>` (another NEOP over the bus room), or `assistant:<job>` for gate calls. */
  caller: string;
  job_id: string | null;
  /** Database clock, never the app clock. */
  now: Date;
  /** The company's time zone (IANA), when the caller knows it: "today" for the company is measured in it. */
  time_zone?: string;
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
  /** A standing grant cannot substitute for this write's current human approval. */
  requiresHumanApproval?: boolean;
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
  validate?(args: any, ctx: ReadCtx): Promise<string | Refusal | null>;
  /** Do the thing once. Throw DoorError({definite:true}) when it certainly did not happen. */
  execute(args: any, ctx: ExecCtx): Promise<{ external_ref: string | null; detail?: unknown }>;
  /** Look for the effect. `found` must be true only when the effect is really there. */
  readBack(args: any, ctx: ExecCtx, externalRef: string | null): Promise<{ found: boolean; data: unknown }>;
}

/**
 * A refusal with the closest real names (a party, an account, a document) the books hold for a name that
 * matched nothing. The gate returns the candidates to the assistant as data, and tells it to ask the person
 * which one they meant (job.ask) — never to act on a guess.
 */
export interface Refusal {
  reason: string;
  did_you_mean?: string[];
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
  /** Screens as data (blocks/*.json), registered with the platform; never JavaScript. */
  blocks?: Record<string, unknown>;
  /**
   * Packages and registry skills installed at build time (v3 §10, `neos install`): `root` is the app's folder, holding
   * packages.lock.json and src/packages/nep-<name>/. Absent: the app has none.
   */
  packages?: { root: string };
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
  /** Wait before retrying after a transient model/network failure, by attempt (last value repeats). */
  retryBackoffMs?: number[];
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
  // ~4 minutes in all: a short provider or network outage is ridden out instead of failing every job in flight.
  retryBackoffMs: [5_000, 15_000, 30_000, 60_000, 120_000],
};

export interface NeopConfig {
  /** App role connection (RLS enforced). */
  appDbUrl: string;
  /** Runner role connection (BYPASSRLS, standard tables only). */
  runnerDbUrl: string;
  /** A direct (session) connection for LISTEN and the execution lock — never through a transaction pooler (S8). Defaults to runnerDbUrl. */
  directDbUrl?: string;
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
  /**
   * The registry keys installed packages and pinned skills must be signed under (a JWKS). Unset: the key each lock
   * entry recorded at install is used alone. Production pins the registry's JWKS (NEOP_REGISTRY_JWKS_FILE).
   */
  registryJwks?: { keys: Record<string, unknown>[] };
  /** Outbox events every presence mirror has passed are pruned once older than this (default 7 days). */
  outboxRetentionMs?: number;
  /**
   * v3 S9 · the backend's own files listener (kept source documents, downloaded with a signed short-lived link; plus
   * /live, /ready and /metrics for ops). `publicUrl` is where a person's browser reaches it (NEOP_FILES_PUBLIC_URL);
   * unset, links carry the path only. The platform never fetches anything from here.
   */
  files?: { publicUrl?: string };
  /** Where attached files are kept (WP §11): a local volume or an S3-compatible bucket. Default: NEOP_DOCUMENTS_* env, else a local directory. */
  documents?: import('./doors/documents/store.ts').DocumentStoreConfig;
  /** Door credentials (v3 §12). Default: a FileSecretStore at NEOP_DOOR_SECRETS_DIR (else /run/secrets/doors), read per call. */
  secrets?: import('./doors/secrets.ts').SecretStore;
  /** The LLM proxy and this app's session-signing key (v3: the runner mints session tokens). Unset: sessions get no token. */
  llm?: import('./runner/llm.ts').LlmConfig;
  /**
   * The NEOP on Matrix itself (v3 S4; required since S9 — it is the only way anything reaches the app): the appservice
   * road (NEOP_PRESENCE=appservice) or the client road (NEOP_PRESENCE=client). presenceConfigFromEnv reads it.
   */
  presence: import('./presence/index.ts').PresenceConfig;
  timings: Timings;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

export type { ProposalCard };
