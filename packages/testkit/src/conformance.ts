// The bar every app cut from the template must pass (R14). The template owns
// these tests; an app supplies only fixtures. The platform registers an app on
// green, not on promises.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootPilot, type AppUnderTest, type Pilot } from './pilot.ts';
import { toolName } from '@neop/template';

export interface ConformanceFixture {
  app: () => Promise<AppUnderTest>;
  /** Other apps this app needs installed (e.g. the owner of what it borrows). */
  companions?: () => Promise<AppUnderTest[]>;
  /** Sample arguments for every read ability. */
  reads: Record<string, unknown>;
  /** One ask-first write, with a sample call. */
  gatedWrite: { key: string; args: Record<string, unknown> };
}

const CARD = { what: 'Conformance check', why: 'template bar', changes: 'one effect', if_no_answer: 'nothing happens' };

export function conformance(f: ConformanceFixture): void {
  let P: Pilot;
  let key = '';
  beforeAll(async () => {
    const app = await f.app();
    key = app.def.manifest.app;
    P = await bootPilot({ apps: [app, ...((await f.companions?.()) ?? [])] });
  });
  afterAll(async () => P?.close());

  const read = (k: string, args: unknown, token?: string) => P.api('POST', `/api/apps/${key}/read/${k}`, args, token);

  describe('conformance: contract', () => {
    it('declares every handler and only declared handlers; reads are never ask-first', () => {
      const m = P.backend.core.manifest;
      expect(Object.keys(P.backend.core.app.abilities).sort()).toEqual(m.abilities.map((a) => a.key).sort());
      for (const a of m.abilities) {
        expect(a.version).toMatch(/^\d+\.\d+\.\d+$/);
        if (a.kind === 'read') expect(a.floor).not.toBe('ask_first');
        if (a.effects?.external) expect(a.floor).not.toBe('on');
      }
    });

    it('covers every read with a sample, and every result matches its schema', async () => {
      const reads = P.backend.core.manifest.abilities.filter((a) => a.kind === 'read').map((a) => a.key);
      expect(Object.keys(f.reads).sort()).toEqual(reads.sort());
      for (const [k, args] of Object.entries(f.reads)) {
        const r = await read(k, args);
        expect(r.status, `${k}: ${JSON.stringify(r.body)}`).toBe(200);
        expect(P.backend.core.validators.checkOutput(k, r.body.result)).toBeNull();
      }
    });
  });

  describe('conformance: honesty', () => {
    it('every read says when it was generated, whether it is empty, and what it came from', async () => {
      for (const [k, args] of Object.entries(f.reads)) {
        const r = (await read(k, args)).body.result;
        expect(Date.parse(r.generatedAt), k).not.toBeNaN();
        expect(typeof r.empty, k).toBe('boolean');
        expect(r.sources?.basis, k).toBeTruthy();
      }
    });
  });

  describe('conformance: tenant', () => {
    it('another company sees none of this company’s rows', async () => {
      const B = await P.platform.createCompany(`Other ${randomUUID().slice(0, 6)}`);
      const bu = await P.platform.createUser(B.id, { name: 'B', email: 'b@other.example', role: 'admin' });
      await P.platform.installApp(B.id, key);
      for (const [k, args] of Object.entries(f.reads)) {
        const r = await read(k, args, bu.token);
        expect(r.status).toBe(200);
        expect(r.body.result.empty, k).toBe(true);
      }
    });
  });

  describe('conformance: switchboard', () => {
    it('off = not shown and refused; a company cannot loosen the floor', async () => {
      const first = Object.keys(f.reads)[0]!;
      let tools: string[] = [];
      P.setBrain((v) => {
        tools = v.tools;
        return { tool: toolName('job.finish'), args: { outcome: 'done', summary: 'ok' } };
      });
      const loosen = await P.api('PUT', `/api/switchboards/${key}`, { settings: { [f.gatedWrite.key]: 'on' } });
      expect(loosen.status).toBe(422);
      await P.api('PUT', `/api/switchboards/${key}`, { settings: { [first]: 'off' } });
      const t = await P.ask('conformance: what can you do?', undefined, key);
      await P.waitFor(async () => (await P.task(t.task_id)).task.status === 'COMPLETED', 'done');
      expect(tools).not.toContain(toolName(first));
      expect((await read(first, f.reads[first])).status).toBe(403);
      await P.api('PUT', `/api/switchboards/${key}`, { settings: { [first]: 'on' } });
    });
  });

  describe('conformance: proposal', () => {
    it('an ask-first write becomes a card; a yes carries it out once; the assistant reports proof', async () => {
      let woken = '';
      P.setBrain((v) => {
        if (v.job.includes('WOKEN')) {
          woken = v.job;
          return { tool: toolName('job.finish'), args: { outcome: 'done', summary: 'verified' } };
        }
        return v.calls === 0 ? { tool: toolName(f.gatedWrite.key), args: { ...f.gatedWrite.args, card: CARD } } : { text: 'waiting' };
      });
      const t = await P.ask(`conformance: ${f.gatedWrite.key}`, undefined, key);
      const card = await P.waitFor(async () => (await P.desk()).find((c) => c.task_id === t.task_id && c.status === 'PENDING'), 'card');
      expect(card.ability_key).toBe(f.gatedWrite.key);
      const ops0 = (await P.backend.core.runnerPool.query(`select count(*)::int as n from ${key}.operations where ability_key = $1`, [f.gatedWrite.key])).rows[0].n;
      expect(ops0).toBe(0);
      await P.api('POST', `/api/desk/${card.id}/answer`, { decision: 'yes', fingerprint_seen: card.fingerprint });
      await P.waitFor(async () => (await P.task(t.task_id)).task.status === 'COMPLETED', 'completed');
      expect(woken).toContain('is now DONE');
      const ops = (await P.backend.core.runnerPool.query(`select count(*)::int as n from ${key}.operations where ability_key = $1`, [f.gatedWrite.key])).rows[0].n;
      expect(ops).toBe(1);
      const trail = (await P.backend.core.runnerPool.query(`select event from ${key}.proposal_events where proposal_id = $1 order by id`, [card.proposal_id])).rows.map((r) => r.event);
      expect(trail).toEqual(['proposed', 'answered:yes', 'executing', 'executed:DONE', 'resumed', 'reported']);
    });
  });

  describe('conformance: inbound auth and job tokens', () => {
    it('refuses unsigned L3 calls and gate calls without a job token', async () => {
      const l3 = await fetch(`http://127.0.0.1:${P.backend.ports.l3}/l3/tasks.open`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'contract-version': '1' },
        body: JSON.stringify({ task_id: randomUUID(), ask: 'x', requester: 'user:x' }),
      });
      expect(l3.status).toBe(401);
      const gate = await fetch(`http://127.0.0.1:${P.backend.ports.gate}/gate/call`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tool: Object.keys(f.reads)[0], args: {} }),
      });
      expect(gate.status).toBe(401);
    });
  });
}
