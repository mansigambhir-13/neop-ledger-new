import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Manifest } from '@neop/contracts';
import { loadAgentDir, loadBlocks, type AppDefinition } from '@neop/template';
import { abilities } from './capabilities/index.ts';
export const WAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const manifest = JSON.parse(readFileSync(path.join(WAGE_ROOT, 'manifest.json'), 'utf8')) as Manifest;
export async function wageApp(): Promise<AppDefinition> {
  const { prompt, skills } = await loadAgentDir(path.join(WAGE_ROOT, 'src/agent'));
  return { manifest, migrationsDir: path.join(WAGE_ROOT, 'migrations'), abilities, prompt, skills, blocks: await loadBlocks(WAGE_ROOT, manifest.blocks) };
}
