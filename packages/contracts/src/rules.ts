// Company rules: one strict shape check shared by the platform (when an admin saves the
// switchboard) and the app (when the gate loads it). A rule the gate cannot read is
// refused at the door, not discovered by the next job.

export const RULE_TYPES = ['time_window', 'destination', 'amount_cap', 'recipient_cap', 'require_person'] as const;
export type RuleType = (typeof RULE_TYPES)[number];

const isInt = (v: unknown) => Number.isInteger(v) && (v as number) > 0;
const isHHMM = (v: unknown) => typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v);
const isScope = (v: unknown) => v === undefined || v === 'all' || v === 'external' || (Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string'));

/** Why this rule is not acceptable, or null if it is. `known` lists the app's ability keys, if checked. */
export function ruleProblem(r: unknown, known?: readonly string[]): string | null {
  if (!r || typeof r !== 'object') return 'a rule must be an object';
  const x = r as Record<string, any>;
  if (!(RULE_TYPES as readonly string[]).includes(x.type)) return `unknown rule type ${JSON.stringify(x.type)}`;
  if (typeof x.id !== 'string' || !/^[a-z0-9][a-z0-9_.-]{0,62}$/i.test(x.id)) return 'id must be a short name (letters, digits, - _ .)';
  if (x.type !== 'require_person' && !isScope(x.applies_to)) return 'applies_to must be "all", "external" or a list of ability keys';
  const unknownKeys = (keys: unknown) => (known && Array.isArray(keys) ? keys.filter((k) => !known.includes(k)) : []);
  switch (x.type as RuleType) {
    case 'time_window':
      if (!Array.isArray(x.days) || !x.days.length || x.days.some((d: unknown) => !Number.isInteger(d) || (d as number) < 1 || (d as number) > 7)) return 'days must list ISO weekdays 1 (Mon) to 7 (Sun)';
      if (!isHHMM(x.from) || !isHHMM(x.to)) return 'from and to must be HH:MM';
      if (x.from >= x.to) return 'from must be before to';
      break;
    case 'destination':
      if (!['internal_only', 'allow_list'].includes(x.mode)) return 'mode must be internal_only or allow_list';
      if (!Array.isArray(x.domains) || x.domains.some((d: unknown) => typeof d !== 'string' || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(d as string))) return 'domains must be a list of domain names';
      if (x.mode === 'allow_list' && !x.domains.length) return 'an allow-list needs at least one domain';
      break;
    case 'amount_cap':
      if (typeof x.currency !== 'string' || !/^[A-Z]{3}$/.test(x.currency)) return 'currency must be an ISO code such as INR';
      if (![x.per_call_minor, x.per_day_minor, x.per_month_minor].some((v) => v !== undefined)) return 'set at least one of per call, per day, per month';
      for (const k of ['per_call_minor', 'per_day_minor', 'per_month_minor']) if (x[k] !== undefined && !isInt(x[k])) return `${k} must be a positive whole number of minor units`;
      break;
    case 'recipient_cap':
      if (!isInt(x.max)) return 'max must be a positive whole number';
      break;
    case 'require_person':
      if (!Array.isArray(x.abilities) || !x.abilities.length || x.abilities.some((k: unknown) => typeof k !== 'string')) return 'abilities must list ability keys';
      break;
  }
  const bad = unknownKeys(x.type === 'require_person' ? x.abilities : x.applies_to);
  if (bad.length) return `not abilities of this app: ${bad.join(', ')}`;
  return null;
}

/** Check a whole rule list: shapes, and ids unique. Returns the first problem, or null. */
export function rulesProblem(rules: unknown, known?: readonly string[]): string | null {
  if (!Array.isArray(rules)) return 'rules must be a list';
  const ids = new Set<string>();
  for (let i = 0; i < rules.length; i++) {
    const p = ruleProblem(rules[i], known);
    if (p) return `rule ${i + 1}: ${p}`;
    const id = (rules[i] as { id: string }).id;
    if (ids.has(id)) return `rule ${i + 1}: id ${id} is used twice`;
    ids.add(id);
  }
  return null;
}
