// Turns the switched-on list into the assistant's tools. "Off" means two
// things at once: the assistant is not shown it, and the gate refuses it.

import { strictest, type Manifest, type ManifestAbility, type Setting } from '@neop/contracts';
import type { Borrowed } from './borrowed.ts';
import type { EffectiveBoard } from './switchboard.ts';

export interface ToolSpec {
  /** Model-facing name: dots are not allowed in tool names, so `a.b.c` → `a__b__c`. */
  name: string;
  key: string;
  version: string;
  title: string;
  description: string;
  kind: 'read' | 'write' | 'builtin' | 'borrowed';
  setting: Setting;
  input: Record<string, unknown>;
}

const CARD_SCHEMA = {
  type: 'object',
  description: 'The card a person will see before saying yes.',
  required: ['what', 'why', 'changes', 'if_no_answer'],
  properties: {
    what: { type: 'string', description: 'What you want to do, in one line.' },
    why: { type: 'string', description: 'Why it is needed.' },
    changes: { type: 'string', description: 'What it will change, concretely.' },
    if_no_answer: { type: 'string', description: 'What happens if nobody answers before it expires.' },
  },
  additionalProperties: false,
};

export const BUILTIN_TOOLS: Record<string, Omit<ToolSpec, 'name' | 'key' | 'version' | 'setting'>> = {
  'book.note': {
    title: 'Write a note in the record book',
    description: 'Record a step or a fact in the book. Every fact must say where it came from.',
    kind: 'builtin',
    input: {
      type: 'object',
      required: ['text'],
      properties: {
        text: { type: 'string' },
        facts: {
          type: 'array',
          items: {
            type: 'object',
            required: ['subject', 'value', 'source'],
            properties: {
              subject: { type: 'string' },
              value: {},
              source: { type: 'string' },
              valid_until: { type: 'string', description: 'ISO 8601 date-time after which the fact no longer holds (optional)' },
            },
          },
        },
      },
    },
  },
  'card.raise': {
    title: 'Raise a card for a person',
    description:
      'Tell a person something they should see: a heads-up, or a question when the request is unclear, two facts disagree, or the job has grown much larger. This does not approve anything.',
    kind: 'builtin',
    input: {
      type: 'object',
      required: ['kind', 'text'],
      properties: { kind: { type: 'string', enum: ['heads_up', 'question'] }, text: { type: 'string' } },
    },
  },
  'job.wait_until': {
    title: 'Wait until a time, then carry on',
    description:
      'Park this job until a date-time (ISO 8601, within 31 days), e.g. to check again after a due date. The job is woken then with your reason. Nothing happens meanwhile.',
    kind: 'builtin',
    input: {
      type: 'object',
      required: ['at', 'reason'],
      properties: { at: { type: 'string', description: 'ISO 8601 date-time with offset' }, reason: { type: 'string' } },
    },
  },
  'job.ask': {
    title: 'Ask for something you need, and wait',
    description:
      'When the book and your tools cannot give you something you need, ask ONE structured question: what you need (text), why (why), and the fields to fill. For a change that lacks inputs, name the change in for_ability and pass what you already have in known: every required input still missing is added to the question for you. The job waits for the answer (default 48 hours, at most 14 days) and you are woken with it. Do not guess and do not ask twice.',
    kind: 'builtin',
    input: {
      type: 'object',
      required: ['text', 'why', 'fields'],
      properties: {
        text: { type: 'string', description: 'What you need, as a question to a person.' },
        why: { type: 'string', description: 'Why you need it.' },
        fields: {
          type: 'array',
          description: 'The answers you need, one per field. Empty: one free-text answer.',
          items: {
            type: 'object',
            required: ['key', 'label'],
            properties: {
              key: { type: 'string', description: 'lower_snake_case' },
              label: { type: 'string' },
              type: { type: 'string', enum: ['text', 'number', 'date', 'boolean'] },
              required: { type: 'boolean' },
            },
          },
        },
        due_in_hours: { type: 'number', description: 'How long to wait for an answer (default 48, at most 336).' },
        for_ability: { type: 'string', description: 'The write tool this question is for, when a change lacks inputs: its required inputs still missing are added to the fields.' },
        known: { type: 'object', description: 'The inputs of that write you already have (name → value): they are not asked again.' },
      },
    },
  },
  'job.finish': {
    title: 'Finish the job and report',
    description:
      'End the job with a report: what you did, what changed, what you could not do, and where facts came from. To get something you need from a person, ask with job_ask instead; use needs_input only when asking is impossible.',
    kind: 'builtin',
    input: {
      type: 'object',
      required: ['outcome', 'summary'],
      properties: {
        outcome: { type: 'string', enum: ['done', 'failed', 'blocked', 'needs_input'] },
        summary: { type: 'string' },
        changed: { type: 'array', items: { type: 'string' } },
        could_not: { type: 'array', items: { type: 'string' } },
        sources: { type: 'array', items: { type: 'string' } },
      },
    },
  },
};

