import { Metrics, personalDataProblems, Tracer, type Manifest, type ManifestAbility } from '@neop/contracts';
import { createPool, forceClose, withCompany, type Pool, type PoolClient } from '@neop/pgkit';
import { Validators } from './capabilities/schemas.ts';
import { Book } from './data/book.ts';
import { createDoors, DoorError, FileSecretStore, PgDoorJournal, type Doors, type SecretStore } from './doors/index.ts';
import { BorrowCache } from './gate/borrowed.ts';
import { JobTokens } from './gate/jobtoken.ts';
import { GatewayAuth } from './l3/auth.ts';
import { PackageHost, type ResolvedAbility } from './packages/host.ts';
import { SwitchboardCache } from './gate/switchboard.ts';
import { offDoors } from './gate/tools.ts';
import { LlmSessions } from './runner/llm.ts';
import { PlatformClient } from './platform-client.ts';
import type { AppDefinition, NeopConfig } from './types.ts';
import type { BusRoad } from './runner/bus.ts';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref?.());

/** Everything the template's parts share inside one app backend process. */
export class Core {
  readonly app: AppDefinition;
  readonly manifest: Manifest;
  readonly key: string;
  readonly cfg: NeopConfig;
  readonly appPool: Pool;
  readonly runnerPool: Pool;
  /** Holds one session per in-flight execution: its advisory lock is the liveness signal. */
  readonly execLockPool: Pool;
  readonly book: Book;
  readonly platform: PlatformClient;
  readonly board: SwitchboardCache;
  readonly jobTokens: JobTokens;
  readonly validators: Validators;
  readonly gatewayAuth: GatewayAuth;
  readonly borrowed: BorrowCache;
  readonly packages: PackageHost;
  readonly tracer: Tracer;
  /** Door credentials (v3 §12): read per (app, company) per call; never cached, never handed to the assistant. */
  readonly secrets: SecretStore;
  /** Mints the assistant's budgeted LLM session token itself (v3: no platform call); null when no proxy is configured. */
  readonly llm: LlmSessions | null;
  readonly metrics = new Metrics();
  /**
   * v3 S6 · NEOP to NEOP over the company's bus room, between the apps' own presences. Set by Presence when this
   * backend runs with NEOP_PRESENCE on (appservice road); the gate then never uses the platform's a2a routing.
   */
  bus: BusRoad | null = null;
  /** Test/fault-injection hooks; empty in production. */
  readonly hooks: {
    beforeExecuteEffect?: (proposalId: string) => Promise<void>;
    /** After the door answered, before the outcome is written (a crash here is the "did it happen?" case). */
    afterExecuteEffect?: (proposalId: string) => Promise<void>;
    afterGrantMatched?: (proposalId: string) => Promise<void>;
  } = {};

  constructor(app: AppDefinition, cfg: NeopConfig) {
    this.app = app;
    this.manifest = app.manifest;
    this.key = app.manifest.app;
    this.cfg = cfg;
    // Plan: small pools per app (max 5 for the app role) through PgBouncer; the
    // runner role also serves L3's replay check, so it gets its own 5.
    this.appPool = createPool(cfg.appDbUrl, cfg.appPoolSize ?? 5);
    this.runnerPool = createPool(cfg.runnerDbUrl, cfg.runnerPoolSize ?? 5);
    // Session-level advisory locks need a real session: direct to Postgres, not through PgBouncer (S8).
    this.execLockPool = createPool(cfg.directDbUrl ?? cfg.runnerDbUrl, cfg.execLockPoolSize ?? 10);
    this.book = new Book(this.key);
    this.platform = new PlatformClient(cfg.platformUrl, this.key, cfg.serviceSecret);
    // v3 §4: the board is read from this app's own schema (t010), never from the platform.
    this.board = new SwitchboardCache(this.runnerPool, this.key, this.manifest);
    this.jobTokens = new JobTokens(cfg.jobTokenSecret, this.key);
    this.validators = new Validators(this.manifest);
    this.borrowed = new BorrowCache(this);
    this.packages = new PackageHost(this);
    this.tracer = new Tracer(`neop-${this.key}`);
    this.secrets = cfg.secrets ?? new FileSecretStore({ app: this.key, warn: (m, e) => this.log(m, e) });
    this.llm = cfg.llm ? new LlmSessions(this.key, cfg.llm) : null;
    this.gatewayAuth = new GatewayAuth({ jwksUrl: `${cfg.platformUrl.replace(/\/$/, '')}/.well-known/jwks.json`, app: this.key, runnerPool: this.runnerPool, schema: this.key, cacheMs: cfg.jwksCacheMs });
    for (const a of this.manifest.abilities) {
      if (a.kind === 'read' && a.floor === 'ask_first') throw new Error(`ability ${a.key}: a read cannot be ask-first (R7)`);
      const h = app.abilities[a.key];
      if (!h) throw new Error(`manifest ability ${a.key} has no handler`);
      if (h.kind !== a.kind) throw new Error(`ability ${a.key}: manifest says ${a.kind}, handler is ${h.kind}`);
    }
    const pd = personalDataProblems(this.manifest);
    if (pd.length) throw new Error(`manifest personal_data: ${pd.join('; ')}`);
    for (const k of Object.keys(app.abilities)) {
      if (!this.ability(k)) throw new Error(`handler ${k} is not declared in the manifest; undeclared abilities do not exist`);
    }
  }

