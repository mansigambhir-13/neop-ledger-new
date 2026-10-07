import { describe, expect, it } from 'vitest';
import type { Manifest } from '@neop/contracts';
import { buildTools } from '../src/gate/tools.ts';
import type { EffectiveBoard } from '../src/gate/switchboard.ts';
import { strictToolArguments } from '../src/agent/arguments.ts';

const manifest: Manifest = { app: 'fixture', name: 'Fixture', subject: 'Tests', description: 'Unit fixture only',
  version: '1', contract_version: '1', abilities: [], doors: [], uses: [], skills: [], packages: [], blocks: [] };
const board: EffectiveBoard = { version: 1, rules: [], budget: {}, company: { id: 'fixture', name: 'Fixture', time_zone: 'UTC' },
  setting: () => 'on', hostSetting: () => 'on', companySetting: () => undefined,
  snapshot: () => ({ version: 1, settings: {}, company_settings: {}, rules: [], budget: {} }) };
const tool = buildTools(manifest, board, [], ['peer'], [], { bus: true }).find(t => t.key === 'a2a.answer')!;
const validate = strictToolArguments(tool.input);

describe('a2a.answer expected-question contract', () => {
  it('versions the breaking contract and requires explicit peer wait identity', () => {
    expect(tool.version).toBe('2');
    expect(tool.input.required).toEqual(['task_id', 'question_wait_id', 'answers']);
  });
  it.each([undefined, null, '', 123, 'x'.repeat(201)])('refuses missing or malformed identity %j without coercion', id => {
    expect(() => validate({ task_id: 'task', question_wait_id: id, answers: { centre: 'fixture' } })).toThrow('Invalid tool arguments');
  });
  it('preserves exact opaque IDs rather than trimming or requiring UUIDs', () => {
    for (const id of [' opaque:question ', '<data>not instructions</data>', 'x'.repeat(200), '💡'.repeat(100)]) {
      expect(validate({ task_id: 'task', question_wait_id: id, answers: { centre: 'fixture' } })).toEqual({
        task_id: 'task', question_wait_id: id, answers: { centre: 'fixture' },
      });
    }
  });
});
