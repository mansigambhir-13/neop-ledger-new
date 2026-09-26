import { createHash } from 'node:crypto';
import { canonicalize } from './jcs.ts';

export function sha256Tagged(b: Buffer | string): string {
  return 'sha256:' + createHash('sha256').update(b).digest('hex');
}

/** What the registry co-signs: the entry's content, including its artifact hash. */
export function registryContentHash(e: { key: string; version: string; kind: string; body: string | null; requires: string[]; offers: unknown; artifact_hash: string | null }): string {
  return sha256Tagged(canonicalize({ key: e.key, version: e.version, kind: e.kind, body: e.body, requires: e.requires, offers: e.offers ?? [], artifact_hash: e.artifact_hash }));
}
