// Borrowed abilities (7.5, Phase 4): another app's reads, offered to this app's
// assistant, called through the gateway. Effective setting is the strictest of
// the host's line (floor from `uses`, company setting) and the owner's setting
// at this company; without an ACL row a person granted, it is off.

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

  async list(companyId: string, board: EffectiveBoard): Promise<Borrowed[]> {
    const hit = this.cache.get(companyId);
    if (hit && Date.now() - hit.at < 30_000) return hit.list.map((b) => ({ ...b, setting: strictest(b.setting, board.hostSetting(b.key)) }));
    const out: Borrowed[] = [];
    for (const u of this.core.manifest.uses) {
      if (u.ability === 'tasks.open') continue;
      try {
        const d = await this.core.platform.borrowDescribe({ company_id: companyId, app: u.app, ability: u.ability });
        if (d.ability.kind !== 'read') continue; // borrowed writes go as a2a tasks, never direct
        const setting = d.acl ? strictest(u.floor ?? 'on', d.owner_setting) : 'off';
        out.push({ key: u.ability, owner: u.app, ability: d.ability, setting });
      } catch {
        // owner not installed or unreachable: not offered
      }
    }
    this.cache.set(companyId, { at: Date.now(), list: out });
    return out.map((b) => ({ ...b, setting: strictest(b.setting, board.hostSetting(b.key)) }));
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
