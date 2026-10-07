import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { FLEET_APPS, type DraftFleetApp } from '../runtime/apps.ts';
import type { InventoryEntry } from '../packaging/agent-context.ts';

export interface ImageRef { app: DraftFleetApp; id: string; os: string; architecture: string }
export function imageMap(rows: ImageRef[]): Map<DraftFleetApp, ImageRef> {
  if (!Array.isArray(rows) || rows.length !== FLEET_APPS.length) throw new Error('image evidence must cover all eighteen draft apps');
  const found = new Map<DraftFleetApp, ImageRef>();
  for (const row of rows) {
    if (!FLEET_APPS.includes(row.app) || found.has(row.app) || !/^sha256:[a-f0-9]{64}$/.test(row.id) || row.os !== 'linux' || row.architecture !== 'arm64') throw new Error('unsupported, duplicate or unpinned image evidence');
    found.set(row.app, row);
  }
  return found;
}

export function loopbackPort(value: string): number {
  const url = new URL(value);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.search || url.hash || !url.port) throw new Error('fixture URL must be explicit loopback HTTP');
  const port = Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid fixture port');
  return port;
}
export function hostFixtureUrl(value: string): string {
  loopbackPort(value);
  const url = new URL(value); url.hostname = 'host.docker.internal'; return url.toString().replace(/\/$/, '');
}

/** Map only original source/data files, never generated loaders/manifests or dependencies. */
export function originalSource(entry: InventoryEntry, side: 'agent' | 'backend'): string | null {
  if (entry.kind !== 'file') return null;
  let name: string;
  if (entry.path.startsWith('runtime/')) name = entry.path.slice(8);
  else if (side === 'backend' && /^entries\/[^/]+\/apps\//.test(entry.path)) name = entry.path.replace(/^entries\/[^/]+\//, '');
  else return null;
  if (!/^(?:apps|packages|scripts)\//.test(name) || name.split('/').some(part => part === '..' || part === '.' || !part)) return null;
  if (name.endsWith('/package.json')) return null; // artifact-only manifests deliberately trim exports/dependencies
  return name;
}
export async function verifySourceBinding(entries: InventoryEntry[], side: 'agent' | 'backend', root: string): Promise<number> {
  let checked = 0;
  for (const entry of entries) {
    const source = originalSource(entry, side); if (!source) continue;
    const value = await readFile(path.join(root, source));
    if (createHash('sha256').update(value).digest('hex') !== entry.sha256) throw new Error(`packaged ${side} source is stale: ${source}`);
    checked++;
  }
  if (!checked) throw new Error('artifact has no original source files');
  return checked;
}
