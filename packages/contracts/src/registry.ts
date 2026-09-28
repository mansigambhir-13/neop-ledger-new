import { createHash } from 'node:crypto';
import { canonicalize } from './jcs.ts';

export function sha256Tagged(b: Buffer | string): string {
  return 'sha256:' + createHash('sha256').update(b).digest('hex');
}

/** What the registry co-signs: the entry's content, including its artifact hash. */
export function registryContentHash(e: { key: string; version: string; kind: string; body: string | null; requires: string[]; offers: unknown; artifact_hash: string | null }): string {
  return sha256Tagged(canonicalize({ key: e.key, version: e.version, kind: e.kind, body: e.body, requires: e.requires, offers: e.offers ?? [], artifact_hash: e.artifact_hash }));
}

/** What a package offers, as the registry records and co-signs it: one line per ability. */
export function packageOffers(m: { abilities: { key: string; kind: string; floor: string; version: string }[] }): { key: string; kind: string; floor: string; version: string }[] {
  return (m.abilities ?? []).map((a) => ({ key: a.key, kind: a.kind, floor: a.floor, version: a.version }));
}

/** What a package requires, as the registry records it: everything its skills need, once each. */
export function packageRequires(m: { skills?: { requires: string[] }[] }): string[] {
  return [...new Set((m.skills ?? []).flatMap((s) => s.requires))];
}
