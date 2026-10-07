// a2a.test · what the platform still checks about one app using another (WP §10): at REGISTRATION, the ranges in a
// borrower's `uses` against what each owner serves. v3 S9: at run time nothing goes through the platform — an app asks
// another over the company's bus room, where the owner checks the asker's `uses` line, its own switch and (for a
// write) its person's yes, and a redelivered ask is never served twice (apps/ledger/tests/bus-room.test.ts replaces the
// gateway's ACL, platform-door and idempotency-ledger cases that were here).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootPilot, type Pilot } from './harness.ts';

let P: Pilot;
beforeAll(async () => {
  P = await bootPilot();
});
afterAll(async () => P?.close());

describe('borrowing is checked at registration (WP §10)', () => {
  const base = async () => (await import('../src/index.ts')).manifest;
  it('a borrower must name an ability that exists at a version in its range', async () => {
    const m = await base();
    const reg = (uses: any[]) => P.platform.registerApp({ key: 'probe', manifest: { ...m, app: 'probe', name: 'Probe', abilities: [], uses, blocks: [] } as any, service_secret: 'p'.repeat(32) });
    await expect(reg([{ app: 'ledger', ability: 'ledger.budget.remaining', range: '^2.0.0' }])).rejects.toThrow(/serves 1\.0\.0/);
    await expect(reg([{ app: 'ledger', ability: 'ledger.no_such_thing', range: '*' }])).rejects.toThrow(/ledger has no ledger\.no_such_thing/);
    // (v3 §10: a `uses` line may name an owner's WRITE — a borrowed write, asked for over the bus room; apps/marketing borrowed-write-presence.test.)
    // An owner not registered yet is checked when it registers (deploy order is free).
    await expect(reg([{ app: 'nobody', ability: 'nobody.y', range: '^1.0.0' }])).resolves.toBeUndefined();
    const nobody = { ...m, app: 'nobody', name: 'Nobody', abilities: [], uses: [], blocks: [] } as any;
    await expect(P.platform.registerApp({ key: 'nobody', manifest: nobody, service_secret: 'n'.repeat(32) })).rejects.toThrow(/probe uses nobody\.y@\^1\.0\.0; this manifest drops it/);
    await expect(reg([{ app: 'ledger', ability: 'ledger.budget.remaining', range: '^1.0.0' }])).resolves.toBeUndefined();
  });
  it('an owner cannot re-register in a way that breaks a pinned borrower', async () => {
    const m = await base();
    const bumped = { ...m, abilities: m.abilities.map((a) => (a.key === 'ledger.budget.remaining' ? { ...a, version: '2.0.0' } : a)) };
    await expect(P.platform.registerApp({ key: 'ledger', manifest: bumped as any, service_secret: 'l'.repeat(32) })).rejects.toThrow(/probe uses ledger\.budget\.remaining@\^1\.0\.0/);
  });
});
