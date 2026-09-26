// Conformance at registration (plan test bar) and durable gateway key rotation (R10).
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createLocalJWKSet, jwtVerify } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, roleUrl } from '@neop/pgkit';
import { loadOrCreateSigningKeys, manifestSha256, migratePlatform, Platform, REQUIRED_SUITES } from '@neop/platform';
import { bootPilot, type Pilot } from './harness.ts';

let P: Pilot;
beforeAll(async () => {
  P = await bootPilot();
});
afterAll(async () => P?.close());

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('conformance at registration', () => {
  const manifest = () => ({ ...P.backend.core.manifest, app: 'ledgercopy' }) as any;
  const green = () => ({
    app: 'ledgercopy',
    manifest_sha256: manifestSha256(manifest()),
    commit: 'abc1234',
    suites: REQUIRED_SUITES.map((name) => ({ name, file: `apps/ledgercopy/tests/${name}.test.ts`, passed: 3, failed: 0 })),
    failed: 0,
    generated_at: new Date().toISOString(),
  });
  const register = (conformance?: unknown) =>
    P.platform.registerApp({ key: 'ledgercopy', l3_url: 'http://127.0.0.1:9', manifest: manifest(), service_secret: 's'.repeat(40), conformance });

  it('production refuses an app without a green attestation for exactly this manifest', async () => {
    process.env.NEOS_ENV = 'production';
    try {
      await expect(register()).rejects.toMatchObject({ code: 'unattested', message: expect.stringContaining('no conformance attestation') });
      await expect(register({ ...green(), manifest_sha256: manifestSha256({ ...manifest(), version: '9.9.9' }) })).rejects.toMatchObject({ message: expect.stringContaining('different manifest') });
      await expect(register({ ...green(), failed: 1 })).rejects.toMatchObject({ message: expect.stringContaining('1 failed') });
      await expect(register({ ...green(), suites: green().suites.filter((s) => s.name !== 'tenant') })).rejects.toMatchObject({ message: expect.stringContaining('tenant is missing') });
      await expect(register({ ...green(), suites: green().suites.map((s) => (s.name === 'wake-order' ? { ...s, passed: 0 } : s)) })).rejects.toMatchObject({ message: expect.stringContaining('wake-order passed no tests') });
      await expect(register({ ...green(), app: 'ledger' })).rejects.toMatchObject({ message: expect.stringContaining('not ledgercopy') });
      expect((await P.platform.db.query("select 1 from neos.apps where key = 'ledgercopy'")).rowCount).toBe(0);
      const refused = (await P.platform.db.query("select count(*)::int as n from neos.audit where action = 'app.register_refused' and detail->>'app' = 'ledgercopy'")).rows[0].n;
      expect(refused).toBe(6);
      await register(green());
      const row = (await P.platform.db.query("select conformance from neos.apps where key = 'ledgercopy'")).rows[0];
      expect(row.conformance.commit).toBe('abc1234');
    } finally {
      delete process.env.NEOS_ENV;
    }
  });

  it('dev accepts an unattested app but records that it is unattested', async () => {
    await register();
    const a = (await P.platform.db.query("select outcome, detail from neos.audit where action = 'app.registered' and detail->>'app' = 'ledgercopy' order by id desc limit 1")).rows[0];
    expect(a.outcome).toBe('unattested');
    expect(a.detail.problem).toBe('no conformance attestation');
    expect((await P.platform.db.query("select conformance from neos.apps where key = 'ledgercopy'")).rows[0].conformance).toBeNull();
  });
});

