import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Manifest } from '@neop/contracts';
import { loadAgentDir, type AppDefinition } from '@neop/template';
import * as ab from './abilities.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
export const MARKETING_ROOT = path.resolve(here, '..');
export const manifest = JSON.parse(readFileSync(path.join(MARKETING_ROOT, 'manifest.json'), 'utf8')) as Manifest;

export async function marketingApp(): Promise<AppDefinition> {
  const { prompt, skills } = await loadAgentDir(path.join(here, 'agent'));
  return {
    manifest,
    migrationsDir: path.join(MARKETING_ROOT, 'migrations'),
    prompt,
    skills,
    abilities: {
      'marketing.campaigns.list': ab.campaignsList,
      'marketing.stats.read': ab.statsRead,
      'marketing.post.draft': ab.postDraft,
      'marketing.post.schedule': ab.postSchedule,
      'marketing.spend.commit': ab.spendCommit,
    },
  };
}

export { seedMarketing, DIWALI_CAMPAIGN } from './seed.ts';
