import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { lstat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { FLEET_APPS } from '../runtime/apps.ts';
import { REPO, verifyAgentContext } from './agent-context.ts';

const [context, output] = process.argv.slice(2);
if (!context || !output || process.argv.length !== 4) throw new Error('usage: node --import tsx scripts/fleet/packaging/check-agent-images.ts CONTEXT REPORT_JSON');
try {
  await lstat(path.resolve(output));
  throw new Error('report must be a new file; preserve earlier evidence');
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
}
const artifact = await verifyAgentContext(context);
const prefix = `neop-fleet5-${randomBytes(4).toString('hex')}`;
const label = `neop.fleet.probe=${prefix}`;
const containers: string[] = [], networks: string[] = [];
const base = 'node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6';
const report: any = { at: new Date().toISOString(), prefix, lockfileSha256: artifact.lockfileSha256, generatorSha256: artifact.generatorSha256, images: [], results: [], cleanup: [], production_ready: false };
const docker = (args: string[], timeout = 60_000) => execFileSync('docker', args, { encoding: 'utf8', timeout, maxBuffer: 8_000_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const inspect = (name: string) => JSON.parse(docker(['inspect', name]))[0];
const assert = (value: unknown, message: string) => { if (!value) throw new Error(message); };
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function createNetwork(name: string) { docker(['network', 'create', '--internal', '--label', label, name]); networks.push(name); }
function start(name: string, net: string, image: string, extra: string[] = [], command: string[] = []) {
  docker(['run', '-d', '--name', name, '--label', label, '--network', net, '--read-only', '--user', '1000:1000', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--pids-limit', '128', '--memory', '512m', '--tmpfs', '/tmp:rw,noexec,nosuid,size=16m', ...extra, image, ...command]);
  containers.push(name);
}
function fixture(name: string, net: string, role: string, port: number, alias: string) {
  start(name, net, base, ['--network-alias', alias, '--mount', `type=bind,src=${path.join(REPO, 'scripts/fleet/packaging/probe-fixture.mjs')},dst=/fixture.mjs,readonly`, '-e', `ROLE=${role}`, '-e', `PORT=${port}`], ['node', '/fixture.mjs']);
}
const inNode = (container: string, code: string) => docker(['exec', container, 'node', '--input-type=module', '-e', code]);
async function live(container: string, port: number) {
  for (let attempt = 0; attempt < 40; attempt++) {
    try { if (inNode(container, `const r=await fetch('http://127.0.0.1:${port}/live'); if(!r.ok)process.exit(1); console.log('ok');`) === 'ok') return; } catch {}
    const state = inspect(container).State;
    if (!state.Running) throw new Error(`fixture or worker exited: ${container}; ${docker(['logs', container]).slice(0, 1000)}`);
    await pause(200);
  }
  throw new Error(`container did not become live: ${container}`);
}
function removeContainer(name: string) {
  assert(inspect(name).Config.Labels?.['neop.fleet.probe'] === prefix, 'refusing cleanup of unowned container');
  docker(['rm', '-f', name]); containers.splice(containers.indexOf(name), 1);
}
function removeNetwork(name: string) {
  const data = JSON.parse(docker(['network', 'inspect', name]))[0];
  assert(data.Labels?.['neop.fleet.probe'] === prefix, 'refusing cleanup of unowned network');
  docker(['network', 'rm', name]); networks.splice(networks.indexOf(name), 1);
}

try {
  const forbiddenNet = `${prefix}-forbidden`; createNetwork(forbiddenNet);
  const database = `${prefix}-database`, peer = `${prefix}-peer`;
  fixture(database, forbiddenNet, 'sentinel', 5432, 'database');
  fixture(peer, forbiddenNet, 'sentinel', 4103, 'peer');
  await live(database, 5432); await live(peer, 4103);
  const databaseIp = inspect(database).NetworkSettings.Networks[forbiddenNet].IPAddress;
  const peerIp = inspect(peer).NetworkSettings.Networks[forbiddenNet].IPAddress;
  for (const app of FLEET_APPS) {
    console.log(`${app}: building pinned assistant image`);
    const image = `${prefix}-${app}-agent:local`;
    docker(['build', '--quiet', '--pull=false', '--network=none', '--label', label, '--build-arg', `NEOP_APP=${app}`, '-t', image, path.resolve(context)], 180_000);
    const imageData = JSON.parse(docker(['image', 'inspect', image]))[0];
    assert(imageData.Config.User === 'node', 'image must default to non-root');
    assert(JSON.stringify(imageData.Config.Cmd) === JSON.stringify(['node', 'entry.mjs']), 'wrong image entrypoint');
    report.images.push({ app, tag: image, id: imageData.Id, os: imageData.Os, architecture: imageData.Architecture });
    const net = `${prefix}-${app}`; createNetwork(net);
    const gate = `${prefix}-${app}-gate`, model = `${prefix}-${app}-model`, worker = `${prefix}-${app}-agent`;
    fixture(gate, net, 'gate', 8080, 'gate'); fixture(model, net, 'model', 8080, 'model');
    await live(gate, 8080); await live(model, 8080);
    start(worker, net, image, ['--network-alias', 'agent', '-e', 'NEOP_ALLOWED_GATE=http://gate:8080', '-e', 'POOL_SIZE=1']);
    await live(worker, 4103);
    const spec = inspect(worker);
    assert(spec.HostConfig.ReadonlyRootfs && spec.HostConfig.CapDrop.includes('ALL') && !spec.HostConfig.Privileged, 'worker hardening missing');
    assert(spec.Mounts.every((mount: any) => mount.Type === 'tmpfs' && mount.Destination === '/tmp'), 'assistant has unexpected mounts');
    assert(Object.keys(spec.NetworkSettings.Networks).length === 1, 'assistant has additional networks');
    assert(JSON.parse(docker(['network', 'inspect', net]))[0].Internal === true, 'network is not internal');
    inNode(worker, `import fs from 'node:fs';import {createRequire}from'node:module';const require=createRequire(import.meta.url);if(process.getuid()===0)throw Error('root');for(const p of ['pg','@neop/pgkit','@neop/platform','deno']){let found=false;try{require.resolve(p);found=true;}catch{}if(found)throw Error('forbidden dependency');}for(const p of ['/srv/packages/pgkit','/srv/packages/platform','/srv/packages/neop-template/src/core.ts','/srv/scripts/fleet/runtime/backend.ts','/run/secrets'])if(fs.existsSync(p))throw Error('backend or secret files');console.log('artifact isolation ok');`);
    const reachability = JSON.parse(inNode(worker, `import net from 'node:net';const probe=(host,port)=>new Promise(resolve=>{const socket=net.connect({host,port});let done=false;const finish=ok=>{if(done)return;done=true;socket.destroy();resolve(ok);};socket.setTimeout(1200,()=>finish(false));socket.on('connect',()=>finish(true));socket.on('error',()=>finish(false));});console.log(JSON.stringify(await Promise.all([probe('gate',8080),probe('model',8080),probe('${databaseIp}',5432),probe('${peerIp}',4103)])));`));
    assert(JSON.stringify(reachability) === '[true,true,false,false]', 'network reachability did not match the intended boundary');
    const bundle = {
      app: { key: app, version: 'fixture' }, company: { id: 'fixture-company', name: 'Local fixture', time_zone: 'UTC' },
      job: { id: `fixture-${app}`, source: 'fixture', requester: 'person:fixture', created_at: new Date().toISOString(), ask: 'Finish this local packaging fixture without business effects.' },
      prompt: { name: app, subject: 'local packaging check', looks_after: 'no business effects', who_you_talk_to: 'fixture' },
      skills: [], steps: [], facts: [], limits: { heartbeat_ms: 1000, session_ms: 20_000, max_tool_calls: 3 },
      tools: [{ key: 'job.finish', name: 'job__finish', title: 'Finish fixture', description: 'Finish only this fixture', kind: 'write', setting: 'on', input: { type: 'object', properties: { outcome: { type: 'string' }, summary: { type: 'string' } }, required: ['outcome', 'summary'], additionalProperties: false } }],
    };
    const request = { bundle, token: 'fixture-job-session', gate_url: 'http://gate:8080', llm: { base_url: 'http://model:8080', token: 'fixture-model-session' } };
    inNode(gate, `const r=await fetch('http://agent:4103/sessions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(${JSON.stringify(request)})});if(r.status!==202)throw Error('session refused '+await r.text());`);
    let evidence: any;
    for (let attempt = 0; attempt < 60; attempt++) {
      evidence = JSON.parse(inNode(gate, "console.log(JSON.stringify(await(await fetch('http://127.0.0.1:8080/evidence')).json()));"));
      if (evidence.events.some((event: any) => event.path === '/gate/session.end')) break;
      await pause(250);
    }
    assert(evidence.events.some((event: any) => event.path === '/gate/session.end' && event.reason === 'finished'), 'fixture session did not finish');
    assert(evidence.events.filter((event: any) => event.tool === 'job.finish').length === 1, 'fixture did not finish exactly once');
    assert(evidence.events.some((event: any) => event.path === '/gate/transcript'), 'fixture transcript missing');
    const modelEvidence = JSON.parse(inNode(model, "console.log(JSON.stringify(await(await fetch('http://127.0.0.1:8080/evidence')).json()));"));
    assert(modelEvidence.events.length === 1 && modelEvidence.events[0].streamed, 'real model protocol path was not exercised');
    const refused = `${prefix}-${app}-refuse`;
    start(refused, net, image, ['-e', 'NEOP_ALLOWED_GATE=http://gate:8080', '-e', 'NEOP_APP_DB_URL=fixture-secret-do-not-log']);
    assert(docker(['wait', refused]) === '78', 'image did not refuse injected backend credentials');
    const refusalLog = spawnSync('docker', ['logs', refused], { encoding: 'utf8', timeout: 10_000 });
    const refusalText = refusalLog.stdout + refusalLog.stderr;
    assert(refusalLog.status === 0 && refusalText.includes('configuration_refused') && !refusalText.includes('fixture-secret-do-not-log'), 'image refused unsafely or leaked the fixture credential');
    removeContainer(refused);
    docker(['stop', '--time', '8', worker]); assert(inspect(worker).State.ExitCode === 0, 'worker shutdown failed');
    report.results.push({ app, nonRoot: true, readOnly: true, noCredentialMount: true, databaseLibrariesAbsent: true, injectedCredentialRefused: true, network: { ownGate: true, fixtureModel: true, foreignDatabase: false, peerWorker: false }, fixtureSession: 'finished', modelRequests: modelEvidence.events.length, cleanShutdown: true });
    console.log(`${app}: image, network, fixture session and shutdown passed`);
    removeContainer(worker); removeContainer(gate); removeContainer(model); removeNetwork(net);
  }
  report.success = true;
} catch (error) {
  report.success = false; report.error = error instanceof Error ? error.message : String(error); process.exitCode = 1;
  console.error(report.error);
} finally {
  for (const name of [...containers].reverse()) { try { removeContainer(name); report.cleanup.push({ kind: 'container', name, removed: true }); } catch { report.cleanup.push({ kind: 'container', name, removed: false }); process.exitCode = 1; } }
  for (const name of [...networks].reverse()) { try { removeNetwork(name); report.cleanup.push({ kind: 'network', name, removed: true }); } catch { report.cleanup.push({ kind: 'network', name, removed: false }); process.exitCode = 1; } }
  report.remainingContainers = containers; report.remainingNetworks = networks;
  report.success = report.success === true && containers.length === 0 && networks.length === 0;
  await writeFile(path.resolve(output), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ success: report.success, checked: report.results.length, remainingContainers: containers, remainingNetworks: networks, report: path.resolve(output) }));
}
