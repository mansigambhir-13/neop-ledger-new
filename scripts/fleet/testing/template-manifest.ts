import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { assertGeneratedManifestsFresh, declarationContentHash, declarationProblems, fleetManifest, readAppDeclaration, stableJson, templateManifest, FLEET_TEMPLATE_COMMIT, FLEET_TEMPLATE_VERSION } from '@neop/template';
import { composeYaml } from '../deploy/compose.ts';
import { ROOT } from '../template-alignment.ts';
import { isFleetApp } from '../runtime/apps.ts';

const secretValue = /(sk-[A-Za-z0-9_-]{16,}|postgres(?:ql)?:\/\/[^\s:@/]+:[^\s@/]+@|-----BEGIN [A-Z ]*PRIVATE KEY-----)/;

export function templateManifestTests(app: string) {
  if (!isFleetApp(app)) throw new Error(`unknown app ${app}`);
  const appRoot = path.join(ROOT, 'apps', app);

  test(`${app}: one pinned declaration generates both manifests`, () => {
    const declaration = readAppDeclaration(appRoot);
    expect(declarationProblems(declaration, app)).toEqual([]);
    expect(declaration.template).toEqual(expect.objectContaining({ commit: FLEET_TEMPLATE_COMMIT, version: FLEET_TEMPLATE_VERSION }));
    expect(readFileSync(path.join(appRoot, 'manifest.json'), 'utf8')).toBe(stableJson(fleetManifest(declaration)));
    expect(readFileSync(path.join(appRoot, 'manifest.template.json'), 'utf8')).toBe(stableJson(templateManifest(declaration, appRoot)));
    expect(() => assertGeneratedManifestsFresh(appRoot)).not.toThrow();
    expect(declarationContentHash(declaration, appRoot)).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  test(`${app}: template contract exposes the v0.8.16 identity, catalogue and closed capabilities`, () => {
    const declaration = readAppDeclaration(appRoot);
    const emitted = templateManifest(declaration, appRoot);
    expect(emitted).toEqual(expect.objectContaining({ id: app, schema: app, persistence: 'schema', migrations: 'migrations/', catalogueId: `ne-${app}`, kit: 'NEOS V3' }));
    expect(emitted.capabilities.map((item) => item.id)).toEqual(declaration.manifest.abilities.map((ability) => ability.key));
    expect(emitted.capabilities.every((item) => item.method === 'GET' || item.method === 'POST')).toBe(true);
    expect(emitted.capabilities.every((item) => item.input && item.output && item.scope)).toBe(true);
    const lines = new Set(emitted.abilities.map((item) => item.line));
    for (const ability of declaration.manifest.abilities) expect(lines.has(ability.key)).toBe(true);
    expect(lines.has('ask_app')).toBe(true);
    expect(lines.has('notify_person')).toBe(true);
    expect(emitted.skills.map((item) => item.id)).toEqual(declaration.manifest.skills.map((skill) => skill.key));
    expect(emitted.blocks.map((item) => item.file)).toEqual(declaration.manifest.blocks);
  });

  test(`${app}: runtime manifest and generated Compose agree on three isolated processes`, () => {
    const emitted = templateManifest(readAppDeclaration(appRoot), appRoot);
    const runtime = emitted.runtime as { processes: { name: string; credentials: string[] }[]; credentials: { name: string; process: string; secret: boolean }[] };
    expect(runtime.processes.map((item) => item.name)).toEqual(['backend', 'agent', 'frontend']);
    expect(runtime.processes.find((item) => item.name === 'agent')?.credentials).toEqual([]);
    expect(runtime.processes.find((item) => item.name === 'frontend')?.credentials).toEqual(['NEOP_FRONTEND_KEY']);
    expect(runtime.credentials.every((item) => item.secret)).toBe(true);
    expect(readFileSync(path.join(ROOT, 'deploy', 'fleet', 'generated', `${app}.compose.yaml`), 'utf8')).toBe(composeYaml(app));
    expect(secretValue.test(stableJson(emitted))).toBe(false);
  });

  test(`${app}: generated outputs detect declaration drift`, () => {
    const declaration = readAppDeclaration(appRoot);
    const changed = structuredClone(declaration);
    changed.manifest.name = `${changed.manifest.name} Changed`;
    expect(stableJson(fleetManifest(changed))).not.toBe(readFileSync(path.join(appRoot, 'manifest.json'), 'utf8'));
    expect(stableJson(templateManifest(changed, appRoot))).not.toBe(readFileSync(path.join(appRoot, 'manifest.template.json'), 'utf8'));
  });
}
