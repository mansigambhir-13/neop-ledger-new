// Company rules as data, not code (plan §Gate & policy). A closed set evaluated
// by the template; new rule types are template releases. Pure: no I/O.

export type RuleScope = 'all' | 'external' | string[];

export type Rule =
  | { id: string; type: 'time_window'; days: number[]; from: string; to: string; applies_to?: RuleScope }
  | { id: string; type: 'destination'; mode: 'internal_only' | 'allow_list'; domains: string[]; applies_to?: RuleScope }
  | {
      id: string;
      type: 'amount_cap';
      currency: string;
      per_call_minor?: number;
      per_day_minor?: number;
      per_month_minor?: number;
      applies_to?: RuleScope;
    }
  | { id: string; type: 'recipient_cap'; max: number; applies_to?: RuleScope }
  | { id: string; type: 'require_person'; abilities: string[] };

export const RULE_TYPES = ['time_window', 'destination', 'amount_cap', 'recipient_cap', 'require_person'] as const;

export interface RuleSubject {
  ability_key: string;
  external: boolean;
  amount_minor?: number;
  currency?: string;
  recipients?: string[];
}

export interface RuleUsage {
  /** Amount already spent today / this month (company time zone), same currency as the rule. */
  day_minor: number;
  month_minor: number;
}

export interface RuleViolation {
  rule_id: string;
  type: Rule['type'];
  reason: string;
}

function applies(scope: RuleScope | undefined, s: RuleSubject): boolean {
  if (!scope || scope === 'external') return s.external;
  if (scope === 'all') return true;
  return scope.includes(s.ability_key);
}

/** Local wall-clock parts for an instant in a time zone. */
export function zonedParts(at: Date, timeZone: string): { isoDay: number; hhmm: string; ymd: string; ym: string } {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const parts = Object.fromEntries(fmt.formatToParts(at).map((p) => [p.type, p.value]));
  const days: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  return {
    isoDay: days[parts.weekday!]!,
    hhmm: `${parts.hour}:${parts.minute}`,
    ymd: `${parts.year}-${parts.month}-${parts.day}`,
    ym: `${parts.year}-${parts.month}`,
  };
}

function domainOf(addr: string): string {
  return addr.split('@').pop()!.trim().toLowerCase();
}

/** Abilities a require_person rule forces to ask-first. */
export function forcedAskFirst(rules: Rule[], abilityKey: string): boolean {
  return rules.some((r) => r.type === 'require_person' && r.abilities.includes(abilityKey));
}

/** First violated rule, or null. Checked by the gate before a call and again at execute time. */
export function checkRules(rules: Rule[], s: RuleSubject, at: Date, timeZone: string, usage: RuleUsage): RuleViolation | null {
  for (const r of rules) {
    if (r.type === 'require_person') continue;
    if (!applies(r.applies_to, s)) continue;
    switch (r.type) {
      case 'time_window': {
        const p = zonedParts(at, timeZone);
        if (!r.days.includes(p.isoDay) || p.hhmm < r.from || p.hhmm >= r.to) {
          return { rule_id: r.id, type: r.type, reason: `outside the allowed window (${r.from}–${r.to}, days ${r.days.join(',')}, ${timeZone})` };
        }
        break;
      }
      case 'destination': {
        const bad = (s.recipients ?? []).filter((a) => !r.domains.map((d) => d.toLowerCase()).includes(domainOf(a)));
        if (bad.length) {
          return { rule_id: r.id, type: r.type, reason: `destination not allowed: ${bad.join(', ')}` };
        }
        break;
      }
      case 'recipient_cap': {
        const n = s.recipients?.length ?? 0;
        if (n > r.max) return { rule_id: r.id, type: r.type, reason: `${n} recipients exceeds the cap of ${r.max}` };
        break;
      }
      case 'amount_cap': {
        if (s.amount_minor === undefined) break;
        if (s.currency && s.currency !== r.currency) break;
        if (r.per_call_minor !== undefined && s.amount_minor > r.per_call_minor) {
          return { rule_id: r.id, type: r.type, reason: `amount ${s.amount_minor} exceeds per-call cap ${r.per_call_minor} ${r.currency}` };
        }
        if (r.per_day_minor !== undefined && usage.day_minor + s.amount_minor > r.per_day_minor) {
          return { rule_id: r.id, type: r.type, reason: `would exceed the daily cap ${r.per_day_minor} ${r.currency}` };
        }
        if (r.per_month_minor !== undefined && usage.month_minor + s.amount_minor > r.per_month_minor) {
          return { rule_id: r.id, type: r.type, reason: `would exceed the monthly cap ${r.per_month_minor} ${r.currency}` };
        }
        break;
      }
    }
  }
  return null;
}

/** Validate rules arriving from the platform; unknown types are refused, not ignored. */
export function parseRules(raw: unknown): Rule[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((r, i) => {
    if (!r || typeof r !== 'object' || !('type' in r) || !(RULE_TYPES as readonly string[]).includes((r as any).type)) {
      throw new Error(`rule ${i}: unknown rule type`);
    }
    if (typeof (r as any).id !== 'string') throw new Error(`rule ${i}: id required`);
    return r as Rule;
  });
}
