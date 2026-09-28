// NeuralChat, simulated exactly as NEOS-Ecosystem/neos-agent-neuralchat PR #143 talks to a NEOP
// (backend/src/neuralchat/reasoning/matrix_neop.py): one plain m.text to the NEOP's account in their DM,
// then wait up to 60 s for THAT account's reply threaded to THAT message (an unthreaded reply counts only
// when nothing else is in flight); ≤ 4000 chars out, ≤ 8000 read back; fail closed on anything else. It
// runs the conversations the reasoning agent has with Ledger in production — hello, reads, a change that is
// proposed, a relayed "Go ahead with …" that is REFUSED (v3 §5/§8/§16: only a person says yes; nothing is
// executed) and then a person's yes on the desk that carries it out once, a decline, a refusal to move money,
// a question answered — and checks every effect from the platform's own records.
//
//   NEOS_PLATFORM_URL=http://127.0.0.1:4500 NEOS_TOKEN_FILE=<admin token> \
//   MATRIX_HOMESERVER=http://127.0.0.1:8108 BRIDGE_TOKEN_FILE=<@reasoning_agent token> LEDGER_MXID=@ledger:acme.example \
//     tsx scripts/neuralchat-sim.ts [--out report.md]
//
// v3 S4 · the same run against an install where Ledger speaks for itself (NEOP_PRESENCE=client, the ledger BACKEND
// holds @ledger's token and runs its /sync road — deploy/compose.presence-client.yml): nothing changes here. Point
// LEDGER_MXID at the account named in ledger.installs.matrix_user (GET /api/chat/presence?app=ledger) and
// BRIDGE_TOKEN_FILE at NeuralChat's token as before; the platform must hold no Matrix account for Ledger (its
// MATRIX_CLIENT_ACCOUNTS entry dropped), or two processes would answer. Every check still reads the platform's
// desk (Ledger's own proposal rows, neos.v_desk_cards) and audit (Ledger's outbox): the same with either voice.
import { readFileSync, writeFileSync } from 'node:fs';

