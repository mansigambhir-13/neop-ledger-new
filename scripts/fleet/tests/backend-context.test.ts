import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BACKEND_DEPENDENCIES, BACKEND_PACKAGES, BACKEND_RUNTIME, backendForbidden, createBackendContext, readDenoArchive, verifyBackendContext } from '../packaging/backend-context.ts';
import { FLEET_APPS } from '../runtime/apps.ts';

let temporary: string, root: string, output: string, archive: string, lock: any;
const put = async (file: string, value: string | Buffer) => { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, value); };
const manifest = async (name: string, patch: object = {}) => put(path.join(root, 'node_modules', name, 'package.json'), JSON.stringify({ name, version: '1.0.0', ...patch }));
async function denoArchive(patch: object = {}, machine = 183) {
  const binary = Buffer.alloc(64); binary.write('7f454c46', 'hex'); binary[4] = 2; binary[5] = 1; binary.writeUInt16LE(machine, 18);
  await put(path.join(temporary, 'archive/package/deno'), binary);
  await put(path.join(temporary, 'archive/package/package.json'), JSON.stringify({ name: '@deno/linux-arm64-glibc', version: '2.9.6', os: ['linux'], cpu: ['arm64'], ...patch }));
  execFileSync('tar', ['-czf', archive, '-C', path.join(temporary, 'archive'), 'package']);
  lock.packages['@deno/linux-arm64-glibc@2.9.6'] = { resolution: { integrity: 'sha512-' + createHash('sha512').update(await readFile(archive)).digest('base64') } };
  await put(path.join(root, 'pnpm-lock.yaml'), JSON.stringify(lock));
}
beforeEach(async () => {
  temporary = await mkdtemp(path.join(os.tmpdir(), 'fleet-backend-package-'));
  root = path.join(temporary, 'repo'); output = path.join(temporary, 'context'); archive = path.join(temporary, 'deno.tgz');
  for (const name of BACKEND_RUNTIME) await put(path.join(root, `scripts/fleet/runtime/${name}.ts`), '// fixture source\n');
  for (const name of BACKEND_PACKAGES) {
    await put(path.join(root, `packages/${name}/src/index.ts`), 'export const fixture=true;\n');
    await put(path.join(root, `packages/${name}/package.json`), JSON.stringify({ name: `@neop/${name === 'neop-template' ? 'template' : name}`, version: '0.1.0' }));
  }
  for (const name of ['worker', 'extension', 'index', 'prompt', 'arguments', 'load', 'bundle', 'context']) await put(path.join(root, `packages/neop-template/src/agent/${name}.ts`), '// fixture\n');
  await put(path.join(root, 'packages/neop-template/migrations/001.sql'), '-- fixture\n');
  for (const app of FLEET_APPS) {
    for (const file of ['src/index.ts', 'migrations/002.sql', 'blocks/home.json', 'manifest.json', 'scripts/backend.ts']) await put(path.join(root, 'apps', app, file), '// fixture\n');
    await put(path.join(root, `apps/${app}/package.json`), JSON.stringify({ name: `@neop/${app}`, version: '0.1.0' }));
    await put(path.join(root, `apps/${app}/tests/private.test.ts`), '// not shipped\n');
  }
  await put(path.join(root, '.env'), 'DO_NOT_COPY=synthetic-only');
  await put(path.join(root, 'deploy/fleet/backend.Dockerfile'), 'FROM scratch\n');
  lock = { importers: { 'packages/neop-template': { dependencies: { deno: { version: '2.9.6' } } } }, snapshots: { 'deno@2.9.6': { optionalDependencies: { '@deno/linux-arm64-glibc': '2.9.6' } } }, packages: Object.fromEntries([...BACKEND_DEPENDENCIES, 'openai'].map(name => [`${name}@1.0.0`, {}])) };
  for (const name of BACKEND_DEPENDENCIES) await manifest(name);
  await denoArchive();
});
afterEach(async () => { await rm(temporary, { recursive: true, force: true }); });

