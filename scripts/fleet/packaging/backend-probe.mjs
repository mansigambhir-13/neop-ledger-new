// Executed inside the backend image by the opt-in packaging rehearsal only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { Sandbox } from '/srv/packages/neop-template/src/packages/sandbox.ts';
import { loadFleetApp } from '/srv/scripts/fleet/runtime/load.ts';

assert.notEqual(process.getuid(), 0);
assert.deepEqual(fs.readdirSync('/srv/apps'), [process.env.NEOP_APP]);
const require = createRequire('/srv/package.json');
for (const name of ['@mariozechner/pi-ai', '@mariozechner/pi-agent-core', '@anthropic-ai/sdk', 'openai', '@neop/platform']) assert.throws(() => require.resolve(name));
for (const file of ['/srv/packages/platform', '/srv/packages/neop-template/src/agent/worker.ts', '/srv/scripts/fleet/runtime/agent.ts', '/srv/.env']) assert.equal(fs.existsSync(file), false);
assert.throws(() => fs.writeFileSync('/srv/unexpected', 'fixture'));
assert.equal((await loadFleetApp(process.env.NEOP_APP)).manifest.app, process.env.NEOP_APP);
await assert.rejects(loadFleetApp(process.env.NEOP_APP === 'pay' ? 'buy' : 'pay'));

const sandbox = new Sandbox({ name: 'local-packaging-fixture', handlersSource: `
export const abilities = { probe: { run: async (_args, ctx) => {
  const errors = {};
  const attempts = {
    read: () => Deno.readTextFile('/etc/passwd'),
    write: () => Deno.writeTextFile('/tmp/should-not-exist', 'fixture'),
    env: () => Deno.env.get('NEOP_JOB_TOKEN_SECRET'),
    net: () => Deno.connect({hostname:'database',port:5432}),
    run: () => new Deno.Command('/bin/true').output(),
  };
  for(const [name, attempt] of Object.entries(attempts)) {
    try { await attempt(); errors[name] = 'ALLOWED'; } catch(error) { errors[name] = error.name; }
  }
  const rpc = await ctx.book.step('synthetic sandbox RPC');
  return {errors, rpc};
} } };
` });
const calls = [];
try {
  const result = await sandbox.call('probe', 'run', {}, { company: 'fixture' }, async (op, params) => { calls.push({ op, params }); return { recorded: true }; });
  assert.deepEqual(result, { errors: { read: 'NotCapable', write: 'NotCapable', env: 'NotCapable', net: 'NotCapable', run: 'NotCapable' }, rpc: { recorded: true } });
  assert.deepEqual(calls, [{ op: 'book.step', params: { summary: 'synthetic sandbox RPC' } }]);
  assert.equal(fs.existsSync('/tmp/should-not-exist'), false);
  console.log(JSON.stringify({ nonRoot: true, readOnly: true, ownAppOnly: true, noModelLibraries: true, fixedLoader: true, sandbox: result.errors, sandboxRpc: true }));
} finally { sandbox.stop(); }
