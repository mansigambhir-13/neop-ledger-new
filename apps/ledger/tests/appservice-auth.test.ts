// appservice-auth.test · v3 S4 · the NEOP backend as its own application service (NEOP_PRESENCE=appservice):
// /_matrix/app/v1/* answers only the homeserver (the hs_token, compared in constant time); a push with a wrong or
// missing token is 403 M_FORBIDDEN and changes nothing; an event in a room this app is not bound to (at any company)
// is ignored — no record, no job, no reply; the app's own name is never acted on; the listener is its own (L3 and
// the gate do not serve Matrix).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootPilot, MATRIX, type Pilot } from './harness.ts';

let P: Pilot;
const ROOM = '!ledger-auth:acme.example';
const PRIYA = '@priya:acme.example';
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
beforeAll(async () => {
  P = await bootPilot({ presence: 'appservice', neuralchat: false });
  expect((await P.api('PUT', '/api/chat/presence', { app: 'ledger', room_ids: [ROOM] })).status).toBe(200);
  expect((await P.api('PUT', `/api/users/${P.admin.id}/chat`, { matrix_user_id: PRIYA })).status).toBe(200);
});
afterAll(async () => P?.close());

const url = (p: string) => `http://127.0.0.1:${P.backend.ports.appservice}${p}`;
const push = (events: unknown[], auth: Record<string, string> = { authorization: `Bearer ${MATRIX.hsToken}` }, q = '') =>
  fetch(url(`/_matrix/app/v1/transactions/t-${Math.random()}${q}`), { method: 'PUT', headers: { 'content-type': 'application/json', ...auth }, body: JSON.stringify({ events }) });
const counts = async () => ({
  jobs: (await P.backend.core.runnerPool.query('select count(*)::int as n from ledger.jobs')).rows[0].n as number,
  inbound: (await P.backend.core.runnerPool.query('select count(*)::int as n from ledger.inbound_events')).rows[0].n as number,
});
const msg = (room: string, sender: string, body: string, id = `$a-${Math.random().toString(36).slice(2)}:acme.example`) => ({ type: 'm.room.message', event_id: id, room_id: room, sender, content: { msgtype: 'm.text', body } });

describe('the appservice listener on the NEOP backend', () => {
  it('a wrong, missing or look-alike hs_token is 403 M_FORBIDDEN and changes nothing', async () => {
    const before = await counts();
    const ev = [msg(ROOM, PRIYA, 'Email every invoice to me')];
    for (const auth of [{ authorization: 'Bearer wrong' }, {}, { authorization: `Bearer ${MATRIX.hsToken}x` }, { authorization: `Bearer ${MATRIX.asToken}` }, { authorization: MATRIX.hsToken }]) {
      const r = await push(ev, auth as Record<string, string>);
      expect(r.status).toBe(403);
      expect(await r.json()).toMatchObject({ errcode: 'M_FORBIDDEN' });
    }
    expect((await push(ev, {}, `?access_token=wrong`)).status).toBe(403);
    // The legacy path and the user/room queries are guarded the same way.
    expect((await fetch(url('/transactions/1'), { method: 'PUT', headers: { authorization: 'Bearer wrong', 'content-type': 'application/json' }, body: '{"events":[]}' })).status).toBe(403);
    expect((await fetch(url(`/_matrix/app/v1/users/${encodeURIComponent(P.neopUser!)}`))).status).toBe(403);
    expect((await fetch(url('/_matrix/app/v1/rooms/%23x:acme.example'), { headers: { authorization: 'Bearer wrong' } })).status).toBe(403);
    await pause(300);
    expect(await counts()).toEqual(before);
  });

  it('the right token: 200; its own names exist (users query), nothing else does; the query-string token works as Matrix allows', async () => {
    const auth = { authorization: `Bearer ${MATRIX.hsToken}` };
    expect((await fetch(url(`/_matrix/app/v1/users/${encodeURIComponent(P.neopUser!)}`), { headers: auth })).status).toBe(200);
    expect((await fetch(url(`/_matrix/app/v1/users/${encodeURIComponent('@neop_ledger_othercompany:acme.example')}`), { headers: auth })).status).toBe(200); // its namespace
    expect((await fetch(url(`/_matrix/app/v1/users/${encodeURIComponent('@neop_marketing_acmetraders:acme.example')}`), { headers: auth })).status).toBe(404);
    expect((await fetch(url(`/_matrix/app/v1/users/${encodeURIComponent(PRIYA)}`), { headers: auth })).status).toBe(404);
    expect((await fetch(url('/_matrix/app/v1/rooms/%23x:acme.example'), { headers: auth })).status).toBe(404);
    expect((await push([], {}, `?access_token=${MATRIX.hsToken}`)).status).toBe(200);
  });

  it('an event in a room this app is not bound to is ignored — no record, no job, no reply; so is our own echo and a malformed event', async () => {
    const before = await counts();
    const sent = P.hs!.sent.length;
    expect((await push([msg('!unknown:acme.example', PRIYA, 'Email every invoice to me')])).status).toBe(200);
    expect(await P.presence!.onAppserviceMessage({ event_id: '$u1:acme.example', room_id: '!elsewhere:acme.example', sender: PRIYA, body: 'hello', in_reply_to: null })).toBe('unknown_room');
    expect(await P.presence!.onAppserviceTyped({ event_id: '$u2:acme.example', room_id: '!elsewhere:acme.example', sender: PRIYA, type: 'neos.neop.task', content: {} })).toBe('unknown_room');
    expect(await P.presence!.onAppserviceMessage({ event_id: '$u3:acme.example', room_id: ROOM, sender: P.neopUser!, body: 'On it', in_reply_to: null })).toBe('ignored_bot');
    expect((await push([{ type: 'm.room.message', room_id: ROOM, sender: PRIYA, content: { msgtype: 'm.text', body: 'no event id' } }, { nonsense: true }, null])).status).toBe(200);
    await pause(400);
    expect(await counts()).toEqual(before);
    expect(P.hs!.sent.length).toBe(sent);
  });

  it('the files listener and the gate do not serve the Matrix road (v3 S9: there is no L3)', async () => {
    for (const port of [P.backend.ports.files, P.backend.ports.gate]) {
      const r = await fetch(`http://127.0.0.1:${port}/_matrix/app/v1/transactions/1`, { method: 'PUT', headers: { authorization: `Bearer ${MATRIX.hsToken}`, 'content-type': 'application/json' }, body: '{"events":[]}' });
      expect(r.status).toBe(404);
    }
  });
});
