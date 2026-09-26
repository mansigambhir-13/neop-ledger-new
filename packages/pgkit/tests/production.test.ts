// production.test · with NEOS_ENV=production, no known dev credential can reach a cluster.
import { afterEach, describe, expect, it } from 'vitest';
import { adminUrlFromEnv, rolePassword } from '../src/index.ts';

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

describe('production credentials', () => {
  it('dev mode keeps the known dev password; production refuses it', () => {
    delete process.env.NEOS_ENV;
    expect(rolePassword('ledger_app')).toBe('ledger_app_dev_pw');
    process.env.NEOS_ENV = 'production';
    expect(() => rolePassword('ledger_app')).toThrow(/NEOS_PW_LEDGER_APP/);
    process.env.NEOS_PW_LEDGER_APP = 's3cret';
    expect(rolePassword('ledger_app')).toBe('s3cret');
  });

  it('package roles derive from their host key, differ per role, and fail closed without it', () => {
    process.env.NEOS_ENV = 'production';
    expect(() => rolePassword('ledger_nep_gst')).toThrow();
    process.env.NEOS_PKG_PW_KEY_LEDGER = 'k'.repeat(32);
    const a = rolePassword('ledger_nep_gst');
    expect(a).toHaveLength(43);
    expect(rolePassword('ledger_nep_tds')).not.toBe(a);
    // Another host's key does not open ledger's package roles.
    delete process.env.NEOS_PKG_PW_KEY_LEDGER;
    process.env.NEOS_PKG_PW_KEY_WAGE = 'k'.repeat(32);
    expect(() => rolePassword('ledger_nep_gst')).toThrow();
  });

  it('the admin URL has no silent default in production', () => {
    delete process.env.NEOS_ADMIN_URL;
    delete process.env.NEOS_ADMIN_URL_FILE;
    process.env.NEOS_ENV = 'production';
    expect(() => adminUrlFromEnv()).toThrow(/NEOS_ADMIN_URL/);
  });
});
