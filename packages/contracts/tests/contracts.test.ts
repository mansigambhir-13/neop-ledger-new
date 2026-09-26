import { describe, expect, it } from 'vitest';
import { canonicalize, fingerprint, strictest } from '../src/index.ts';

describe('JCS canonicalization (RFC 8785)', () => {
  it('sorts keys and drops whitespace', () => {
    expect(canonicalize({ b: 1, a: [true, null, 'x'], c: { z: 1, y: 2 } })).toBe(
      '{"a":[true,null,"x"],"b":1,"c":{"y":2,"z":1}}',
    );
  });
  it('matches the RFC number examples', () => {
    expect(canonicalize([1e30, 4.5, 0.002, 1e-27, -0])).toBe('[1e+30,4.5,0.002,1e-27,0]');
  });
  it('sorts by UTF-16 code units', () => {
    expect(canonicalize({ '€': 1, '\r': 2, '1': 3, '😀': 4, 'ö': 5 })).toBe(
      '{"\\r":2,"1":3,"ö":5,"€":1,"😀":4}',
    );
  });
  it('refuses values JSON cannot hold', () => {
    expect(() => canonicalize(Number.NaN)).toThrow();
    expect(() => canonicalize(10n)).toThrow();
  });
});

describe('fingerprint', () => {
  const base = { key: 'ledger.close_pack.email', version: '1.0.0', company_id: 'c', job_id: 'j' };
  it('is stable under key order', () => {
    expect(fingerprint({ ...base, args: { a: 1, b: 2 } })).toBe(fingerprint({ ...base, args: { b: 2, a: 1 } }));
  });
  it('changes when anything bound changes', () => {
    const f = fingerprint({ ...base, args: { a: 1 } });
    expect(fingerprint({ ...base, args: { a: 2 } })).not.toBe(f);
    expect(fingerprint({ ...base, job_id: 'k', args: { a: 1 } })).not.toBe(f);
    expect(fingerprint({ ...base, version: '1.0.1', args: { a: 1 } })).not.toBe(f);
  });
});

describe('strictest wins', () => {
  it('orders off < ask_first < on', () => {
    expect(strictest('on', 'ask_first')).toBe('ask_first');
    expect(strictest('ask_first', 'off', 'on')).toBe('off');
    expect(strictest('on', undefined)).toBe('on');
  });
});
