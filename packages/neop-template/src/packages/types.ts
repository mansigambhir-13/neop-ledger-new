import type { ManifestAbility } from '@neop/contracts';

export interface PackageManifest {
  key: string;
  version: string;
  name: string;
  description: string;
  abilities: ManifestAbility[];
  doors: string[];
  tables: string[];
  skills: { key: string; requires: string[]; body: string }[];
  migrations: Record<string, string>;
}

export interface PackageBundle {
  manifest: PackageManifest;
  handlers: string;
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
