import type { Setting } from './setting.ts';

export interface AbilityEffects {
  /** True when the effect leaves the company (email, post, payment). */
  external?: boolean;
  /** JSON pointer to a list of recipient addresses in args. */
  recipients?: string;
  /** JSON pointer to an integer amount in minor units in args. */
  amount_minor?: string;
  /** JSON pointer to an ISO currency code in args, or a fixed code. */
  currency?: string;
  /** The ability moves or books money: a call whose amount cannot be measured is refused. */
  money?: boolean;
}

export interface ManifestAbility {
  key: string;
  version: string;
  title: string;
  description: string;
  kind: 'read' | 'write';
  floor: Setting;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  effects?: AbilityEffects;
  /** How a write is verified after it runs. */
  verifyWith?: string;
  doors?: string[];
}

export interface Manifest {
  app: string;
  name: string;
  subject: string;
  description: string;
  version: string;
  contract_version: string;
  abilities: ManifestAbility[];
  doors: { key: string; scopes: string[] }[];
  /**
   * Borrowed abilities (reads, called through the gateway) and a2a hand-offs
   * (`ability: "tasks.open"`: this app may hand whole tasks to that app).
   */
  uses: { app: string; ability: string; range: string; floor?: Setting }[];
  skills: { key: string; path: string; requires: string[] }[];
  packages: { key: string; version: string }[];
  blocks: string[];
}

/** Resolve an RFC 6901 JSON pointer against a value. */
export function getPointer(value: unknown, pointer: string): unknown {
  if (pointer === '' || pointer === '/') return value;
  if (!pointer.startsWith('/')) return undefined;
  let cur: unknown = value;
  for (const raw of pointer.slice(1).split('/')) {
    const part = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}
