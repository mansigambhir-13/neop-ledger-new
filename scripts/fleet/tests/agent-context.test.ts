import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AGENT_DEPENDENCIES, AGENT_FILES, createAgentContext, forbiddenDependency, inventory, verifyAgentContext } from '../packaging/agent-context.ts';
import { FLEET_APPS } from '../runtime/apps.ts';

let temporary: string, root: string, output: string;
const put = async (file: string, value: string) => { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, value); };
const manifest = async (name: string, patch: object = {}) => put(path.join(root, 'node_modules', name, 'package.json'), JSON.stringify({ name, version: '1.0.0', ...patch }));
beforeEach(async () => {
  temporary = await mkdtemp(path.join(os.tmpdir(), 'fleet-agent-package-'));
  root = path.join(temporary, 'repo'); output = path.join(temporary, 'context');
  for (const file of AGENT_FILES) await put(path.join(root, file), '// fixture source\n');
  await put(path.join(root, 'packages/contracts/src/index.ts'), 'export const fixture = true;\n');
  await put(path.join(root, 'packages/contracts/package.json'), '{"name":"@neop/contracts","type":"module","exports":"./src/index.ts"}');
  await put(path.join(root, 'deploy/fleet/agent.Dockerfile'), 'FROM scratch\n');
  await put(path.join(root, '.env'), 'DO_NOT_COPY=fixture-only\n');
  await put(path.join(root, 'apps/pay/src/data/private.ts'), '// must not enter an assistant artifact\n');
  await put(path.join(root, 'pnpm-lock.yaml'), JSON.stringify({ packages: Object.fromEntries([...AGENT_DEPENDENCIES, 'fixture-dependency', 'pg'].map(name => [`${name}@1.0.0`, {}])) }));
  for (const name of AGENT_DEPENDENCIES) { await manifest(name); await put(path.join(root, 'node_modules', name, 'index.js'), 'export const fixture = true;\n'); }
});
afterEach(async () => { await rm(temporary, { recursive: true, force: true }); });

describe('minimal assistant artifact policy', () => {
  it('copies only reviewed sources and pinned dependencies, keeping all eighteen fixed identities', async () => {
    const built = await createAgentContext(output, root);
    expect(built.apps).toEqual(FLEET_APPS); expect(built.dependencies).toHaveLength(6);
    const files = built.inventory.map(entry => entry.path);
    expect(files).not.toContain('runtime/.env');
    expect(files.some(file => file.includes('/src/data/') || file.includes('/pgkit/') || file.endsWith('/backend.ts'))).toBe(false);
    for (const app of FLEET_APPS) expect(await readFile(path.join(output, 'entries', `${app}.mjs`), 'utf8')).toBe(`import './apps/${app}/scripts/agent.ts';\n`);
    expect(await verifyAgentContext(output)).toEqual(built);
    expect(await readFile(path.join(output, 'runtime/packages/neop-template/package.json'), 'utf8')).not.toContain('pgkit');
  });

  it('vendors a transitive dependency exactly once with internal relative links', async () => {
    await manifest('fixture-dependency'); await manifest('hono', { dependencies: { 'fixture-dependency': '^1' } });
    await manifest('ajv', { dependencies: { 'fixture-dependency': '^1' } });
    const built = await createAgentContext(output, root);
    expect(built.dependencies.filter(dependency => dependency.name === 'fixture-dependency')).toHaveLength(1);
    expect(built.inventory.filter(entry => entry.kind === 'symlink' && entry.path.endsWith('/fixture-dependency'))).toHaveLength(2);
    expect(await verifyAgentContext(output)).toEqual(built);
  });

  it('records absent optional peers without installing anything', async () => {
    await manifest('hono', { peerDependencies: { 'optional-fixture': '^1' }, peerDependenciesMeta: { 'optional-fixture': { optional: true } } });
    const built = await createAgentContext(output, root);
    expect(built.dependencies.find(dependency => dependency.name === 'hono')?.unresolvedPeers).toEqual([{ name: 'optional-fixture', range: '^1', optional: true }]);
  });

  it.each(['dependencies', 'peerDependencies'])('refuses an absent required %s before writing output', async kind => {
    await manifest('hono', { [kind]: { 'missing-fixture': '^1' } });
    await expect(createAgentContext(output, root)).rejects.toThrow(/not installed/);
    await expect(readFile(path.join(output, 'artifact.json'))).rejects.toThrow();
  });

  it('refuses installed versions not in the lockfile', async () => {
    await manifest('hono', { version: '99.0.0' });
    await expect(createAgentContext(output, root)).rejects.toThrow(/not pinned/);
  });

  it('refuses database packages reached transitively', async () => {
    await manifest('pg'); await manifest('hono', { dependencies: { pg: '^1' } });
    await expect(createAgentContext(output, root)).rejects.toThrow(/forbidden/);
    for (const name of ['pg', 'pg-pool', 'postgres', '@neop/pgkit', '@neop/platform', 'deno']) expect(forbiddenDependency(name)).toBe(true);
  });

  it('does not overwrite an existing directory or workspace ancestor', async () => {
    await mkdir(output); await put(path.join(output, 'keep'), 'user-owned');
    await expect(createAgentContext(output, root)).rejects.toThrow(/new directory/);
    await expect(createAgentContext(temporary, root)).rejects.toThrow(/new directory/);
    expect(await readFile(path.join(output, 'keep'), 'utf8')).toBe('user-owned');
  });

  it('refuses native binaries instead of copying a host executable into a Linux image', async () => {
    await put(path.join(root, 'node_modules/hono/fixture.node'), 'native-fixture');
    await expect(createAgentContext(output, root)).rejects.toThrow(/target-platform build/);
  });

  it('refuses symlinks inside copied packages', async () => {
    await symlink(path.join(root, '.env'), path.join(root, 'node_modules/hono/private-link'));
    await expect(createAgentContext(output, root)).rejects.toThrow(/unreviewed symlink/);
  });

  it('detects content changes and extra files after the inventory is written', async () => {
    await createAgentContext(output, root);
    await put(path.join(output, 'runtime/apps/pay/scripts/agent.ts'), '// tampered');
    await expect(verifyAgentContext(output)).rejects.toThrow(/does not match/);
    await put(path.join(output, 'runtime/.env'), 'unexpected');
    await expect(verifyAgentContext(output)).rejects.toThrow(/does not match/);
  });

  it('rejects an artifact link that leaves its root', async () => {
    await mkdir(output); await symlink(path.join(root, '.env'), path.join(output, 'outside'));
    await expect(inventory(output)).rejects.toThrow(/escaping artifact link/);
  });

  it('canonicalizes a root alias without allowing a relative link to escape', async () => {
    await mkdir(output); await put(path.join(output, 'inside'), 'fixture');
    await symlink('inside', path.join(output, 'internal'));
    const alias = path.join(temporary, 'context-alias');
    await symlink(output, alias);
    expect(await inventory(alias)).toEqual(await inventory(output));
    await symlink('../repo/.env', path.join(output, 'outside'));
    await expect(inventory(alias)).rejects.toThrow(/escaping artifact link/);
  });
});
