import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { REPO, verifyAgentContext } from '../packaging/agent-context.ts';
import { verifyBackendContext } from '../packaging/backend-context.ts';
import type { FleetApp } from '../runtime/apps.ts';
import { eventually } from './process.ts';
import { hostFixtureUrl, imageMap, loopbackPort, verifySourceBinding, type ImageRef } from './image-policy.ts';

const exec = promisify(execFile);
const NODE = 'node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6';
const POSTGRES = 'postgres:17.6-bookworm@sha256:f3bd19c606e442c3d7bdfa8002e03fe260a1023351e0ea4598032022b68dd6e3';
const HARDENING = ['--read-only', '--user', '1000:1000', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--pids-limit', '128', '--memory', '768m', '--tmpfs', '/tmp:rw,noexec,nosuid,size=128m,uid=1000,gid=1000'];
const hash = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
const check = (value: unknown, message: string) => { if (!value) throw new Error(message); };

// Fixture-only raw TCP forwarding, with fixed endpoints. No request routing,
// business logic, credentials, tokens or permission decisions live here.
const RELAY = `import net from 'node:net';
function relay(port,host,target,tport){net.createServer(input=>{const output=net.connect({host:target,port:tport});input.on('error',()=>output.destroy());output.on('error',()=>input.destroy());input.on('close',()=>output.destroy());output.on('close',()=>input.destroy());input.pipe(output);output.pipe(input);}).listen(port,host);}
relay(8080,'model','host.docker.internal',Number(process.env.MODEL_PORT));
relay(8081,'control-relay','assistant',4103);
`;

/** Opt-in Docker runtime for the SAME persisted-job assertions as host processes. */
export class PackagedJobs {
  readonly prefix = `neop-fleet8-${randomBytes(4).toString('hex')}`;
  private containers = new Set<string>();
  private networks = new Set<string>();
  private images!: { agent: Map<FleetApp, ImageRef>; backend: Map<FleetApp, ImageRef> };
  private groups = new Map<FleetApp, { network: string; relay: string; workerPort: number }>();
  private databasePort = 0;
  private serial = 0;
  private closed = false;
  private validated = false;
  private mutations = new Set<Promise<void>>();
  private report: any = { production_ready: false, mode: 'packaged-internal-draft-jobs', fixtures: [], boundaries: [], starts: [], stops: [], cleanup: [] };
  private output: string;
  private agentContext: string;
  private backendContext: string;
  constructor(output: string, agentContext: string, backendContext: string) {
    this.output = output; this.agentContext = agentContext; this.backendContext = backendContext;
  }

  private async docker(args: string[], timeout = 30_000): Promise<string> {
    try { return (await exec('docker', args, { encoding: 'utf8', timeout, maxBuffer: 4_000_000 })).stdout.trim(); }
    catch (error) { throw new Error(`fixture docker ${args[0]} failed (${(error as { code?: unknown }).code ?? 'unknown'}); arguments withheld`); }
  }
  private async inspect(name: string) { return JSON.parse(await this.docker(['inspect', name]))[0]; }
  private async inNode(name: string, code: string) { return this.docker(['exec', name, 'node', '--input-type=module', '-e', code]); }
  private async create(name: string, image: string, network: string, extra: string[], command: string[] = []) {
    check(!this.closed, 'fixture is closed');
    const action = (async () => { await this.docker(['create', '--pull=never', '--name', name, '--label', `neop.fleet.packaged-jobs=${this.prefix}`, '--network', network, ...extra, image, ...command]); this.containers.add(name); })();
    this.mutations.add(action);
    try { await action; } finally { this.mutations.delete(action); }
    check(!this.closed, 'fixture is closed');
  }
  private async remove(name: string) {
    check(this.containers.has(name) && (await this.inspect(name)).Config.Labels?.['neop.fleet.packaged-jobs'] === this.prefix, 'refusing unowned container cleanup');
    await this.docker(['rm', '-f', name]); this.containers.delete(name); this.report.cleanup.push({ container: name, removed: true });
  }
  private async removeNetwork(name: string) {
    check(this.networks.has(name) && JSON.parse(await this.docker(['network', 'inspect', name]))[0].Labels?.['neop.fleet.packaged-jobs'] === this.prefix, 'refusing unowned network cleanup');
    await this.docker(['network', 'rm', name]); this.networks.delete(name);
  }
  private async network(name: string, internal: boolean) {
    check(!this.closed, 'fixture is closed');
    const action = (async () => { await this.docker(['network', 'create', ...(internal ? ['--internal'] : []), '--label', `neop.fleet.packaged-jobs=${this.prefix}`, name]); this.networks.add(name); })();
    this.mutations.add(action);
    try { await action; } finally { this.mutations.delete(action); }
    check(!this.closed, 'fixture is closed');
  }

  /** Read-only artifact/image validation happens before timed lifecycle hooks. */
  async preflight(): Promise<void> {
    try { await lstat(this.output); throw new Error('fixture report must be a new file'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    this.report.at = new Date().toISOString(); this.report.prefix = this.prefix;
    console.log('packaged preflight: verify assistant/backend artifact inventories');
    const [agent, backend] = await Promise.all([verifyAgentContext(this.agentContext), verifyBackendContext(this.backendContext)]);
    const a = JSON.parse(await readFile(path.join(REPO, 'docs/evidence/FLEET-V3-CHECKPOINT-5-IMAGES.json'), 'utf8'));
    const b = JSON.parse(await readFile(path.join(REPO, 'docs/evidence/FLEET-V3-CHECKPOINT-7-BACKENDS.json'), 'utf8'));
    check(hash(await readFile(path.join(this.agentContext, 'artifact.json'))) === a.artifactManifestSha256, 'assistant context does not match tested images');
    check(hash(await readFile(path.join(this.backendContext, 'artifact.json'))) === b.artifactSha256, 'backend context does not match tested images');
    const lock = hash(await readFile(path.join(REPO, 'pnpm-lock.yaml')));
    check(agent.lockfileSha256 === lock && backend.lockfileSha256 === lock, 'image lockfile is stale');
    console.log('packaged preflight: inventories match; bind current source and exact image IDs');
    this.report.sourceBindings = { agent: await verifySourceBinding(agent.inventory, 'agent', REPO), backend: await verifySourceBinding(backend.inventory, 'backend', REPO) };
    this.images = { agent: imageMap(a.images), backend: imageMap(b.images) };
    for (const side of ['agent', 'backend'] as const) for (const image of this.images[side].values()) {
      const actual = JSON.parse(await this.docker(['image', 'inspect', image.id]))[0];
      check(actual.Id === image.id && actual.Os === image.os && actual.Architecture === image.architecture && actual.Config.User === 'node' && actual.Config.Env.includes(`NEOP_APP=${image.app}`), 'cached image identity mismatch');
    }
    this.report.images = { agent: a.images, backend: b.images };
    this.validated = true;
    console.log('packaged preflight: complete; no fixture resources created yet');
  }

  async setup(): Promise<{ adminUrl: string; drop: () => Promise<void> }> {
    check(this.validated && !this.closed, 'packaged fixture requires completed preflight');
    await this.network(this.prefix, false);
    const database = `${this.prefix}-database`;
    await this.create(database, POSTGRES, this.prefix, ['--network-alias', 'database', '-p', '127.0.0.1::5432', '--tmpfs', '/var/lib/postgresql/data:rw,nosuid,size=512m', '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', '-e', 'POSTGRES_DB=fleet']);
    await this.docker(['start', database]);
    await eventually(async () => { try { await this.docker(['exec', database, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres', '-d', 'fleet']); return true; } catch { return false; } }, 'packaged fixture database TCP readiness');
    const binding = (await this.inspect(database)).NetworkSettings.Ports['5432/tcp'][0];
    check(binding.HostIp === '127.0.0.1', 'fixture database must be loopback-only'); this.databasePort = Number(binding.HostPort);
    return { adminUrl: `postgres://postgres@127.0.0.1:${this.databasePort}/fleet`, drop: () => this.close() };
  }

  async prepareApp(app: FleetApp, proxyUrl: string) {
    const modelPort = loopbackPort(proxyUrl), network = `${this.prefix}-${app}`, relay = `${network}-relay`;
    await this.network(network, true);
    await this.create(relay, NODE, this.prefix, [...HARDENING, '--network-alias', 'control-relay', '-p', '127.0.0.1::8081', '-e', `MODEL_PORT=${modelPort}`], ['node', '--input-type=module', '-e', RELAY]);
    await this.docker(['network', 'connect', '--alias', 'model', network, relay]); await this.docker(['start', relay]);
    const binding = (await this.inspect(relay)).NetworkSettings.Ports['8081/tcp'][0];
    check(binding.HostIp === '127.0.0.1', 'fixture assistant control must be loopback-only');
    this.groups.set(app, { network, relay, workerPort: Number(binding.HostPort) });
    this.report.fixtures.push({ app, modelPort, assistantControlPort: Number(binding.HostPort), assistantNetworkInternal: true });
  }

  launch(app: FleetApp, side: 'agent' | 'backend', original: NodeJS.ProcessEnv) {
    const group = this.groups.get(app); if (!group) throw new Error('packaged app fixtures not prepared');
    const name = `${group.network}-${side}-${++this.serial}`;
    let id = '', cachedLogs = '', started: Promise<any> | undefined, ended: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    const start = async () => {
      const config: NodeJS.ProcessEnv = side === 'agent'
        ? { NEOP_ALLOWED_GATE: 'http://backend-agent:4102', HOST: '0.0.0.0', PORT: '4103', POOL_SIZE: '2' }
        : { ...original, NEOP_GATE_URL: 'http://backend-agent:4102', NEOP_AGENT_URL: 'http://assistant:4103', NEOP_LLM_PROXY_URL: 'http://model:8080/llm', NEOP_MATRIX_HOMESERVER_URL: hostFixtureUrl(original.NEOP_MATRIX_HOMESERVER_URL!), FILES_HOST: 'backend-control', GATE_HOST: 'backend-agent', APPSERVICE_HOST: 'backend-control', FILES_PORT: '4101', GATE_PORT: '4102', APPSERVICE_PORT: '4104' };
      if (side === 'backend') for (const key of ['NEOP_APP_DB_URL', 'NEOP_RUNNER_DB_URL']) {
        const url = new URL(original[key]!);
        check(url.hostname === '127.0.0.1' && Number(url.port) === this.databasePort && url.pathname === '/fleet', 'only the owned disposable database may be used');
        url.hostname = 'database'; url.port = '5432'; config[key] = url.toString();
      }
      const settings = Object.entries(config).filter((pair): pair is [string, string] => pair[1] !== undefined).flatMap(([key, value]) => ['-e', `${key}=${value}`]);
      await this.create(name, this.images[side].get(app)!.id, side === 'agent' ? group.network : this.prefix, [...HARDENING, '--network-alias', side === 'agent' ? 'assistant' : 'backend-control', ...(side === 'backend' ? ['-p', '127.0.0.1::4101', '-p', '127.0.0.1::4104'] : []), ...settings]);
      if (side === 'backend') await this.docker(['network', 'connect', '--alias', 'backend-agent', group.network, name]);
      await this.docker(['start', name]); id = (await this.inspect(name)).Id;
      await eventually(async () => {
        const view = await this.inspect(name); check(view.State.Running, `${app} packaged ${side} exited before ready`);
        const r = await exec('docker', ['logs', name], { encoding: 'utf8', timeout: 10_000, maxBuffer: 500_000 }); cachedLogs = r.stdout + r.stderr;
        return r.stdout.split('\n').some(line => { try { const event = JSON.parse(line); return event.event === 'started' && event.app === app; } catch { return false; } });
      }, `${app} packaged ${side} startup`);
      const spec = await this.inspect(name); check(spec.HostConfig.ReadonlyRootfs && spec.HostConfig.CapDrop.includes('ALL') && !spec.HostConfig.Privileged, 'runtime hardening missing');
      if (side === 'agent') check(Object.keys(spec.NetworkSettings.Networks).length === 1 && spec.Mounts.every((m: any) => m.Type === 'tmpfs' && m.Destination === '/tmp'), 'assistant has extra network or secret mount');
      this.report.starts.push({ app, side, containerId: id, imageId: spec.Image });
      return side === 'agent' ? { port: group.workerPort } : { gate: 0, files: Number(spec.NetworkSettings.Ports['4101/tcp'][0].HostPort), appservice: Number(spec.NetworkSettings.Ports['4104/tcp'][0].HostPort) };
    };
    const stop = async (signal: NodeJS.Signals = 'SIGTERM') => {
      if (ended) return ended;
      check(this.containers.has(name), 'cannot stop an unowned runtime');
      if (signal === 'SIGKILL') await this.docker(['kill', '--signal', 'KILL', name]); else await this.docker(['stop', '--time', '12', name]);
      const view = await this.inspect(name); check(!view.State.Running, 'container did not stop');
      if (signal === 'SIGKILL') check(view.State.ExitCode === 137 && !view.State.OOMKilled, 'backend crash was not deliberate SIGKILL');
      const r = await exec('docker', ['logs', name], { encoding: 'utf8', timeout: 10_000, maxBuffer: 500_000 }); cachedLogs = r.stdout + r.stderr;
      ended = signal === 'SIGKILL' ? { code: null, signal: 'SIGKILL' } : { code: view.State.ExitCode, signal: null };
      this.report.stops.push({ app, side, containerId: id, ...ended }); await this.remove(name); return ended;
    };
    return { get pid() { return id; }, started: () => started ??= start(), stop, logs: () => cachedLogs };
  }

  async boundary(app: FleetApp) {
    const group = this.groups.get(app)!;
    const worker = [...this.containers].find(name => name.startsWith(`${group.network}-agent-`))!;
    const dbIp = (await this.inspect(`${this.prefix}-database`)).NetworkSettings.Networks[this.prefix].IPAddress;
    const ports = [['backend-agent',4102],['model',8080],['backend-agent',4101],['backend-agent',4104],[dbIp,5432],['host.docker.internal',this.databasePort]];
    const reachability = JSON.parse(await this.inNode(worker, `import net from 'node:net';const probe=([host,port])=>new Promise(resolve=>{const s=net.connect({host,port});let done=false;const end=v=>{if(done)return;done=true;s.destroy();resolve(v);};s.on('connect',()=>end(true));s.on('error',()=>end(false));s.setTimeout(1200,()=>end(false));});console.log(JSON.stringify(await Promise.all(${JSON.stringify(ports)}.map(probe))));`));
    check(JSON.stringify(reachability) === '[true,true,false,false,false,false]', 'assistant fixture network boundary differs from expected');
    this.report.boundaries.push({ app, gate: true, model: true, files: false, matrixIngress: false, database: false, hostDatabasePort: false });
  }

  launcher(app: FleetApp) { return { launch: this.launch.bind(this), close: async () => {
    const group = this.groups.get(app); if (!group) return;
    for (const name of [...this.containers].filter(name => name.startsWith(`${group.network}-`)).reverse()) await this.remove(name);
    await this.removeNetwork(group.network); this.groups.delete(app);
  } }; }

  async close() {
    if (this.closed) return;
    this.closed = true;
    await Promise.allSettled([...this.mutations]);
    for (const name of [...this.containers].reverse()) { try { await this.remove(name); } catch { this.report.cleanup.push({ container: name, removed: false }); } }
    for (const name of [...this.networks].reverse()) { try { await this.removeNetwork(name); } catch { this.report.cleanup.push({ network: name, removed: false }); } }
    this.report.remainingContainers = [...this.containers]; this.report.remainingNetworks = [...this.networks];
    this.report.cleanupSucceeded = this.containers.size === 0 && this.networks.size === 0;
    // Test outcomes live in Vitest's separate JSON; clean fixtures never imply passing tests.
    await writeFile(this.output, JSON.stringify(this.report, null, 2) + '\n', { flag: 'wx' });
    check(this.report.cleanupSucceeded, 'packaged fixture cleanup incomplete');
  }
}
