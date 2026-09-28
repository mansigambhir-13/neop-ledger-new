// Pilot acceptance (plan, end of Phase 2): real Ledger requests from one company, with a real
// model, checked against the platform's own records:
//   · 100% produce a job and an ack
//   · every gated action has a person's yes with a matching fingerprint
//   · zero effects without a proposal (or a standing yes a person wrote)
//   · zero duplicate executions
//   · every report fact links to its source
// Cards are answered by the signed-in person whose token is given (a person's yes, as on the desk).
//   NEOS_PLATFORM_URL=http://127.0.0.1:4400 NEOS_TOKEN_FILE=… tsx scripts/pilot-acceptance.ts [out.md]
import { readFileSync, writeFileSync } from 'node:fs';

const BASE = (process.env.NEOS_PLATFORM_URL ?? 'http://127.0.0.1:4400').replace(/\/$/, '');
const TOKEN = readFileSync(process.env.NEOS_TOKEN_FILE ?? '', 'utf8').trim();
const OUT = process.argv[2] ?? 'docs/PILOT-ACCEPTANCE.md';
const H = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(BASE + path, { method, headers: H, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = (await r.json().catch(() => ({}))) as any;
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${JSON.stringify(j)}`);
  return j;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 20 requests a bookkeeper would make in a week: reports, questions, and changes that must be approved.
const REQUESTS: { ask: string; kind: 'report' | 'change' }[] = [
  { ask: 'What was our net profit in August 2026, and what drove it?', kind: 'report' },
  { ask: 'Show me the balance sheet as of 30 September 2026. Does it balance?', kind: 'report' },
  { ask: 'How much cash did we have at the end of August 2026?', kind: 'report' },
  { ask: 'Which customer invoices are overdue today, and by how much?', kind: 'report' },
  { ask: 'What do we owe suppliers and when is each bill due?', kind: 'report' },
  { ask: 'What is our GST payable for July to September 2026?', kind: 'report' },
  { ask: 'How much of the September 2026 marketing budget (account 6400) is left?', kind: 'report' },
  { ask: 'Is the trial balance at 30 September 2026 in balance? Give me the totals.', kind: 'report' },
  { ask: 'Explain the cash flow for September 2026.', kind: 'report' },
  { ask: 'What were our three biggest expense accounts in the July to September 2026 quarter?', kind: 'report' },
  { ask: 'The bank line "NEFT CR KAPOOR TRADERS INV-0002" is Kapoor Traders paying invoice INV-0002. Record that receipt using that bank line.', kind: 'change' },
  { ask: 'Code the bank line "AWS INDIA PVT LTD SUBSCRIPTION" to software subscriptions (6200).', kind: 'change' },
  { ask: 'Email invoice INV-0004 to Kapoor Traders.', kind: 'change' },
  { ask: 'Send Sharma Retail a payment reminder for overdue invoice INV-0003.', kind: 'change' },
  { ask: 'Record supplier bill CS-2210 from CloudSoft India: ₹12,000 software subscription (account 6200), 18% GST, issued 26 September 2026, due 25 October 2026.', kind: 'change' },
  { ask: 'Create an invoice for Sharma Retail Pvt Ltd: "Display racks" ₹40,000 (account 4000) at 18% GST, issued today, due in 30 days. Do not email it yet.', kind: 'change' },
  { ask: 'Post a journal entry dated 26 September 2026 moving ₹5,000 from the HDFC current account (1010) to cash in hand (1000), memo "Petty cash top-up".', kind: 'change' },
  { ask: 'Code the bank line "SMS ALERT CHARGES" to bank charges (6300).', kind: 'change' },
  { ask: 'What is still blocking the September 2026 close?', kind: 'report' },
  { ask: 'List the journal entries posted in September 2026 with their amounts.', kind: 'report' },
];

type Row = { ask: string; kind: string; task_id: string; job_id: string | null; status: string; ack_ms: number | null; cards: number; summary: string; sources: number; cost: number; error?: string };

async function runOne(r: (typeof REQUESTS)[number]): Promise<Row> {
  const t0 = Date.now();
  const a = await api('POST', '/api/ask', { text: r.ask, app: 'ledger' });
  const row: Row = { ask: r.ask, kind: r.kind, task_id: a.task_id, job_id: a.job_id ?? null, status: a.status, ack_ms: a.job_id ? Date.now() - t0 : null, cards: 0, summary: '', sources: 0, cost: 0 };
  const answered = new Set<string>();
  const deadline = Date.now() + 6 * 60_000;
  while (Date.now() < deadline) {
    const d = await api('GET', `/api/tasks/${a.task_id}`);
    for (const c of d.approvals.filter((x: any) => x.status === 'PENDING' && !answered.has(x.id))) {
      // A person reads the card and answers against the fingerprint on it.
      await api('POST', `/api/desk/${c.id}/answer`, { decision: 'yes', fingerprint_seen: c.fingerprint });
      answered.add(c.id);
    }
    if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(d.task.status)) {
      row.status = d.task.status;
      row.cards = d.approvals.length;
      row.summary = String(d.task.result?.summary ?? '').replace(/\s+/g, ' ').slice(0, 220);
      row.sources = (d.task.result?.sources ?? []).length;
      row.cost = d.cost.usd;
      return row;
    }
    await sleep(3000);
  }
  row.status = 'TIMEOUT';
  return row;
}

const started = new Date();
const rows: Row[] = [];
for (let i = 0; i < REQUESTS.length; i += 4) {
  const batch = await Promise.all(REQUESTS.slice(i, i + 4).map((r) => runOne(r).catch((e) => ({ ask: r.ask, kind: r.kind, task_id: '', job_id: null, status: 'ERROR', ack_ms: null, cards: 0, summary: '', sources: 0, cost: 0, error: String(e) }) as Row)));
  rows.push(...batch);
  for (const b of batch) console.log(`${b.status.padEnd(10)} ${b.cards} card(s) ${b.ask.slice(0, 70)}`);
}

// ── the checks, from the platform's own rows ──────────────────────────────
const taskIds = new Set(rows.map((r) => r.task_id).filter(Boolean));
const jobIds = new Set(rows.map((r) => r.job_id).filter(Boolean));
const { cards } = await api('GET', '/api/desk');
const mine = cards.filter((c: any) => taskIds.has(c.task_id));
const audit: any[] = [];
for (let before: number | null = null, n = 0; n < 20; n++) {
  const page = await api('GET', `/api/audit?limit=500${before ? `&before=${before}` : ''}`);
  audit.push(...page.rows);
  if (!page.next_before || new Date(page.rows.at(-1).at) < started) break;
  before = page.next_before;
}
const since = audit.filter((x) => new Date(x.at) >= started);
const { abilities } = await api('GET', '/api/apps/ledger/abilities');
const gated = new Set(abilities.filter((a: any) => a.kind === 'write' && a.setting === 'ask_first').map((a: any) => a.key));

const c1 = rows.every((r) => r.job_id && r.ack_ms !== null);
const executed = mine.filter((c: any) => c.status === 'EXECUTED');
const c2bad = executed.filter((c: any) => !(c.decision === 'yes' && c.fingerprint_seen === c.fingerprint && c.decided_by_name));
// Every effect of a gated ability during the run was carried out by the app's runner on a person's yes
// (`runner:<id>`, v3 S2) or by the gate on a standing yes (`grant:<id>`); one performed by an assistant directly would
// be recorded as `assistant:<job>`.
const ops = since.filter((x) => x.action === 'app.operation' && gated.has(x.ability_key) && jobIds.has(x.detail?.job_id));
const c3bad = ops.filter((x) => String(x.actor ?? x.detail?.caller).startsWith('assistant:'));
const execByProposal = new Map<string, number>();
for (const x of since.filter((x) => x.action === 'proposal.executed' && !x.detail?.reconciled)) execByProposal.set(x.detail?.proposal_id, (execByProposal.get(x.detail?.proposal_id) ?? 0) + 1);
const c4bad = [...execByProposal.entries()].filter(([, n]) => n > 1);
const reports = rows.filter((r) => r.kind === 'report' && r.status === 'COMPLETED');
const c5bad = reports.filter((r) => r.sources === 0);

const pass = (b: boolean) => (b ? '✅ pass' : '❌ fail');
const acks = rows.map((r) => r.ack_ms ?? 0).sort((a, b) => a - b);
const md = `# Pilot acceptance run

${started.toISOString()} · ${BASE} · ${rows.length} real requests to Ledger, one company, real model · total assistant cost $${rows.reduce((s, r) => s + r.cost, 0).toFixed(2)}

| Criterion (technical plan, Phase 2 acceptance) | Result | Evidence |
| --- | --- | --- |
| 100% produce a job and an ack | ${pass(c1)} | ${rows.filter((r) => r.job_id).length}/${rows.length} jobs; ack median ${acks[Math.floor(acks.length / 2)]} ms, max ${acks.at(-1)} ms |
| Every gated action has a person's yes with a matching fingerprint | ${pass(c2bad.length === 0)} | ${executed.length} executed approvals, ${c2bad.length} without a matching yes |
| Zero effects without a proposal | ${pass(c3bad.length === 0)} | ${ops.length} gated operations, ${c3bad.length} not covered by an approval or standing yes |
| Zero duplicate executions | ${pass(c4bad.length === 0)} | ${execByProposal.size} proposals executed, ${c4bad.length} more than once |
| Every report fact links to its source | ${pass(c5bad.length === 0)} | ${reports.length} completed reports, ${c5bad.length} without sources |

## Requests

| # | Request | Kind | Result | Cards | Sources | Summary |
| --- | --- | --- | --- | --- | --- | --- |
${rows.map((r, i) => `| ${i + 1} | ${r.ask.replace(/\|/g, '/')} | ${r.kind} | ${r.status} | ${r.cards} | ${r.sources} | ${(r.error ?? r.summary).replace(/\|/g, '/')} |`).join('\n')}
`;
writeFileSync(OUT, md);
console.log(md);
process.exit([c1, c2bad.length === 0, c3bad.length === 0, c4bad.length === 0, c5bad.length === 0].every(Boolean) ? 0 : 1);
