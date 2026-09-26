// Turn a package source folder into the bundle the registry signs:
//   manifest.json · migrations/*.sql · handlers.js · skills/*.md (front-matter `requires`)
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { PackageBundle } from './types.ts';

export async function buildPackage(dir: string): Promise<PackageBundle> {
  const manifest = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8'));
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
  return { manifest: { ...manifest, skills, migrations }, handlers };
}
