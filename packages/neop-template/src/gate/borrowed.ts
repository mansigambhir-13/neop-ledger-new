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
  private cache = new Map<string, { at: number; list: Borrowed[]; entries?: unknown }>();
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
    if (this.core.presenceOn) return this.listFromRegistry(companyId, board);
    // v3 S7: what the build pinned (packages.lock.json) is fixed for this process; the ACL rows a person grants and
    // the owner's switch are what change, and an ACL change drops this cache (switchboard.changed).
    const hit = this.cache.get(companyId);
    if (hit && hit.entries !== 'registry' && Date.now() - hit.at < 30_000) return hit.list.map((b) => ({ ...b, setting: strictest(b.setting, board.hostSetting(b.key)) }));
    const out: Borrowed[] = [];
    const seen = new Set<string>();
    for (const u of this.core.manifest.uses) {
      if (u.ability === 'tasks.open') continue;
      seen.add(u.ability);
      try {
        const d = await this.core.platform.borrowDescribe({ company_id: companyId, app: u.app, ability: u.ability });
        // A borrowed write is offered too, but runs only as an a2a task at its owner (gate.borrow), never direct.
        const setting = d.acl ? strictest(u.floor ?? 'on', d.owner_setting) : 'off';
        out.push({ key: u.ability, owner: u.app, ability: d.ability, setting });
      } catch {
        // owner not installed or unreachable: not offered
      }
    }
    // What the pinned skills and installed packages require from other apps is borrowable without a manifest
    // `uses` line: the pin is in the build (packages.lock.json), and an ACL row a person granted is the authority.
    const own = new Set(this.core.manifest.abilities.map((a) => a.key));
    for (const key of this.core.packages.requires()) {
      if (own.has(key) || seen.has(key)) continue;
      seen.add(key);
      try {
        const d = await this.core.platform.borrowDescribe({ company_id: companyId, ability: key });
        if (d.ability.kind !== 'read' || !d.acl || !d.owner) continue;
        out.push({ key, owner: d.owner, ability: d.ability, setting: strictest('on', d.owner_setting) });
      } catch {
        // no ACL row or owner unavailable: not offered
      }
    }
    this.cache.set(companyId, { at: Date.now(), list: out });
    return out.map((b) => ({ ...b, setting: strictest(b.setting, board.hostSetting(b.key)) }));
  }

  /**
   * v3 §10 with NEOP_PRESENCE on (S6): no platform call and no neos.acl. The owner's contract is read from the
   * registry schema (neos_registry.abilities, A6); the line is this app's own `uses` line on its own switchboard —
   * off until the company sets it (the desk: "Marketing wants to be able to ask Ledger for …"), never looser than
   * the `uses` floor. The owner's own line is the owner's to check when the ask arrives (three checks, one ask).
   */
  private async listFromRegistry(companyId: string, board: EffectiveBoard): Promise<Borrowed[]> {
    const hit = this.cache.get(companyId);
    const eff = (list: Borrowed[]) =>
      list.map((b) => {
        const own = board.companySetting(b.key);
        return { ...b, setting: own === undefined ? ('off' as Setting) : strictest(b.setting, own) };
      });
    if (hit && hit.entries === 'registry' && Date.now() - hit.at < 30_000) return eff(hit.list);
    const uses = this.core.manifest.uses.filter((u) => u.ability !== 'tasks.open');
    const out: Borrowed[] = [];
    if (uses.length) {
      const rows = await this.core.runnerPool
        .query<{ app: string; ability: string; version: string; title: string; description: string; kind: 'read' | 'write'; floor: Setting; doors: string[]; input: any; output: any }>(
          `select app, ability, version, title, description, kind, floor, doors, input, output from neos_registry.abilities where (app, ability) in (select * from unnest($1::text[], $2::text[]))`,
          [uses.map((u) => u.app), uses.map((u) => u.ability)],
        )
        .then((r) => r.rows)
        .catch((e) => {
          this.core.log('registry unavailable; nothing borrowed', { e: String(e?.message ?? e).slice(0, 200) });
          return [];
        });
      for (const u of uses) {
        const a = rows.find((r) => r.app === u.app && r.ability === u.ability);
        if (!a) continue; // the owner is not registered (or no longer offers it): not offered
        const ability: ManifestAbility = { key: a.ability, version: a.version, title: a.title, description: a.description, kind: a.kind, floor: a.floor, input: a.input ?? {}, output: a.output ?? {}, ...(Array.isArray(a.doors) && a.doors.length ? { doors: a.doors } : {}) } as ManifestAbility;
        out.push({ key: u.ability, owner: u.app, ability, setting: (u.floor ?? 'on') as Setting });
      }
    }
    this.cache.set(companyId, { at: Date.now(), list: out, entries: 'registry' });
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
