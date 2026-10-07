// Borrowed abilities (v3 §10, S6; the only road since S9): another app's abilities offered to this app's assistant,
// asked for over the company's bus room (gate/a2a.ts → runner/bus.ts). The owner's contract comes from the registry
// schema (neos_registry.abilities); the line is this app's own on its switchboard — off until the company sets it, never
// looser than the `uses` floor. The owner checks its own line (and its person's yes, for a write) when the ask arrives.

import { strictest, type ManifestAbility, type Setting } from '@neop/contracts';
import { Ajv, type ValidateFunction } from 'ajv';
import addFormatsModule from 'ajv-formats';
import type { Core } from '../core.ts';
import type { EffectiveBoard } from './switchboard.ts';

const addFormats = addFormatsModule as unknown as (a: Ajv) => Ajv;

export interface Borrowed {
  key: string;
  owner: string;
  ability: ManifestAbility;
  setting: Setting;
}

export class BorrowCache {
  private cache = new Map<string, { at: number; list: Borrowed[] }>();
  private ajv = new Ajv({ allErrors: true, strict: false });
  private compiled = new Map<string, { input: ValidateFunction; output: ValidateFunction }>();
  readonly core: Core;
  constructor(core: Core) {
    this.core = core;
    addFormats(this.ajv);
  }

  /** a2a hand-off targets this app may use (`uses: [{ability: 'tasks.open'}]`). */
  a2aTargets(): string[] {
    return this.core.manifest.uses.filter((u) => u.ability === 'tasks.open').map((u) => u.app);
  }

  /**
   * v3 §10 (S6/S9): no platform call and no ACL. The owner's contract is read from the registry schema
   * (neos_registry.abilities, A6); the line is this app's own borrowed line on its own switchboard — off until the
   * company sets it (the desk: "Marketing wants to be able to ask Ledger for …"), never looser than the `uses` floor.
   * What a pinned skill or an installed package requires from another app (packages.lock.json) is borrowable the same
   * way, without a manifest `uses` line: the pin is in the build, the company's line is the authority. The owner's own
   * line is the owner's to check when the ask arrives (three checks, one ask).
   */
  async list(companyId: string, board: EffectiveBoard): Promise<Borrowed[]> {
    const hit = this.cache.get(companyId);
    const eff = (list: Borrowed[]) =>
      list.map((b) => {
        const own = board.companySetting(b.key);
        return { ...b, setting: own === undefined ? ('off' as Setting) : strictest(b.setting, own) };
      });
    if (hit && Date.now() - hit.at < 30_000) return eff(hit.list);
    const own = new Set(this.core.manifest.abilities.map((a) => a.key));
    const uses: { app: string | null; ability: string; floor?: Setting }[] = this.core.manifest.uses.filter((u) => u.ability !== 'tasks.open');
    for (const key of this.core.packages.requires()) {
      if (!own.has(key) && !uses.some((u) => u.ability === key)) uses.push({ app: null, ability: key });
    }
    const out: Borrowed[] = [];
    if (uses.length) {
      const rows = await this.core.runnerPool
        .query<{ app: string; ability: string; version: string; title: string; description: string; kind: 'read' | 'write'; floor: Setting; doors: string[]; input: any; output: any }>(
          `select app, ability, version, title, description, kind, floor, doors, input, output from neos_registry.abilities
            where app <> $2 and ability = any($1::text[]) order by app`,
          [uses.map((u) => u.ability), this.core.key],
        )
        .then((r) => r.rows)
        .catch((e) => {
          this.core.log('registry unavailable; nothing borrowed', { e: String(e?.message ?? e).slice(0, 200) });
          return [];
        });
      for (const u of uses) {
        // A `uses` line names its owner; a pinned requirement is whoever offers it in the registry (the first by key).
        const a = rows.find((r) => (u.app ? r.app === u.app : true) && r.ability === u.ability);
        if (!a) continue; // the owner is not registered (or no longer offers it): not offered
        const ability: ManifestAbility = { key: a.ability, version: a.version, title: a.title, description: a.description, kind: a.kind, floor: a.floor, input: a.input ?? {}, output: a.output ?? {}, ...(Array.isArray(a.doors) && a.doors.length ? { doors: a.doors } : {}) } as ManifestAbility;
        out.push({ key: u.ability, owner: a.app, ability, setting: (u.floor ?? 'on') as Setting });
      }
    }
    this.cache.set(companyId, { at: Date.now(), list: out });
    return eff(out);
  }

  invalidate(companyId: string): void {
    this.cache.delete(companyId);
  }

  validators(b: Borrowed): { input: ValidateFunction; output: ValidateFunction } {
    const k = `${b.owner}:${b.key}:${b.ability.version}`;
    let v = this.compiled.get(k);
    if (!v) {
      v = { input: this.ajv.compile(b.ability.input), output: this.ajv.compile(b.ability.output) };
      this.compiled.set(k, v);
    }
    return v;
  }

  errors(v: ValidateFunction): string {
    return this.ajv.errorsText(v.errors);
  }
}
