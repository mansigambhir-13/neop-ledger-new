// TEST ONLY (compose.chaos.yml): a fake model provider and a fake Resend, as one "internet" host
// the stack reaches through its egress proxy. Built from packages/testkit (the same doubles the
// suite uses): the Anthropic SSE wire format, and Resend's idempotency-key semantics.
//   :4900  /v1/messages → fake Anthropic   /emails* → fake Resend   GET /_stats, /_resend_token
// The brain is the chaos brain: "[read]" jobs read the trial balance and finish; "[gated]" jobs
// propose one close-pack email, wait for a person's yes, and verify it after they are woken.
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { fakeAnthropic } from '../../packages/testkit/src/fake-anthropic.ts';
import { fakeResend } from '../../packages/testkit/src/fake-providers.ts';

const apiKey = readFileSync(process.env.FAKE_LLM_KEY_FILE ?? '/run/secrets/llm_upstream_key', 'utf8').trim();
const llm = await fakeAnthropic({ apiKey });
const mail = await fakeResend();
const t = (key: string, args: unknown = {}) => ({ tool: key.replaceAll('.', '__'), args });
llm.setBrain((v) => {
  if (v.job.includes('WOKEN')) return v.results.length === 0 ? t('job.finish', { outcome: 'done', summary: 'verified after approval' }) : { text: 'ok' };
  const ok = v.results.filter((r) => !r.isError);
  if (v.job.includes('[gated]')) {
    return ok.length === 0 && !v.results.some((r) => r.text.includes('Proposal '))
      ? t('ledger.close_pack.email', {
          period: { from: '2026-08-01', to: '2026-08-31' },
          to: ['cfo@acme.example'],
          card: { what: 'Send the August close pack', why: 'chaos-live', changes: 'one email', if_no_answer: 'nothing is sent' },
        })
      : { text: 'waiting for the answer' };
  }
  return ok.length === 0 ? t('ledger.report.trial_balance', { as_of: '2026-09-30' }) : t('job.finish', { outcome: 'done', summary: 'trial balance read' });
});

const stats = () => {
  const keys = new Map<string, number>();
  for (const r of mail.requests) if (r.method === 'POST' && r.key) keys.set(r.key, (keys.get(r.key) ?? 0) + 1);
  return {
    llm_calls: llm.calls.length,
    emails_performed: mail.performed.length,
    distinct_email_keys: new Set(mail.performed.map((p) => p.key)).size,
    email_posts: [...keys.values()].reduce((a, b) => a + b, 0),
    email_keys_retried: [...keys.values()].filter((n) => n > 1).length,
  };
};

// One front door on :4900 relaying to the two doubles (which listen on loopback only).
createServer(async (req, res) => {
  try {
    const url = req.url ?? '/';
    if (req.method === 'GET' && url === '/_stats') return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(stats()));
    if (req.method === 'GET' && url === '/_resend_token') return void res.writeHead(200).end(mail.token);
    const base = url.startsWith('/v1/') ? llm.url : url === '/emails' || url.startsWith('/emails/') ? mail.url : null;
    if (!base) return void res.writeHead(404).end('not found');
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string' && !['host', 'content-length', 'connection', 'transfer-encoding'].includes(k)) headers[k] = v;
    const r = await fetch(base + url, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method ?? 'GET') ? undefined : Buffer.concat(chunks) });
    res.writeHead(r.status, { 'content-type': r.headers.get('content-type') ?? 'application/json' }).end(Buffer.from(await r.arrayBuffer()));
  } catch (e) {
    res.writeHead(502).end(String(e));
  }
}).listen(4900, '0.0.0.0', () => console.log('fakes on :4900 (anthropic + resend)'));