describe('backend-only packaging policy', () => {
  it('pins the Linux binary and separates shared backend sources from eighteen app overlays', async () => {
    const artifact = await createBackendContext(output, archive, 'arm64', root);
    expect(artifact.apps).toEqual(FLEET_APPS); expect(artifact.dependencies).toHaveLength(6);
    expect(artifact.deno).toMatchObject({ name: '@deno/linux-arm64-glibc', version: '2.9.6', architecture: 'arm64' });
    expect(await verifyBackendContext(output)).toEqual(artifact);
    const paths = artifact.inventory.map(row => row.path);
    expect(paths.some(p => p.includes('/tests/') || p.endsWith('.env') || p.endsWith('/agent/worker.ts'))).toBe(false);
    expect(paths).toContain('runtime/packages/neop-template/src/agent/context.ts');
    expect(paths.some(p => p.startsWith('runtime/apps/'))).toBe(false);
    for (const app of FLEET_APPS) {
      expect(paths).toContain(`entries/${app}/apps/${app}/manifest.json`);
      expect(await readFile(path.join(output, `entries/${app}/entry.mjs`), 'utf8')).toBe(`import './apps/${app}/scripts/backend.ts';\n`);
      const loader = await readFile(path.join(output, `entries/${app}/scripts/fleet/runtime/load.ts`), 'utf8');
      expect(loader).toContain(`if (app !== '${app}')`); expect(loader).toContain('def.manifest.app !== app');
      expect(paths.filter(p => p.startsWith(`entries/${app}/apps/`)).every(p => p.startsWith(`entries/${app}/apps/${app}/`))).toBe(true);
    }
  });
  it('rejects an altered archive before producing a context', async () => {
    await put(archive, 'not the pinned archive');
    await expect(createBackendContext(output, archive, 'arm64', root)).rejects.toThrow(/integrity/);
    await expect(readFile(path.join(output, 'artifact.json'))).rejects.toThrow();
  });
  it('refuses an unpinned target instead of copying the host Deno', async () => {
    await expect(readDenoArchive(archive, 'x64', root)).rejects.toThrow(/not pinned/);
    lock.snapshots['deno@2.9.6'].optionalDependencies['@deno/linux-arm64-glibc'] = '1.0.0';
    await put(path.join(root, 'pnpm-lock.yaml'), JSON.stringify(lock));
    await expect(readDenoArchive(archive, 'arm64', root)).rejects.toThrow(/not pinned/);
  });
  it.each([{ name: 'wrong-package' }, { version: '1.0.0' }, { cpu: ['x64'] }, { os: ['darwin'] }])('refuses mismatched archive identity %j', async patch => {
    await denoArchive(patch);
    await expect(readDenoArchive(archive, 'arm64', root)).rejects.toThrow(/identity mismatch/);
  });
  it('refuses the wrong ELF architecture even when archive metadata agrees', async () => {
    await denoArchive({}, 62);
    await expect(readDenoArchive(archive, 'arm64', root)).rejects.toThrow(/ELF architecture/);
  });
  it('refuses model dependencies reached transitively', async () => {
    await manifest('openai'); await manifest('hono', { dependencies: { openai: '^1' } });
    await expect(createBackendContext(output, archive, 'arm64', root)).rejects.toThrow(/forbidden/);
    for (const name of ['openai', '@mariozechner/pi-ai', '@anthropic-ai/sdk', '@neop/platform', 'deno']) expect(backendForbidden(name)).toBe(true);
    expect(backendForbidden('pg')).toBe(false);
  });
  it('refuses hidden source files and does not ship arbitrary credentials', async () => {
    await put(path.join(root, 'apps/pay/src/.env'), 'SYNTHETIC=do-not-copy');
    await expect(createBackendContext(output, archive, 'arm64', root)).rejects.toThrow(/unreviewed source/);
  });
  it('refuses source symlinks, native dependency files and output overwrite', async () => {
    await symlink(path.join(root, '.env'), path.join(root, 'apps/pay/src/secret.ts'));
    await expect(createBackendContext(output, archive, 'arm64', root)).rejects.toThrow(/unreviewed source/);
    await expect(createBackendContext(output, archive, 'arm64', root)).rejects.toThrow(/new directory/);
    await put(path.join(root, 'node_modules/hono/host.node'), 'wrong-platform');
    await expect(createBackendContext(path.join(temporary, 'second'), archive, 'arm64', root)).rejects.toThrow(/target-platform build/);
  });
  it('detects source changes after generation', async () => {
    await createBackendContext(output, archive, 'arm64', root);
    await put(path.join(output, 'entries/pay/apps/pay/src/index.ts'), '// changed');
    await expect(verifyBackendContext(output)).rejects.toThrow(/inventory/);
  });
  it('detects extra files and altered executable permissions', async () => {
    await createBackendContext(output, archive, 'arm64', root);
    await chmod(path.join(output, 'deno/deno'), 0o644);
    await expect(verifyBackendContext(output)).rejects.toThrow(/mode mismatch/);
    await chmod(path.join(output, 'deno/deno'), 0o555);
    await put(path.join(output, 'runtime/unexpected.json'), '{}');
    await expect(verifyBackendContext(output)).rejects.toThrow(/inventory/);
  });
  it('detects altered binary bytes separately from provenance claims', async () => {
    await createBackendContext(output, archive, 'arm64', root);
    await chmod(path.join(output, 'deno/deno'), 0o755);
    await put(path.join(output, 'deno/deno'), 'altered binary');
    await expect(verifyBackendContext(output)).rejects.toThrow(/inventory/);
  });
  it('refuses a symlink replacing an explicitly selected launcher', async () => {
    const launcher = path.join(root, 'apps/pay/scripts/backend.ts');
    await rm(launcher); await symlink(path.join(root, '.env'), launcher);
    await expect(createBackendContext(output, archive, 'arm64', root)).rejects.toThrow(/unreviewed source/);
  });
  it('pins the base image, retains default non-root execution and performs no dependency downloads', async () => {
    const dockerfile = await readFile(new URL('../../../deploy/fleet/backend.Dockerfile', import.meta.url), 'utf8');
    expect(dockerfile).toMatch(/FROM node:24-bookworm-slim@sha256:[a-f0-9]{64}/);
    expect(dockerfile).toContain('USER node'); expect(dockerfile).toContain('COPY entries/${NEOP_APP}/ ./');
    expect(dockerfile).not.toMatch(/RUN .*?(?:npm |pnpm |curl |wget )/);
  });
});
