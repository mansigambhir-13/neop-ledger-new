// jobtoken.test · S5: a gate call without a valid job token, from a session that
// no longer holds the claim, or outside the token's ability scope is refused.
import { afterAll, beforeAll, expect, it } from 'vitest';
import { SignJWT } from 'jose';
import { bootPilot, call, finish, type Pilot } from './harness.ts';

let P: Pilot;
let gate: string;
beforeAll(async () => {
  P = await bootPilot();
  gate = `http://127.0.0.1:${P.backend.ports.gate}`;
});
afterAll(async () => P?.close());

const gcall = (token: string | null, tool: string, args: unknown = {}) =>
  fetch(`${gate}/gate/call`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ tool, args }),
  });

it('refuses calls without a token or with a token not minted by this backend', async () => {
  expect((await gcall(null, 'ledger.report.pnl')).status).toBe(401);
  const fake = await new SignJWT({ sid: 's', company_id: P.company.id, app: 'ledger', abilities: ['ledger.report.pnl'] })
    .setProtectedHeader({ alg: 'HS256', typ: 'neop-job' })
    .setSubject('00000000-0000-0000-0000-000000000000')
    .setExpirationTime('1m')
    .sign(new TextEncoder().encode('x'.repeat(40)));
  expect((await gcall(fake, 'ledger.report.pnl')).status).toBe(401);
});

it('refuses a live session calling outside its scope, and a stale session entirely', async () => {
  let token = '';
  let hold = true;
  P.setBrain((v) => {
    if (v.calls === 0) return call('ledger.report.pnl', { from: '2026-08-01', to: '2026-08-31' });
    return hold ? { hang: true } : finish('done');
  });
  const { job_id } = await P.ask('P&L for August');
  const job = await P.waitFor(async () => {
    const j = await P.jobRow(job_id);
    return j.status === 'RUNNING' && j.claimed_by && j;
  }, 'running');
  // Mint a token for the live session but with a narrower scope.
  token = await P.backend.core.jobTokens.mint({ sub: job_id, sid: job.claimed_by, company_id: P.company.id, abilities: ['ledger.report.pnl'] }, 60_000);
  const inScope = await (await gcall(token, 'ledger.report.pnl', { from: '2026-08-01', to: '2026-08-31' })).json();
  expect(inScope.status).toBe('done');
  const outOfScope = await (await gcall(token, 'ledger.report.cash_flow', { from: '2026-08-01', to: '2026-08-31' })).json();
  expect(outOfScope).toMatchObject({ status: 'refused', code: 'not_in_scope' });

  // A token for an older session of the same job is refused once the claim moved on.
  const stale = await P.backend.core.jobTokens.mint({ sub: job_id, sid: 'runner-1:old-session', company_id: P.company.id, abilities: ['ledger.report.pnl'] }, 60_000);
  expect((await gcall(stale, 'ledger.report.pnl', { from: '2026-08-01', to: '2026-08-31' })).status).toBe(409);
  hold = false;
  P.worker.kill(job_id);
});