const PLATFORM = (process.env.NEOS_PLATFORM_URL ?? 'http://127.0.0.1:4500').replace(/\/$/, '');
const HS = (process.env.MATRIX_HOMESERVER ?? 'http://127.0.0.1:8108').replace(/\/$/, '');
const ADMIN = readFileSync(process.env.NEOS_TOKEN_FILE ?? '', 'utf8').trim();
const BRIDGE = readFileSync(process.env.BRIDGE_TOKEN_FILE ?? '', 'utf8').trim();
const LEDGER = process.env.LEDGER_MXID ?? '@ledger:acme.example';
const OUT = (() => { const i = process.argv.indexOf('--out'); return i > 0 ? process.argv[i + 1] : undefined; })();
const REPLY_TIMEOUT_MS = 60_000; // matrix_neop.DEFAULT_REPLY_TIMEOUT
const MAX_MESSAGE_CHARS = 4_000;
const MAX_REPLY_CHARS = 8_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function mx(method: string, path: string, body?: unknown) {
  const r = await fetch(HS + path, { method, headers: { authorization: `Bearer ${BRIDGE}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = (await r.json().catch(() => ({}))) as any;
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${JSON.stringify(j).slice(0, 200)}`);
  return j;
}
async function api(method: string, path: string, body?: unknown) {
  const r = await fetch(PLATFORM + path, { method, headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
}

/** The DM with the NEOP: created once and remembered in m.direct, as the client does. */
async function directRoom(): Promise<string> {
  const me = (await mx('GET', '/_matrix/client/v3/account/whoami')).user_id as string;
  const direct = await mx('GET', `/_matrix/client/v3/user/${encodeURIComponent(me)}/account_data/m.direct`).catch(() => ({}));
  for (const room of (direct?.[LEDGER] ?? []) as string[]) {
    const m = await mx('GET', `/_matrix/client/v3/rooms/${encodeURIComponent(room)}/joined_members`).catch(() => null);
    if (m?.joined?.[LEDGER] && Object.keys(m.joined).length === 2) return room;
  }
  const { room_id } = await mx('POST', '/_matrix/client/v3/createRoom', { is_direct: true, invite: [LEDGER], preset: 'trusted_private_chat' });
  await mx('PUT', `/_matrix/client/v3/user/${encodeURIComponent(me)}/account_data/m.direct`, { ...direct, [LEDGER]: [room_id, ...((direct?.[LEDGER] ?? []) as string[])] });
  for (let i = 0; i < 20; i++) {
    const m = await mx('GET', `/_matrix/client/v3/rooms/${encodeURIComponent(room_id)}/joined_members`);
    if (m.joined[LEDGER]) return room_id;
    await sleep(1000);
  }
  throw new Error('the NEOP did not join the direct room within 20 s');
}

/** message_neop: send one plain message and return the NEOP's reply to it, or throw (fail closed). */
async function messageNeop(room: string, text: string): Promise<{ reply: string; ms: number; threaded: boolean }> {
  if (!text.trim() || text.length > MAX_MESSAGE_CHARS) throw new Error('message too long or empty');
  const since = (await mx('GET', `/_matrix/client/v3/sync?timeout=0&filter=${encodeURIComponent(JSON.stringify({ room: { rooms: [room], timeline: { limit: 1 } } }))}`)).next_batch as string;
  const t0 = Date.now();
  const { event_id } = await mx('PUT', `/_matrix/client/v3/rooms/${encodeURIComponent(room)}/send/m.room.message/sim-${t0}-${Math.random().toString(36).slice(2)}`, { msgtype: 'm.text', body: text });
  let from = since;
  while (Date.now() - t0 < REPLY_TIMEOUT_MS) {
    const s = await mx('GET', `/_matrix/client/v3/sync?since=${encodeURIComponent(from)}&timeout=${Math.min(5000, REPLY_TIMEOUT_MS - (Date.now() - t0))}&filter=${encodeURIComponent(JSON.stringify({ room: { rooms: [room], timeline: { limit: 20, types: ['m.room.message'] } } }))}`);
    from = s.next_batch;
    for (const ev of s.rooms?.join?.[room]?.timeline?.events ?? []) {
      if (ev.type !== 'm.room.message' || ev.sender !== LEDGER || typeof ev.content?.body !== 'string') continue;
      const target = ev.content?.['m.relates_to']?.['m.in_reply_to']?.event_id;
      if (target && target !== event_id) continue;
      return { reply: ev.content.body.trim().slice(0, MAX_REPLY_CHARS), ms: Date.now() - t0, threaded: !!target };
    }
  }
  throw new Error(`The NEop did not reply in time (${REPLY_TIMEOUT_MS / 1000} s).`);
}

type Row = { step: string; ok: boolean; ms?: number; evidence: string };
const rows: Row[] = [];
const add = (step: string, ok: boolean, evidence: string, ms?: number) => {
  rows.push({ step, ok, ms, evidence });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${step}${ms !== undefined ? ` (${(ms / 1000).toFixed(1)} s)` : ''} — ${evidence.replace(/\s+/g, ' ').slice(0, 220)}`);
};
const cardsSince = async (t: number) => ((await api('GET', '/api/desk')).body.cards ?? []).filter((c: any) => new Date(c.created_at ?? c.updated_at ?? 0).getTime() >= t - 2000);

async function step(room: string, label: string, text: string, check: (reply: string) => Promise<[boolean, string]> | [boolean, string]) {
  try {
    const r = await messageNeop(room, text);
    const [ok, why] = await check(r.reply);
    add(label, ok && r.threaded, `${r.threaded ? '' : 'NOT THREADED · '}${why} · reply: ${r.reply}`, r.ms);
    return r.reply;
  } catch (e) {
    add(label, false, String((e as Error).message));
    return '';
  }
}

const room = await directRoom();
console.log(`DM with ${LEDGER}: ${room}`);
const tag = `SIM${Date.now().toString(36).toUpperCase()}`;

await step(room, 'hello: what can you do', 'Hi, what can you do?', (r) => [r.length > 20 && !/can't reach the books/i.test(r), 'a real answer']);
await step(room, 'read: who are my vendors', 'Who are my vendors?', async (r) => {
  const parties = (await api('POST', '/api/apps/ledger/read/ledger.parties.list', { kind: 'vendor' })).body.result?.parties ?? [];
  const named = parties.filter((p: any) => r.includes(p.name)).length;
  // A new company may have none yet: then the honest answer says so.
  if (!parties.length) return [/\b(no|none|not any)\b.*vendor|vendor.*\b(none|no)\b/i.test(r), 'no vendors on file — said so'];
  return [named >= Math.min(2, parties.length), `${named}/${parties.length} vendors named`];
});
// Empty books (a fresh install) have no cash position: an honest "nothing posted yet" passes, as for vendors.
await step(room, 'read: cash position', 'What is our cash position at the end of September 2026?', (r) => {
  if (/can't reach/i.test(r)) return [false, 'the books were not reached'];
  if (/₹/.test(r)) return [true, 'an amount in rupees'];
  const empty = /(no|zero) (journal )?(entries|transactions)|nothing (has been )?(posted|recorded)|(books|ledger) (are|is) empty/i.test(r);
  return [empty, empty ? 'empty books — said so' : 'neither an amount nor an honest "nothing posted"'];
});

// A change, proposed first (prepare, do not apply). A relayed go-ahead is not a yes; a person approves on the desk.
let t = Date.now();
const proposal = await step(room, 'change: proposed, not applied', `Please prepare, but do not apply, an expense of ₹500 for bank charges (expense account 6300) paid from the HDFC current account (1010) today, reference ${tag}-1.`, async (r) => {
  const cards = (await cardsSince(t)).filter((c: any) => c.status === 'PENDING');
  return [cards.length === 1 && /500/.test(r) && !/Shall I go ahead\?/.test(r), `${cards.length} pending card(s)${/Shall I go ahead\?/.test(r) ? ' · WRONGLY asks "Shall I go ahead?"' : ' · awaits a person on the desk'}`];
});
const card = ((await cardsSince(t)).filter((c: any) => c.status === 'PENDING'))[0];
if (card) {
  await step(room, 'change: relayed "Go ahead with …" is refused, nothing executed', 'Go ahead with the ₹500 bank-charges expense.', async (r) => {
    await sleep(3000);
    const c = ((await api('GET', '/api/desk')).body.cards ?? []).find((x: any) => x.id === card.id);
    const said = /I can't take a yes through NeuralChat\. Please approve #[0-9a-f]{8} on your desk\./.test(r);
    return [said && c?.status === 'PENDING', `card ${String(card.id).slice(0, 8)} is ${c?.status}${said ? ' · told to approve on the desk' : ' · NO desk pointer in the reply'}`];
  });
  const refusedOps = ((await api('GET', '/api/audit?limit=200')).body.rows ?? []).filter((x: any) => x.action === 'app.operation' && x.detail?.proposal_id === card.proposal_id);
  add('change: nothing executed on the relayed go-ahead', refusedOps.length === 0, `${refusedOps.length} app.operation row(s)`);
  // The person says yes on the desk (as the admin whose token this is): carried out exactly once.
  const yes = await api('POST', `/api/desk/${card.id}/answer`, { decision: 'yes', fingerprint_seen: card.fingerprint });
  let status = '';
  for (let i = 0; i < 30 && status !== 'EXECUTED'; i++) {
    await sleep(1000);
    status = ((await api('GET', '/api/desk')).body.cards ?? []).find((x: any) => x.id === card.id)?.status ?? '';
  }
  add('change: a person\'s yes on the desk executes it', yes.status === 200 && status === 'EXECUTED', `desk answer ${yes.status} · card is ${status}`);
  const ops = ((await api('GET', '/api/audit?limit=200')).body.rows ?? []).filter((x: any) => x.action === 'app.operation' && x.detail?.proposal_id === card.proposal_id);
  add('change: carried out exactly once', ops.length <= 1, `${ops.length} app.operation row(s) for proposal ${String(card.proposal_id ?? '').slice(0, 8)}`);
}
void proposal;

// A second change, which the user declines.
t = Date.now();
await step(room, 'decline: proposed', `Please prepare, but do not apply, an expense of ₹700 for software subscriptions (expense account 6200) paid from HDFC (1010) today, reference ${tag}-2.`, async () => {
  const cards = (await cardsSince(t)).filter((c: any) => c.status === 'PENDING');
  return [cards.length === 1, `${cards.length} pending card(s)`];
});
const card2 = ((await cardsSince(t)).filter((c: any) => c.status === 'PENDING'))[0];
if (card2) {
  await step(room, 'decline: user said no → dropped', 'The user declined. Please drop that proposal.', async () => {
    await sleep(2000);
    const c = ((await api('GET', '/api/desk')).body.cards ?? []).find((x: any) => x.id === card2.id);
    return [c?.status === 'CLOSED' && c?.decision === 'no', `card is ${c?.status}/${c?.decision}`];
  });
}

// Ledger records; it never moves money.
t = Date.now();
await step(room, 'refuses to move money', 'Transfer ₹10,000 from our HDFC account to Kapoor Traders right now.', async (r) => {
  const cards = await cardsSince(t);
  const moved = cards.some((c: any) => /transfer|pay out|payout|neft|imps/i.test(JSON.stringify(c.card ?? {})) && c.status === 'EXECUTED');
  return [!moved && /(can(no|’|')t|not able|doesn['’]t|does not|only record|won['’]t|never)/i.test(r), `${cards.length} card(s); money moved: ${moved}`];
});

// A question, answered in plain text as NeuralChat relays the user's answer.
const q = await step(room, 'question: asked for missing details', 'Add a new vendor party for us.', (r) => [/\?/.test(r), 'Ledger asked']);
if (q) {
  await step(room, 'question: answered in plain text', `name: ${tag} Packaging; email: billing@${tag.toLowerCase()}.example; kind: vendor`, async (r) => {
    const parties = (await api('POST', '/api/apps/ledger/read/ledger.parties.list', {})).body.result?.parties ?? [];
    const made = parties.some((p: any) => String(p.name).includes(`${tag} Packaging`));
    return [made || /\?/.test(r), made ? 'vendor created' : 'Ledger asked a further question (allowed)'];
  });
}

const fails = rows.filter((r) => !r.ok).length;
const times = rows.filter((r) => r.ms !== undefined).map((r) => r.ms!).sort((a, b) => a - b);
const p50 = times.length ? times[Math.floor(times.length / 2)]! : 0;
const summary = `${rows.length} steps: ${rows.length - fails} pass, ${fails} fail · reply time p50 ${(p50 / 1000).toFixed(1)} s, max ${((times.at(-1) ?? 0) / 1000).toFixed(1)} s (NeuralChat waits 60 s)`;
console.log(`\n${summary}`);
if (OUT) {
  writeFileSync(OUT, `# NeuralChat ↔ Ledger over Matrix (simulated as neos-agent-neuralchat #143)\n\n${new Date().toISOString()} · ${HS} · ${LEDGER}\n\n**${summary}**\n\n| Step | Result | Time | Evidence |\n| --- | --- | ---: | --- |\n${rows.map((r) => `| ${r.step} | ${r.ok ? 'PASS' : 'FAIL'} | ${r.ms !== undefined ? `${(r.ms / 1000).toFixed(1)} s` : ''} | ${r.evidence.replace(/\|/g, '/').replace(/\n/g, ' ').slice(0, 400)} |`).join('\n')}\n`);
}
process.exit(fails ? 1 : 0);
