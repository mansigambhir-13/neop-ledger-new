import { strictest, type Manifest, type ManifestAbility, type Setting } from '@neop/contracts';
import { forcedAskFirst, parseRules, type Rule } from '../domain/rules.ts';
import type { PlatformClient, SwitchboardDoc } from '../platform-client.ts';

export interface EffectiveBoard {
  version: number;
  rules: Rule[];
  budget: SwitchboardDoc['budget'];
  company: SwitchboardDoc['company'];
  setting(ability: ManifestAbility): Setting;
  /** The company's own setting for a key this app does not own (borrowed lines). */
  hostSetting(key: string): Setting;
}

const TTL_MS = 30_000;

/**
 * The switchboard is stored once on the platform; the gate evaluates it from a
 * local cache stamped with its version. Refetch when older than 30 s, when a
 * gateway token carries a newer sb_version, or on switchboard.changed.
 */
export class SwitchboardCache {
  private cache = new Map<string, { doc: SwitchboardDoc; at: number }>();
  readonly client: PlatformClient;
  readonly manifest: Manifest;
  constructor(client: PlatformClient, manifest: Manifest) {
    this.client = client;
    this.manifest = manifest;
  }

  invalidate(companyId: string): void {
    this.cache.delete(companyId);
  }

  async get(companyId: string, minVersion = 0): Promise<EffectiveBoard> {
    let hit = this.cache.get(companyId);
    if (!hit || Date.now() - hit.at > TTL_MS || hit.doc.version < minVersion) {
      hit = { doc: await this.client.switchboard(companyId), at: Date.now() };
      this.cache.set(companyId, hit);
    }
    const doc = hit.doc;
    const rules = parseRules(doc.rules);
    return {
      version: doc.version,
      rules,
      budget: doc.budget ?? {},
      company: doc.company,
      hostSetting(key) {
        return strictest('on', doc.settings[key]);
      },
      setting(ability) {
        // effective = min(app floor, company setting); require_person forces ask-first.
        let s = strictest(ability.floor, doc.settings[ability.key]);
        if (s === 'on' && ability.kind === 'write' && forcedAskFirst(rules, ability.key)) s = 'ask_first';
        return s;
      },
    };
  }
}
