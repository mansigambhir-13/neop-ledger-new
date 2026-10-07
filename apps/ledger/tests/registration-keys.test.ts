// Conformance at registration (plan test bar).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { manifestSha256, REQUIRED_SUITES } from '@neop/platform';
import { bootPilot, type Pilot } from './harness.ts';

let P: Pilot;
beforeAll(async () => {
  P = await bootPilot();
});
afterAll(async () => P?.close());


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
    P.platform.registerApp({ key: 'ledgercopy', manifest: manifest(), service_secret: 's'.repeat(40), conformance });

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