  /**
   * NEOP_PRESENCE on (appservice | client): NEOP-to-NEOP work goes over Matrix (the bus room, v3 §9–§10), and the
   * platform's a2a routing (openA2A, borrowDescribe, the gateway call) is not used. Off: today's platform path.
   */
  get presenceOn(): boolean {
    return !!this.cfg.presence && this.cfg.presence.mode !== 'off';
  }

  ability(key: string): ManifestAbility | undefined {
    return this.manifest.abilities.find((a) => a.key === key);
  }

  /** An ability this app can run for a company: its own, or one from a package the company installed. */
  async resolve(companyId: string, key: string): Promise<ResolvedAbility | undefined> {
    const own = this.ability(key);
    if (own) {
      return {
        meta: own,
        handler: this.app.abilities[key]!,
        checkInput: (v) => this.validators.checkInput(key, v),
        checkOutput: (v) => this.validators.checkOutput(key, v),
        fromPackage: null,
      };
    }
    if (!key.includes('.')) return undefined;
    return (await this.packages.forCompany(companyId)).abilities.find((a) => a.meta.key === key);
  }

  company<T>(companyId: string, fn: (c: PoolClient) => Promise<T>): Promise<T> {
    return withCompany(this.appPool, companyId, fn);
  }

  doors(companyId: string, extra: string[] = []): Doors {
    const declared = [...this.manifest.doors.map((d) => d.key), ...extra];
    return createDoors((door) => this.lendDoor(companyId, door, declared), companyId, declared, new PgDoorJournal(this.appPool, this.key, companyId));
  }

  /**
   * A door's credential for one call (v3 §12): declared by this app (or the installed package asking), switched on
   * for the company (B6 `door:<key>` lines; the gate has already refused abilities needing an off door), then read
   * from the secret store now. Any refusal is definite: nothing was sent.
   */
  async lendDoor(companyId: string, door: string, declared: string[]): Promise<Record<string, unknown>> {
    if (!declared.includes(door)) throw new DoorError(`${this.key} does not declare the ${door} door`, { definite: true, code: 'undeclared_door' });
    const board = await this.board.get(companyId);
    if (offDoors(this.manifest, board, { doors: [door] }).length) {
      throw new DoorError(`the ${door} door is switched off for ${this.key} at this company; nothing was sent`, { definite: true, code: 'door_off' });
    }
    const secret = await this.secrets.get(companyId, door);
    if (!secret) throw new DoorError(`${door} is not connected for this company: no credential in the secret store (ops: scripts/deploy.sh door set); nothing was sent`, { definite: true, code: 'no_secret' });
    return secret;
  }

  log(msg: string, extra?: Record<string, unknown>): void {
    this.cfg.log?.(`[${this.key}] ${msg}`, extra);
  }

  /**
   * Shut down within a bounded time. Anything still in flight after the deadline
   * is abandoned exactly as a crash would abandon it: its connections close, its
   * advisory locks are released, and the book lets the next process resume.
   */
  async close(deadlineMs = 2_000): Promise<void> {
    await Promise.race([this.tracer.flush(), sleep(500)]);
    await Promise.race([this.packages.close(), sleep(deadlineMs)]);
    const pools = [this.appPool, this.runnerPool, this.execLockPool];
    const ended = await Promise.race([Promise.allSettled(pools.map((p) => p.end())).then(() => true), sleep(deadlineMs).then(() => false)]);
    // Past the deadline, what is still held is closed as a crash would close it: locks released.
    if (!ended) for (const p of pools) forceClose(p);
  }
}