describe('gateway key rotation is durable', () => {
  it('a restart inside the activation window still activates the published key on time', async () => {
    const db = await createTestDatabase();
    await migratePlatform(db.adminUrl);
    const file = path.join(await mkdtemp(path.join(os.tmpdir(), 'neop-keys-')), 'gateway-key.json');
    try {
      const ringA = await loadOrCreateSigningKeys(file);
      const oldKid = ringA.active.kid;
      const A = new Platform({ dbUrl: roleUrl(db.adminUrl, 'neos_app'), keys: ringA, dbPoolSize: 2 });
      const { next } = await A.rotateGatewayKey('user:ops', 1_500);
      expect(ringA.active.kid).toBe(oldKid); // published, not yet signing
      await expect(A.rotateGatewayKey('user:ops', 1_500)).rejects.toMatchObject({ code: 'rotation_in_progress' });
      await A.stop(); // the process dies inside the window: an in-memory timer would be lost here

      const ringB = await loadOrCreateSigningKeys(file); // restart: the keyring comes back from its file
      expect(ringB.keys.find((k) => k.kid === next)?.state).toBe('next');
      const B = new Platform({ dbUrl: roleUrl(db.adminUrl, 'neos_app'), keys: ringB, dbPoolSize: 2 });
      try {
        expect(await B.keysTick()).toBeNull(); // not yet
        expect(ringB.active.kid).toBe(oldKid);
        await sleep(1_600);
        expect(await B.keysTick()).toBe(next);
        expect(ringB.active.kid).toBe(next);
        expect((await loadOrCreateSigningKeys(file)).active.kid).toBe(next); // persisted
        const rows = (await B.db.query('select kid, state from neos.gateway_keys order by published_at')).rows;
        expect(rows).toEqual([
          { kid: oldKid, state: 'previous' },
          { kid: next, state: 'active' },
        ]);
        // Tokens signed with the new key verify; the previous key still verifies until retired.
        const tok = await B.gateway.mint({ aud: 'ledger', sub: 'platform', company_id: null, ability: 'manifest', idem_key: 'k' });
        await jwtVerify(tok, createLocalJWKSet(B.gateway.jwks() as any));
        expect(B.gateway.jwks().keys.map((k: any) => k.kid)).toEqual(expect.arrayContaining([oldKid, next]));
        await expect(B.retirePreviousGatewayKey('user:ops')).rejects.toMatchObject({ code: 'too_soon' });
        expect((await B.retirePreviousGatewayKey('user:ops', true)).retired).toEqual([oldKid]);
        expect(B.gateway.jwks().keys.map((k: any) => k.kid)).toEqual([next]);
        expect((await B.db.query("select state from neos.gateway_keys where kid = $1", [oldKid])).rows[0].state).toBe('retired');
        const audit = (await B.db.query("select action from neos.audit where action like 'gateway.key_%' order by id")).rows.map((r) => r.action);
        expect(audit).toEqual(['gateway.key_published', 'gateway.key_activated', 'gateway.key_retired']);
      } finally {
        await B.stop();
      }
    } finally {
      await db.drop();
    }
  });

  it('the operator endpoints rotate, report and retire on a running platform; the apps keep answering', async () => {
    expect((await P.api('POST', '/api/ops/keys/rotate', { activate_after_ms: 200 })).status).toBe(403); // admins cannot
    const r = await P.api('POST', '/api/ops/keys/rotate', { activate_after_ms: 200 }, P.operator.token);
    expect(r.status).toBe(200);
    await P.waitFor(async () => (await P.api('GET', '/api/ops/keys', undefined, P.operator.token)).body.keys.find((k: any) => k.kid === r.body.next && k.state === 'active'), 'activated by the worker tick', 10_000);
    await sleep(1_200); // the app's JWKS cache (1 s in the pilot) refreshes
    const read = await P.api('POST', '/api/apps/ledger/read/ledger.accounts.list', { as_of: '2026-09-30' });
    expect(read.status).toBe(200);
    const too = await P.api('POST', '/api/ops/keys/retire-previous', {}, P.operator.token);
    expect(too.body.error.code).toBe('too_soon');
    const done = await P.api('POST', '/api/ops/keys/retire-previous', { force: true }, P.operator.token);
    expect(done.body.retired).toHaveLength(1);
  });
});
