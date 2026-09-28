// Turn a package source folder into the bundle the registry signs:
//   manifest.json or nep.json (v3 §10: {name, version, author, signature?, …} is an alias of the manifest)
//   · migrations/*.sql · handlers.js · skills/*.md (front-matter `requires`)
//   · optional metrics.json and references/** (carried in the signed bytes, so verified by the artifact hash)
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { PackageBundle } from './types.ts';

async function readJson(file: string): Promise<Record<string, any> | null> {
  const raw = await readFile(file, 'utf8').catch(() => null);
  return raw === null ? null : JSON.parse(raw);
}

async function filesUnder(dir: string, rel = ''): Promise<string[]> {
  const out: string[] = [];
  for (const d of await readdir(path.join(dir, rel), { withFileTypes: true }).catch(() => [])) {
    const r = rel ? `${rel}/${d.name}` : d.name;
    if (d.isDirectory()) out.push(...(await filesUnder(dir, r)));
    else if (d.isFile()) out.push(r);
  }
  return out.sort();
}

export async function buildPackage(dir: string): Promise<PackageBundle> {
  const nep = await readJson(path.join(dir, 'nep.json'));
  const base = await readJson(path.join(dir, 'manifest.json'));
  if (!nep && !base) throw new Error(`${dir}: no manifest.json or nep.json`);
  let manifest: Record<string, any> = { ...(base ?? {}) };
  if (nep) {
    const key = typeof nep.name === 'string' ? (nep.name.startsWith('nep-') ? nep.name : `nep-${nep.name}`) : undefined;
    if (base && ((key && base.key && key !== base.key) || (nep.version && base.version && nep.version !== base.version))) {
      throw new Error(`${dir}: nep.json and manifest.json disagree on the package name or version`);
    }
    const { name: _name, title, ...rest } = nep;
    manifest = { ...manifest, ...rest, key: key ?? manifest.key, name: title ?? manifest.name ?? key };
  }
  const migrations: Record<string, string> = {};
  for (const f of (await readdir(path.join(dir, 'migrations')).catch(() => [])).filter((n) => /^\d{3}_.+\.sql$/.test(n)).sort()) {
    migrations[f] = await readFile(path.join(dir, 'migrations', f), 'utf8');
  }
  const skills: { key: string; requires: string[]; body: string }[] = [];
  for (const f of (await readdir(path.join(dir, 'skills')).catch(() => [])).filter((n) => n.endsWith('.md')).sort()) {
    const raw = await readFile(path.join(dir, 'skills', f), 'utf8');
    const fm = /^---\n([\s\S]*?)\n---\n/.exec(raw);
    const requires = fm ? (/requires:\s*\[([^\]]*)\]/.exec(fm[1]!)?.[1] ?? '').split(',').map((s) => s.trim()).filter(Boolean) : [];
    skills.push({ key: f.replace(/\.md$/, ''), requires, body: fm ? raw.slice(fm[0].length) : raw });
  }
  const handlers = await readFile(path.join(dir, 'handlers.js'), 'utf8');
  const bundle: PackageBundle = { manifest: { ...(manifest as PackageBundle['manifest']), skills, migrations }, handlers };
  const metrics = await readJson(path.join(dir, 'metrics.json'));
  if (metrics) bundle.metrics = metrics;
  const refs = await filesUnder(path.join(dir, 'references'));
  if (refs.length) bundle.references = Object.fromEntries(await Promise.all(refs.map(async (r) => [r, await readFile(path.join(dir, 'references', r), 'utf8')] as const)));
  return bundle;
}
