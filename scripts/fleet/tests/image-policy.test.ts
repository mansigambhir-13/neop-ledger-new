import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { FLEET_APPS } from '../runtime/apps.ts';
import { hostFixtureUrl, imageMap, loopbackPort, originalSource, verifySourceBinding, type ImageRef } from '../testing/image-policy.ts';
import { closeFixtures } from '../testing/process.ts';
let temporary: string;
beforeEach(async () => { temporary = await mkdtemp(path.join(os.tmpdir(), 'fleet-image-policy-')); });
afterEach(async () => { await rm(temporary, { recursive: true, force: true }); });
const rows = (): ImageRef[] => FLEET_APPS.map(app => ({ app, id: 'sha256:'+'a'.repeat(64), os: 'linux', architecture: 'arm64' }));
const entry = (name: string) => ({ path: name, kind: 'file' as const, sha256: createHash('sha256').update('fixture').digest('hex') });

it('requires exact immutable image IDs and complete unique app coverage', () => {
  expect(imageMap(rows()).size).toBe(18);
  expect(() => imageMap(rows().slice(1))).toThrow(/eighteen/);
  const duplicate=rows(); duplicate[1]=duplicate[0]!; expect(() => imageMap(duplicate)).toThrow(/duplicate/);
});
it.each([{id:'neop-pay:latest'},{os:'darwin'},{architecture:'amd64'},{app:'ledger'}])('refuses unsupported image evidence %j', patch => {
  const changed=rows(); changed[0]={...changed[0]!,...patch} as ImageRef; expect(()=>imageMap(changed)).toThrow(/unsupported/);
});
it('maps only explicit loopback fixtures, preserving their paths', () => {
  expect(loopbackPort('http://127.0.0.1:1234/llm')).toBe(1234);
  expect(hostFixtureUrl('http://127.0.0.1:1234/llm')).toBe('http://host.docker.internal:1234/llm');
  for(const value of ['https://127.0.0.1:1234','http://example.com:1234','http://localhost:1234','http://127.0.0.1','http://user:secret@127.0.0.1:1234','http://127.0.0.1:1234?url=elsewhere']) expect(()=>loopbackPort(value)).toThrow();
});
it('binds original code/data and omits generated overlays/manifests and vendored files', () => {
  expect(originalSource(entry('runtime/packages/contracts/src/index.ts'),'agent')).toBe('packages/contracts/src/index.ts');
  expect(originalSource(entry('entries/pay/apps/pay/manifest.json'),'backend')).toBe('apps/pay/manifest.json');
  for(const name of ['entries/pay/scripts/fleet/runtime/load.ts','runtime/packages/neop-template/package.json','runtime/node_modules/vendor/index.js','runtime/apps/../../outside']) expect(originalSource(entry(name),'backend')).toBeNull();
});
it('refuses stale packaged code instead of silently testing an older implementation', async () => {
  await mkdir(path.join(temporary,'apps/pay/src'),{recursive:true});
  const file=path.join(temporary,'apps/pay/src/index.ts'); await writeFile(file,'fixture');
  const entries=[entry('entries/pay/apps/pay/src/index.ts')];
  expect(await verifySourceBinding(entries,'backend',temporary)).toBe(1);
  await writeFile(file,'changed'); await expect(verifySourceBinding(entries,'backend',temporary)).rejects.toThrow(/stale/);
  await expect(verifySourceBinding([],'backend',temporary)).rejects.toThrow(/no original source/);
});
it('continues independent fixture cleanup after one close fails and still reports failure', async () => {
  const calls: number[]=[];
  await expect(closeFixtures([async()=>{calls.push(1);throw Error('fixture failure');},async()=>{calls.push(2);}])).rejects.toThrow(/cleanup failed/);
  expect(calls).toEqual([1,2]);
});
it('allows absent fixture resources during partial setup cleanup', async () => {
  await expect(closeFixtures([()=>undefined,async()=>undefined])).resolves.toBeUndefined();
});
