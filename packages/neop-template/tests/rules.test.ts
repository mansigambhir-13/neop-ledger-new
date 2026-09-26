import { describe, expect, it } from 'vitest';
import { checkRules, forcedAskFirst, zonedParts, type Rule } from '../src/domain/rules.ts';
import { canTransition, WAKES_JOB } from '../src/domain/proposals.ts';

const usage = { day_minor: 0, month_minor: 0 };
const email = { ability_key: 'x.email', external: true, recipients: ['a@acme.example'] };

describe('company rules', () => {
  it('time window uses the company time zone ("nothing on weekends")', () => {
    const weekdays: Rule[] = [{ id: 'weekdays', type: 'time_window', days: [1, 2, 3, 4, 5], from: '09:00', to: '18:00' }];
    // Friday 2026-09-25 20:00 UTC is Saturday 01:30 in Kolkata.
    const at = new Date('2026-09-25T20:00:00Z');
    expect(zonedParts(at, 'Asia/Kolkata').isoDay).toBe(6);
    expect(checkRules(weekdays, email, at, 'Asia/Kolkata', usage)?.rule_id).toBe('weekdays');
    expect(checkRules(weekdays, email, new Date('2026-09-25T06:00:00Z'), 'Asia/Kolkata', usage)).toBeNull();
    // Internal (non-external) abilities are not covered by a default-scope rule.
    expect(checkRules(weekdays, { ...email, external: false }, at, 'Asia/Kolkata', usage)).toBeNull();
  });
  it('destination and recipient caps', () => {
    const rules: Rule[] = [
      { id: 'internal', type: 'destination', mode: 'internal_only', domains: ['acme.example'] },
      { id: 'few', type: 'recipient_cap', max: 1 },
    ];
    expect(checkRules(rules, { ...email, recipients: ['x@evil.example'] }, new Date(), 'UTC', usage)?.rule_id).toBe('internal');
    expect(checkRules(rules, { ...email, recipients: ['a@acme.example', 'b@acme.example'] }, new Date(), 'UTC', usage)?.rule_id).toBe('few');
  });
  it('amount caps per call, day and month', () => {
    const r: Rule[] = [{ id: 'cap', type: 'amount_cap', currency: 'INR', per_call_minor: 100, per_day_minor: 150, per_month_minor: 1000, applies_to: 'all' }];
    const s = { ability_key: 'pay', external: true, currency: 'INR' };
    expect(checkRules(r, { ...s, amount_minor: 101 }, new Date(), 'UTC', usage)?.reason).toMatch(/per-call/);
    expect(checkRules(r, { ...s, amount_minor: 60 }, new Date(), 'UTC', { day_minor: 100, month_minor: 100 })?.reason).toMatch(/daily/);
    expect(checkRules(r, { ...s, amount_minor: 60 }, new Date(), 'UTC', { day_minor: 0, month_minor: 950 })?.reason).toMatch(/monthly/);
    expect(checkRules(r, { ...s, amount_minor: 60, currency: 'USD' }, new Date(), 'UTC', usage)).toBeNull();
  });
  it('require_person forces ask-first', () => {
    expect(forcedAskFirst([{ id: 'p', type: 'require_person', abilities: ['x.post'] }], 'x.post')).toBe(true);
  });
});

describe('proposal lifecycle', () => {
  it('only terminal states wake the job; APPROVED never does (B2)', () => {
    expect(WAKES_JOB).not.toContain('APPROVED');
    expect(WAKES_JOB).not.toContain('EXECUTING');
    expect(canTransition('PROPOSED', 'EXECUTING')).toBe(false);
    expect(canTransition('APPROVED', 'EXECUTING')).toBe(true);
    expect(canTransition('UNKNOWN', 'DONE')).toBe(true);
    expect(canTransition('DONE', 'FAILED')).toBe(false);
  });
});