/**
 * v3 §4: doors are switchboard lines (`door:<key>`, on/off; floor from the manifest door, default on).
 * The doors an ability needs that are off here: such an ability is not shown, and the gate refuses it by name.
 */
export function offDoors(manifest: Pick<Manifest, 'doors'>, board: Pick<EffectiveBoard, 'hostSetting'>, ability: Pick<ManifestAbility, 'doors'>): string[] {
  return (ability.doors ?? []).filter((d) => strictest(manifest.doors?.find((x) => x.key === d)?.floor === 'off' ? 'off' : 'on', board.hostSetting(`door:${d}`)) === 'off');
}

export function toolName(key: string): string {
  return key.replaceAll('.', '__');
}

export function buildTools(
  manifest: Manifest,
  board: EffectiveBoard,
  borrowed: Borrowed[] = [],
  a2aTargets: string[] = [],
  packaged: ManifestAbility[] = [],
): ToolSpec[] {
  const out: ToolSpec[] = [];
  for (const b of borrowed) {
    if (b.setting === 'off') continue;
    const write = b.ability.kind === 'write';
    out.push({
      name: toolName(b.key),
      key: b.key,
      version: b.ability.version,
      title: `${b.ability.title} (from ${b.owner})`,
      description: write
        ? `Borrowed from the ${b.owner} app: one step in its subject. Using it hands this step to ${b.owner} as a task — its own switchboard and a person's yes there apply — and this job waits for its result. It does not do the thing here. ${b.ability.description}`
        : `Borrowed from the ${b.owner} app, answered by that app. ${b.ability.description}`,
      kind: 'borrowed',
      setting: 'on',
      input: b.ability.input,
    });
  }
  if (a2aTargets.length) {
    out.push({
      name: toolName('a2a.request'),
      key: 'a2a.request',
      version: '1',
      title: 'Hand a task to another app',
      description:
        'Ask another app to do multi-step work in its own subject. The job waits and is woken with that app\'s typed result. Anything with an effect there still needs a person\'s yes in that app.',
      kind: 'builtin',
      setting: 'on',
      input: { type: 'object', required: ['app', 'ask'], properties: { app: { type: 'string', enum: a2aTargets }, ask: { type: 'string', minLength: 3, maxLength: 4000 } } },
    });
  }
  for (const a of [...manifest.abilities, ...packaged]) {
    const setting = board.setting(a);
    if (setting === 'off' || offDoors(manifest, board, a).length) continue;
    let input = a.input;
    let description = a.description;
    if (a.kind === 'write' && setting === 'ask_first') {
      const props = { ...((a.input.properties as Record<string, unknown>) ?? {}), card: CARD_SCHEMA };
      const required = [...(((a.input.required as string[]) ?? [])), 'card'];
      input = { ...a.input, properties: props, required };
      description = `ASK FIRST — using this writes a proposal for a person to approve; it does not do the thing. ${description}`;
    }
    out.push({ name: toolName(a.key), key: a.key, version: a.version, title: a.title, description, kind: a.kind, setting, input });
  }
  for (const [key, t] of Object.entries(BUILTIN_TOOLS)) {
    out.push({ name: toolName(key), key, version: '1', setting: 'on', ...t });
  }
  return out;
}
