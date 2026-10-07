import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createPool, roleUrl, sqlIdent } from '@neop/pgkit';
import { generateLlmSigningKey, migrateApp } from '@neop/template';
import { FLEET_APPS } from '../runtime/apps.ts';
import { loadFleetApp } from '../runtime/load.ts';
import { REPO } from './agent-context.ts';
import { verifyBackendContext } from './backend-context.ts';

const [context, output] = process.argv.slice(2);
if (!context || !output || process.argv.length !== 4) throw new Error('usage: check-backend-images.ts CONTEXT NEW_REPORT_JSON');
try { await lstat(path.resolve(output)); throw new Error('report must be new; preserve prior evidence'); }
catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
const artifact = await verifyBackendContext(context);
const prefix = `neop-fleet7-${randomBytes(4).toString('hex')}`, label = `neop.fleet.backend-probe=${prefix}`;
const containers = new Set<string>(), networks = new Set<string>();
const nodeBase = 'node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6';
const report: any = { at: new Date().toISOString(), prefix, artifactSha256: createHash('sha256').update(await readFile(path.join(context, 'artifact.json'))).digest('hex'), deno: artifact.deno, images: [], results: [], cleanup: [], production_ready: false };
const docker = (args: string[], timeout = 60_000) => {
  try { return execFileSync('docker', args, { encoding: 'utf8', timeout, maxBuffer: 8_000_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
  catch (error) { throw new Error(`docker ${args[0]} failed (${(error as { status?: number }).status ?? 'timeout'}); command arguments withheld`); }
};
const inspect = (name: string) => JSON.parse(docker(['inspect', name]))[0];
const assert = (value: unknown, message: string) => { if (!value) throw new Error(message); };
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const inNode = (name: string, code: string) => docker(['exec', name, 'node', '--input-type=module', '-e', code]);
const logs = (name: string) => { const r = spawnSync('docker', ['logs', name], { encoding: 'utf8', timeout: 10_000 }); assert(r.status === 0, 'cannot read owned container logs'); return r.stdout + r.stderr; };
function start(name: string, image: string, extra: string[], command: string[] = [], network = prefix) {
  docker(['create', '--pull=never', '--name', name, '--label', label, '--network', network, ...extra, image, ...command]); containers.add(name);
  docker(['start', name]);
}
function remove(name: string) {
  assert(containers.has(name) && inspect(name).Config.Labels?.['neop.fleet.backend-probe'] === prefix, 'refusing unowned cleanup');
  docker(['rm', '-f', name]); containers.delete(name); report.cleanup.push({ container: name, removed: true });
}
async function healthy(name: string, port: number) {
  for (let i = 0; i < 100; i++) {
    assert(inspect(name).State.Running, `owned container exited before readiness: ${name}`);
    try { if (inNode(name, `const r=await fetch('http://127.0.0.1:${port}/ready');if(!r.ok)process.exit(1);console.log('ok');`) === 'ok') return; } catch {}
    await pause(100);
  }
  throw new Error(`owned container readiness timeout: ${name}`);
}
const hardening = ['--read-only', '--user', '1000:1000', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--pids-limit', '128', '--memory', '768m', '--tmpfs', '/tmp:rw,noexec,nosuid,size=128m,uid=1000,gid=1000'];
let admin: ReturnType<typeof createPool> | undefined;
try {
  docker(['network', 'create', '--internal', '--label', label, prefix]); networks.add(prefix);
  // Docker does not publish host ports for an internal-only network. Only the
  // disposable DB joins a separate control network; its host port is loopback-only.
  const control = `${prefix}-control`;
  docker(['network', 'create', '--label', label, control]); networks.add(control);
  // No host volume or production database. PostgreSQL data disappears with this owned container.
  const database = `${prefix}-database`;
  const postgres = 'postgres:17.6-bookworm@sha256:f3bd19c606e442c3d7bdfa8002e03fe260a1023351e0ea4598032022b68dd6e3';
  report.databaseImage = postgres;
  start(database, postgres, ['-p', '127.0.0.1::5432', '--tmpfs', '/var/lib/postgresql/data:rw,nosuid,size=512m', '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', '-e', 'POSTGRES_DB=fleet'], [], control);
  docker(['network', 'connect', '--alias', 'database', prefix, database]);
  // The image briefly starts a Unix-socket-only server during initdb. Wait for
  // final TCP readiness, not that temporary server which is about to stop.
  for (let i = 0; ; i++) { try { docker(['exec', database, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres', '-d', 'fleet']); break; } catch { if(i >= 100) throw new Error('disposable PostgreSQL not ready'); await pause(100); } }
  const port = inspect(database).NetworkSettings.Ports['5432/tcp'][0].HostPort;
  const adminUrl = `postgres://postgres@127.0.0.1:${port}/fleet`; admin = createPool(adminUrl, 2);
  for (const app of FLEET_APPS) await migrateApp(adminUrl, await loadFleetApp(app));
  const fixture = `${prefix}-fixture`;
  start(fixture, nodeBase, [...hardening, '--network-alias', 'fixture'], ['node', '-e', "require('http').createServer((_q,r)=>{r.writeHead(200,{'content-type':'application/json'});r.end('{}')}).listen(8080,'0.0.0.0')"]);
  const key = await generateLlmSigningKey('backend-image-fixture');
  for (const app of FLEET_APPS) {
    console.log(`${app}: build and rehearse backend image`);
    const image = `${prefix}-${app}-backend:local`;
    docker(['build', '--quiet', '--pull=false', '--network=none', '--platform', artifact.architecture === 'arm64' ? 'linux/arm64' : 'linux/amd64', '--label', label, '--build-arg', `NEOP_APP=${app}`, '-t', image, path.resolve(context)], 180_000);
    const data = JSON.parse(docker(['image', 'inspect', image]))[0];
    assert(data.Config.User === 'node' && data.Os === 'linux' && data.Architecture === (artifact.architecture === 'x64' ? 'amd64' : 'arm64'), 'backend image identity/platform mismatch');
    report.images.push({ app, tag: image, id: data.Id, os: data.Os, architecture: data.Architecture });
    const env: Record<string, string> = {
      NEOP_APP_DB_URL: roleUrl('postgres://postgres@database:5432/fleet', `${app}_app`), NEOP_RUNNER_DB_URL: roleUrl('postgres://postgres@database:5432/fleet', `${app}_runner`),
      NEOP_JOB_TOKEN_SECRET: 'backend-image-fixture-'.repeat(3), NEOP_GATE_URL: 'http://backend:4102', NEOP_AGENT_URL: 'http://fixture:4103',
      NEOP_MATRIX_HOMESERVER_URL: 'http://fixture:8080', NEOP_PRESENCE: 'appservice', NEOP_MATRIX_HS_TOKEN: 'backend-fixture-hs', NEOP_MATRIX_AS_TOKEN: 'backend-fixture-as',
      NEOP_LLM_PROXY_URL: 'http://fixture:8080/llm', NEOP_LLM_SIGNING_KEY: JSON.stringify(key.privateJwk),
      FILES_HOST: '0.0.0.0', GATE_HOST: '0.0.0.0', APPSERVICE_HOST: '0.0.0.0', POOL_SIZE: '1',
    };
    const settings = Object.entries(env).flatMap(([name, value]) => ['-e', `${name}=${value}`]);
    const backend = `${prefix}-${app}-backend`;
    start(backend, image, [...hardening, '--network-alias', 'backend', ...settings]); await healthy(backend, 4101);
    const host = inspect(backend).HostConfig;
    assert(host.ReadonlyRootfs && host.CapDrop.includes('ALL') && !host.Privileged, 'backend hardening absent');
    assert(Object.keys(inspect(backend).NetworkSettings.Networks).length === 1, 'unexpected backend network');
    const probe = await readFile(path.join(REPO, 'scripts/fleet/packaging/backend-probe.mjs'), 'utf8');
    const observed = JSON.parse(inNode(backend, probe));
    const ingress = JSON.parse(inNode(backend, `const send=token=>fetch('http://127.0.0.1:4104/_matrix/app/v1/transactions/fixture',{method:'PUT',headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},body:'{"events":[]}'});const a=await send(null),b=await send('backend-fixture-hs'); console.log(JSON.stringify([a.status,b.status]));`));
    assert([401,403].includes(ingress[0]) && ingress[1] === 200, 'Matrix appservice token boundary failed');
    const roles = (await admin.query('select distinct usename from pg_stat_activity where datname=current_database() and usename=any($1)', [[`${app}_app`, `${app}_runner`]])).rows.map(row => row.usename).sort();
    assert(JSON.stringify(roles) === JSON.stringify([`${app}_app`, `${app}_runner`].sort()), 'wrong runtime database roles');
    assert((await admin.query(`select count(*)::int as n from ${sqlIdent(app)}.jobs`)).rows[0].n === 0, 'startup fixture created an unexpected job');
    docker(['stop', '--time', '12', backend]); assert(inspect(backend).State.ExitCode === 0, 'backend shutdown failed');
    assert(!logs(backend).includes(key.privateJwk.d!), 'private signing key in runtime logs'); remove(backend);
    const migration = (await admin.query(`select name,checksum from ${sqlIdent(app)}.schema_migrations order by name limit 1`)).rows[0];
    const drift = `${prefix}-${app}-drift`;
    try {
      await admin.query(`update ${sqlIdent(app)}.schema_migrations set checksum=repeat('0',64) where name=$1`, [migration.name]);
      start(drift, image, [...hardening, ...settings]);
      assert(docker(['wait', drift], 30_000) === '78', 'packaged schema drift was not refused');
      assert(logs(drift).includes('schema_refused') && !logs(drift).includes(key.privateJwk.d!), 'unsafe schema refusal');
    } finally { await admin.query(`update ${sqlIdent(app)}.schema_migrations set checksum=$1 where name=$2`, [migration.checksum, migration.name]); if (containers.has(drift)) remove(drift); }
    const refused = `${prefix}-${app}-provider-key`;
    start(refused, image, [...hardening, ...settings, '-e', 'ANTHROPIC_API_KEY=synthetic-never-log']);
    assert(docker(['wait', refused], 30_000) === '78', 'backend accepted a model provider key');
    assert(logs(refused).includes('configuration_refused') && !logs(refused).includes('synthetic-never-log'), 'unsafe provider-key refusal'); remove(refused);
    report.results.push({ app, ...observed, health: true, databaseRoles: roles, matrixTokenBoundary: true, emptyJobBook: true, schemaDriftRefused: true, providerKeyRefused: true, cleanShutdown: true });
    console.log(`${app}: backend boot, restricted roles, sandbox negatives and refusal checks passed`);
  }
  report.success = true;
} catch (error) { report.success = false; report.error = error instanceof Error ? error.message : String(error); console.error(report.error); process.exitCode = 1; }
finally {
  try { await admin?.end(); } catch { report.success = false; report.databaseCloseFailed = true; process.exitCode = 1; }
  for (const name of [...containers].reverse()) { try { remove(name); } catch { report.cleanup.push({ container: name, removed: false }); process.exitCode = 1; } }
  for (const network of [...networks].reverse()) { try { assert(JSON.parse(docker(['network', 'inspect', network]))[0].Labels?.['neop.fleet.backend-probe'] === prefix, 'unowned network'); docker(['network', 'rm', network]); networks.delete(network); } catch { process.exitCode = 1; } }
  report.remainingContainers = [...containers]; report.remainingNetworks = [...networks];
  report.success = report.success === true && containers.size === 0 && networks.size === 0;
  await writeFile(path.resolve(output), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ success: report.success, checked: report.results.length, report: path.resolve(output), remainingContainers: report.remainingContainers, remainingNetworks: report.remainingNetworks }));
}
