// One structured question (WP §8 `ask` / `answer`, §14 "WHEN YOU NEED SOMETHING YOU DO NOT HAVE"):
// what is needed, why, and the fields. The same checks run in the gate (asking), in the app's
// waits.answer (the truth) and on the platform (early, friendlier errors).

import { QUESTION_FIELD_TYPES, type QuestionField, type QuestionFieldType } from './events.ts';

export interface Question {
  text: string;
  why: string;
  fields: QuestionField[];
}

export const QUESTION_LIMITS = { text: 2000, why: 2000, fields: 10, label: 200, value: 4000, dueDefaultHours: 48, dueMaxHours: 14 * 24 };
const KEY = /^[a-z][a-z0-9_]{0,39}$/;

/** Checks and normalises a question; no fields means one free-text field, `answer`. */
export function normalizeQuestion(q: any): { question: Question } | { error: string } {
  if (!q || typeof q !== 'object') return { error: 'text, why and fields are required' };
  const text = typeof q.text === 'string' ? q.text.trim() : '';
  const why = typeof q.why === 'string' ? q.why.trim() : '';
  if (!text || text.length > QUESTION_LIMITS.text) return { error: `text (1..${QUESTION_LIMITS.text} chars) is required: what you need` };
  if (!why || why.length > QUESTION_LIMITS.why) return { error: `why (1..${QUESTION_LIMITS.why} chars) is required: why you need it` };
  if (q.fields !== undefined && !Array.isArray(q.fields)) return { error: 'fields must be an array' };
  const raw: any[] = q.fields ?? [];
  if (raw.length > QUESTION_LIMITS.fields) return { error: `at most ${QUESTION_LIMITS.fields} fields` };
  const fields: QuestionField[] = [];
  for (const f of raw) {
    if (!f || typeof f !== 'object' || typeof f.key !== 'string' || !KEY.test(f.key)) return { error: 'every field needs a key (lower_snake_case, up to 40 chars)' };
    if (typeof f.label !== 'string' || !f.label.trim() || f.label.length > QUESTION_LIMITS.label) return { error: `field ${f.key} needs a label (1..${QUESTION_LIMITS.label} chars)` };
    if (f.type !== undefined && !QUESTION_FIELD_TYPES.includes(f.type)) return { error: `field ${f.key}: type must be one of ${QUESTION_FIELD_TYPES.join(', ')}` };
    if (f.required !== undefined && typeof f.required !== 'boolean') return { error: `field ${f.key}: required must be true or false` };
    if (fields.some((x) => x.key === f.key)) return { error: `field ${f.key} appears twice` };
    fields.push({ key: f.key, label: f.label.trim(), type: (f.type ?? 'text') as QuestionFieldType, required: f.required !== false });
  }
  if (!fields.length) fields.push({ key: 'answer', label: text.slice(0, QUESTION_LIMITS.label), type: 'text', required: true });
  return { question: { text, why, fields } };
}

/** Answers that cover every required field, with values of each field's type. Unknown keys are refused. */
export function checkAnswers(q: Question, answers: unknown): { answers: Record<string, string | number | boolean> } | { error: string } {
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) return { error: 'answers must be an object of field → value' };
  const a = answers as Record<string, unknown>;
  const byKey = new Map(q.fields.map((f) => [f.key, f]));
  const unknown = Object.keys(a).filter((k) => !byKey.has(k));
  if (unknown.length) return { error: `no such field: ${unknown.join(', ')}` };
  const out: Record<string, string | number | boolean> = {};
  for (const f of q.fields) {
    let v = a[f.key];
    if (typeof v === 'string') v = v.trim();
    const blank = v === undefined || v === null || v === '';
    if (blank) {
      if (f.required !== false) return { error: `${f.label} (${f.key}) is required` };
      continue;
    }
    switch (f.type ?? 'text') {
      case 'number': {
        const n = typeof v === 'number' ? v : typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : NaN;
        if (!Number.isFinite(n)) return { error: `${f.label} (${f.key}) must be a number` };
        out[f.key] = n;
        break;
      }
      case 'boolean': {
        const b = typeof v === 'boolean' ? v : typeof v === 'string' && /^(yes|true|no|false)$/i.test(v) ? /^(yes|true)$/i.test(v) : null;
        if (b === null) return { error: `${f.label} (${f.key}) must be yes or no` };
        out[f.key] = b;
        break;
      }
      case 'date':
        if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v))) return { error: `${f.label} (${f.key}) must be a date (YYYY-MM-DD)` };
        out[f.key] = v;
        break;
      default:
        if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') return { error: `${f.label} (${f.key}) must be text` };
        if (String(v).length > QUESTION_LIMITS.value) return { error: `${f.label} (${f.key}) is longer than ${QUESTION_LIMITS.value} characters` };
        out[f.key] = String(v);
    }
  }
  return { answers: out };
}

/** The one field a free-text reply can answer (a follow-up in the conversation, a DM reply), or null. */
export function freeTextField(q: Question): QuestionField | null {
  const required = q.fields.filter((f) => f.required !== false);
  if (required.length > 1) return null;
  return required[0] ?? (q.fields.length === 1 ? q.fields[0]! : null);
}

/**
 * Answers from a plain-text reply (a follow-up in the conversation, a reply in a DM). A question with
 * one field takes the whole text; otherwise one `key: value` (or `label: value`) per line, and a reply
 * with no such lines fills the one required field if there is exactly one. Null when the text cannot be
 * read as answers to this question.
 */
export function answersFromText(q: Question, text: string): Record<string, string> | null {
  const body = text.trim();
  if (!body) return null;
  const one = freeTextField(q);
  if (one && q.fields.length === 1) return { [one.key]: body };
  const out: Record<string, string> = {};
  for (const line of body.split(/\r?\n/)) {
    const m = /^\s*([^:=]{1,200}?)\s*[:=]\s*(.*)$/.exec(line);
    if (!m) continue;
    const name = m[1]!.trim().toLowerCase();
    const f = q.fields.find((x) => x.key === name || x.label.toLowerCase() === name);
    if (f && m[2]!.trim()) out[f.key] = m[2]!.trim();
  }
  if (Object.keys(out).length) return out;
  return one ? { [one.key]: body } : null;
}
