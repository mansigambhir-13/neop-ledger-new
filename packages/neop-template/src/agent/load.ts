import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { PromptFillins, SkillFile } from '../types.ts';

/**
 * An app fills SYSTEM.md with four sections (## NAME, ## SUBJECT,
 * ## WHAT YOU LOOK AFTER, ## WHO YOU ARE TALKING TO) and writes skills as
 * skills/<key>/SKILL.md with a front-matter `requires:` list.
 */
export async function loadAgentDir(dir: string): Promise<{ prompt: PromptFillins; skills: SkillFile[] }> {
  const sys = await readFile(path.join(dir, 'SYSTEM.md'), 'utf8');
  const sections = new Map<string, string>();
  for (const block of sys.split(/^## /m).slice(1)) {
    const nl = block.indexOf('\n');
    sections.set(block.slice(0, nl).trim().toUpperCase(), block.slice(nl + 1).trim());
  }
  const need = (k: string) => {
    const v = sections.get(k);
    if (!v) throw new Error(`SYSTEM.md is missing "## ${k}"`);
    return v;
  };
  const prompt: PromptFillins = {
    name: need('NAME'),
    subject: need('SUBJECT'),
    looks_after: need('WHAT YOU LOOK AFTER'),
    who_you_talk_to: need('WHO YOU ARE TALKING TO'),
  };
  const skills: SkillFile[] = [];
  const skillsDir = path.join(dir, 'skills');
  for (const name of (await readdir(skillsDir).catch(() => [])).sort()) {
    const raw = await readFile(path.join(skillsDir, name, 'SKILL.md'), 'utf8').catch(() => null);
    if (!raw) continue;
    const fm = /^---\n([\s\S]*?)\n---\n/.exec(raw);
    const requires = fm ? (/requires:\s*\[([^\]]*)\]/.exec(fm[1]!)?.[1] ?? '').split(',').map((s) => s.trim()).filter(Boolean) : [];
    skills.push({ key: name, requires, body: fm ? raw.slice(fm[0].length) : raw });
  }
  return { prompt, skills };
}
