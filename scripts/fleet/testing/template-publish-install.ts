import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { exportJWK, generateKeyPair, type JWK } from 'jose';
import { appReleaseContentHash, AppReleaseError, createAppRelease, FileAppReleaseRegistry, fleetManifest, installAppRelease, signAppRelease, stableJson, templateManifest, verifyAppRelease, FLEET_TEMPLATE_COMMIT, type AppDeclaration, type AppRelease, type SignedAppRelease } from '@neop/template';
import { ROOT } from '../template-alignment.ts';
import { isFleetApp } from '../runtime/apps.ts';

function file(bytes: Buffer) {
  return { sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`, bytes: bytes.length, base64: bytes.toString('base64') };
}

function replaceJson(release: AppRelease, name: string, value: unknown): AppRelease {
  const next = structuredClone(release);
  next.files[name] = file(Buffer.from(stableJson(value)));
  next.content_hash = appReleaseContentHash(next);
  return next;
}

function nextPatch(version: string): string {
  const [major, minor, patch] = version.split('.').map(Number) as [number, number, number];
  return `${major}.${minor}.${patch + 1}`;
}

export function templatePublishInstallTests(app: string) {
  if (!isFleetApp(app)) throw new Error(`unknown app ${app}`);
  const appRoot = path.join(ROOT, 'apps', app);
  let scratch: string;
  let release: AppRelease;
  let signed: SignedAppRelease;
  let privateJwk: JWK;
  let trusted: { keys: JWK[] };
  let registry: FileAppReleaseRegistry;

  beforeAll(async () => {
    scratch = await mkdtemp(path.join(tmpdir(), `neop-release-${app}-`));
    release = await createAppRelease(appRoot);
    const { privateKey, publicKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
    privateJwk = { ...(await exportJWK(privateKey)), kid: 'fleet-test', alg: 'EdDSA', use: 'sig' };
    trusted = { keys: [{ ...(await exportJWK(publicKey)), kid: 'fleet-test', alg: 'EdDSA', use: 'sig' }] };
    signed = await signAppRelease(release, privateJwk, 'fleet-test');
    registry = new FileAppReleaseRegistry(path.join(scratch, 'registry'));
  });

  afterAll(async () => { if (scratch) await rm(scratch, { recursive: true, force: true }); });

  test(`${app}: publish bundle binds generated manifests and the pinned template`, async () => {
    expect(release).toEqual(expect.objectContaining({ app, template_commit: FLEET_TEMPLATE_COMMIT }));
    expect(release.files).toEqual(expect.objectContaining({ 'app.declaration.json': expect.any(Object), 'manifest.json': expect.any(Object), 'manifest.template.json': expect.any(Object) }));
    await expect(verifyAppRelease(signed, trusted)).resolves.toBeUndefined();
    const tampered = structuredClone(signed);
    const encoded = tampered.release.files['manifest.json']!.base64;
    tampered.release.files['manifest.json']!.base64 = `${encoded[0] === 'A' ? 'B' : 'A'}${encoded.slice(1)}`;
    await expect(verifyAppRelease(tampered, trusted)).rejects.toMatchObject({ code: 'bad_release' });
  });

  test(`${app}: publishing is idempotent and a version is immutable`, async () => {
    await expect(registry.publish(signed, trusted)).resolves.toBe('published');
    await expect(registry.publish(signed, trusted)).resolves.toBe('already-published');
    const changedPackage = JSON.parse(Buffer.from(release.files['package.json']!.base64, 'base64').toString('utf8')) as Record<string, unknown>;
    changedPackage.release_test_marker = true;
    const changed = await signAppRelease(replaceJson(release, 'package.json', changedPackage), privateJwk, 'fleet-test');
    await expect(registry.publish(changed, trusted)).rejects.toMatchObject({ code: 'version_conflict' });
    expect((await registry.get(app, release.version)).release.content_hash).toBe(release.content_hash);
  });

  test(`${app}: install verifies content, is idempotent, and refuses local drift`, async () => {
    const target = path.join(scratch, 'installed-drift');
    await expect(installAppRelease({ bundle: signed, target, trusted })).resolves.toBe('installed');
    await expect(installAppRelease({ bundle: signed, target, trusted })).resolves.toBe('already-installed');
    const packageFile = path.join(target, 'package.json');
    await chmod(packageFile, 0o644);
    await writeFile(packageFile, `${await readFile(packageFile, 'utf8')}\n`);
    await expect(installAppRelease({ bundle: signed, target, trusted })).rejects.toMatchObject({ code: 'install_drift' });
  });

  test(`${app}: a failed atomic upgrade restores the verified prior release`, async () => {
    const target = path.join(scratch, 'installed-rollback');
    await installAppRelease({ bundle: signed, target, trusted });
    const declaration = JSON.parse(Buffer.from(release.files['app.declaration.json']!.base64, 'base64').toString('utf8')) as AppDeclaration;
    declaration.manifest.version = nextPatch(declaration.manifest.version);
    let upgraded = replaceJson(release, 'app.declaration.json', declaration);
    upgraded = replaceJson(upgraded, 'manifest.json', fleetManifest(declaration));
    upgraded = replaceJson(upgraded, 'manifest.template.json', templateManifest(declaration, appRoot));
    upgraded.version = declaration.manifest.version;
    upgraded.content_hash = appReleaseContentHash(upgraded);
    const signedUpgrade = await signAppRelease(upgraded, privateJwk, 'fleet-test');
    await expect(installAppRelease({ bundle: signedUpgrade, target, trusted, faultAfterBackup: true })).rejects.toBeInstanceOf(AppReleaseError);
    await expect(installAppRelease({ bundle: signed, target, trusted })).resolves.toBe('already-installed');
    const marker = JSON.parse(await readFile(path.join(target, '.neop-release.json'), 'utf8')) as { content_hash: string };
    expect(marker.content_hash).toBe(release.content_hash);
  });
}
