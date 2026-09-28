import { strictest, type Manifest, type ManifestAbility, type Setting } from '@neop/contracts';
import { forcedAskFirst, parseRules, type Rule } from '../domain/rules.ts';
import type { PlatformClient, SwitchboardDoc } from '../platform-client.ts';

export interface BoardSnapshot {
  version: number;
  /** The effective setting of every line (min of floor and the company's switch; rules may force ask-first). */
  settings: Record<string, Setting>;
  /** The company's switches as the platform holds them. */
  company_settings: Record<string, Setting>;
  rules: unknown[];
  budget: SwitchboardDoc['budget'];
}

export interface EffectiveBoard {
  version: number;
  rules: Rule[];
  budget: SwitchboardDoc['budget'];
  company: SwitchboardDoc['company'];
  setting(ability: ManifestAbility): Setting;
  /** The company's own setting for a key this app does not own (borrowed lines). */
  hostSetting(key: string): Setting;
  /** The board as a job runs on it (jobs.switchboard_snapshot, t007). */
  snapshot(): BoardSnapshot;
}

/** Told when the platform's board (re)loads, or is refused because the app is not installed: the book's mirror (t009). */
export interface BoardObserver {
  loaded(companyId: string, doc: SwitchboardDoc, board: EffectiveBoard): Promise<void>;
  notInstalled(companyId: string): Promise<void>;
}

const TTL_MS = 30_000;

/**
 * The switchboard is stored once on the platform; the gate evaluates it from a
 * local cache stamped with its version. Refetch when older than 30 s, when a
 * gateway token carries a newer sb_version, or on switchboard.changed.
 * Every fetch is also written to the book's read-only mirror (<schema>.switchboard,
 * <schema>.installs); the platform stays the source of truth.
 */
export class SwitchboardCache {
  private cache = new Map<string, { doc: SwitchboardDoc; at: number }>();
  readonly client: PlatformClient;
  readonly manifest: Manifest;
  observer: BoardObserver | null = null;
  constructor(client: PlatformClient, manifest: Manifest) {
    this.client = client;
    this.manifest = manifest;
  }

  invalidate(companyId: string): void {
    this.cache.delete(companyId);
  }

  async get(companyId: string, minVersion = 0): Promise<EffectiveBoard> {
    let hit = this.cache.get(companyId);
    let fresh = false;
    if (!hit || Date.now() - hit.at > TTL_MS || hit.doc.version < minVersion) {
      let doc: SwitchboardDoc;
      try {
        doc = await this.client.switchboard(companyId);
      } catch (e) {
        if ((e as { status?: number }).status === 403) await this.observer?.notInstalled(companyId).catch(() => {});
        throw e;
      }
      hit = { doc, at: Date.now() };
      this.cache.set(companyId, hit);
      fresh = true;
    }
    const board = this.effective(hit.doc);
    // A mirror that cannot be written never stops the gate: the platform's board is what counts.
    if (fresh) await this.observer?.loaded(companyId, hit.doc, board).catch(() => {});
    return board;
  }

  private effective(doc: SwitchboardDoc): EffectiveBoard {
    const rules = parseRules(doc.rules);
    const manifest = this.manifest;
    const board: EffectiveBoard = {
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
      snapshot() {
        const settings: Record<string, Setting> = {};
        for (const a of manifest.abilities) settings[a.key] = board.setting(a);
        for (const k of Object.keys(doc.settings ?? {})) if (!(k in settings)) settings[k] = board.hostSetting(k);
        return { version: doc.version, settings, company_settings: { ...(doc.settings ?? {}) }, rules: Array.isArray(doc.rules) ? doc.rules : [], budget: doc.budget ?? {} };
      },
    };
    return board;
  }
}
