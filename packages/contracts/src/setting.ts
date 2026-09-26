/** Three settings, ordered strictest first. */
export const SETTINGS = ['off', 'ask_first', 'on'] as const;
export type Setting = (typeof SETTINGS)[number];

const RANK: Record<Setting, number> = { off: 0, ask_first: 1, on: 2 };

export function isSetting(v: unknown): v is Setting {
  return typeof v === 'string' && (SETTINGS as readonly string[]).includes(v);
}

/** Strictest wins. Undefined inputs are ignored (nothing set at that level). */
export function strictest(...settings: (Setting | undefined | null)[]): Setting {
  let out: Setting = 'on';
  for (const s of settings) {
    if (s && RANK[s] < RANK[out]) out = s;
  }
  return out;
}
