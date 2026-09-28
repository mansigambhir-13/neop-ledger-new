import type { ManifestAbility } from '@neop/contracts';

export interface PackageManifest {
  key: string;
  version: string;
  name: string;
  description: string;
  /** From nep.json (v3 §10). */
  author?: { name?: string; email?: string; public_key?: unknown } | string;
  /** nep.json may carry the author's signature over the content hash; the registry takes it out of the signed bytes. */
  signature?: string;
  abilities: ManifestAbility[];
  doors: string[];
  tables: string[];
  /** Host reads the package may call through ctx.reads (read-only; the company's switchboard still applies). */
  requires?: string[];
  skills: { key: string; requires: string[]; body: string }[];
  migrations: Record<string, string>;
}

export interface PackageBundle {
  manifest: PackageManifest;
  handlers: string;
  /** v3 §10: metrics.json, carried in the signed bytes. */
  metrics?: Record<string, unknown>;
  /** v3 §10: references/<path> → text, carried in the signed bytes. */
  references?: Record<string, string>;
}

export interface RegistryEntryRow {
  key: string;
  version: string;
  kind: 'skill' | 'package';
  owner_app: string | null;
  requires: string[];
  offers: unknown;
  body: string | null;
  artifact_hash: string | null;
  content_hash: string;
  platform_sig: string;
}
