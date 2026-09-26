// attachments.test · a person attaches a file to an ask on the platform: it travels in the signed
// tasks.open, the app's documents door reads it (no model) into a job-bound fact, the assistant sees
// the text only as untrusted data, and the platform drops the bytes once the app has acknowledged.
import { afterAll, beforeAll, expect, it } from 'vitest';
import { bootPilot, toolName, type Pilot } from './harness.ts';

let P: Pilot;
beforeAll(async () => {
  P = await bootPilot();
});
afterAll(async () => P?.close());

const csv = 'Date,Vendor,Amount\n2026-09-12,CloudSoft India,14160.00\n2026-09-15,"Kapoor, Traders",5900.00\n';

it('an attached CSV reaches the job as extracted, untrusted text; the platform keeps no bytes', async () => {
  let seen = '';
  P.setBrain((v) => {
    seen = v.system + '\n' + v.job;
    return { tool: toolName('job.finish'), args: { outcome: 'done', summary: 'read the statement' } };
  });
  const r = await P.api('POST', '/api/ask', {
    text: 'Book these two bills from the attached sheet',
    app: 'ledger',
    attachments: [{ filename: 'bills.csv', content_type: 'text/csv', content_base64: Buffer.from(csv).toString('base64') }],
  });
  expect(r.status).toBe(200);
  const task = await P.waitFor(async () => (await P.task(r.body.task_id)).task.status === 'COMPLETED' && (await P.task(r.body.task_id)).task, 'done', 30_000);
  const facts = (await P.backend.core.runnerPool.query("select subject, value, source from ledger.facts where job_id = $1", [task.job_id])).rows;
  expect(facts).toHaveLength(1);
  expect(facts[0].subject).toBe('document:bills.csv');
  expect(facts[0].source).toMatch(/^upload:sha256:[0-9a-f]{64}$/);
  expect(JSON.stringify(facts[0].value)).toContain('Kapoor, Traders');
  expect(seen).toContain('CloudSoft India');
  expect(seen).toMatch(/trust="untrusted"/);
  const row = (await P.platform.db.query('select attachments from neos.tasks where id = $1', [r.body.task_id])).rows[0];
  expect(row.attachments).toBeNull();
});

it('refuses malformed or oversized attachments before anything is opened', async () => {
  const bad = await P.api('POST', '/api/ask', { text: 'x', app: 'ledger', attachments: [{ filename: '', content_base64: 'AA==' }] });
  expect(bad.status).toBe(400);
  const many = await P.api('POST', '/api/ask', { text: 'x', app: 'ledger', attachments: Array.from({ length: 6 }, (_, i) => ({ filename: `${i}.csv`, content_base64: 'YQ==' })) });
  expect(many.status).toBe(400);
});
