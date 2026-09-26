// Registry publish client for app authors (Phase 5). An author holds an Ed25519 key;
// the app registered its public half (ops.ts register-app --author-key). Publishing
// signs the entry's content hash, so the platform can verify authorship before a
// person reviews the diff.
//   tsx scripts/registry.ts keygen <out-prefix>        → <prefix>.key.jwk (private, 0600) + <prefix>.pub.jwk
//   tsx scripts/registry.ts publish <skill-dir>        → POST /internal/registry/publish
// <skill-dir>/SKILL.md starts with front matter: key (<app>/<name>), version (x.y.z), requires ([ability keys]).
// Env: NEOS_PLATFORM_URL, NEOP_APP_KEY, NEOP_SERVICE_SECRET[_FILE], NEOP_AUTHOR_KEY_FILE.
import { createPrivateKey, generateKeyPairSync, sign } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { contentHash as registryContentHash } from '@neop/platform';
import { parse as parseYaml } from 'yaml';
import { env } from '../apps/ledger/scripts/env.ts';

const [cmd, arg] = process.argv.slice(2);

async function keygen(prefix: string) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  await writeFile(`${prefix}.key.jwk`, JSON.stringify(privateKey.export({ format: 'jwk' })), { mode: 0o600 });
  await writeFile(`${prefix}.pub.jwk`, JSON.stringify(publicKey.export({ format: 'jwk' })));
  console.log(JSON.stringify({ private: `${prefix}.key.jwk`, public: `${prefix}.pub.jwk` }));
}

/** Read a skill folder: front matter (key, version, requires) and its body. */
export async function readSkill(dir: string): Promise<{ key: string; version: string; requires: string[]; body: string }> {
  const raw = await readFile(path.join(dir, 'SKILL.md'), 'utf8');
  const fm = /^---\n([\s\S]*?)\n---\n?/.exec(raw);
  if (!fm) throw new Error(`${dir}/SKILL.md needs front matter with key, version and requires`);
  const meta = (parseYaml(fm[1]!) ?? {}) as { key?: unknown; version?: unknown; requires?: unknown };
  if (typeof meta.key !== 'string' || typeof meta.version !== 'string') throw new Error('front matter needs key and version');
  const requires = Array.isArray(meta.requires) ? meta.requires.map(String) : [];
  return { key: meta.key, version: meta.version, requires, body: raw.slice(fm[0].length) };
}

async function publish(dir: string) {
  const s = await readSkill(dir);
  const app = env('NEOP_APP_KEY');
  if (!s.key.startsWith(`${app}/`)) throw new Error(`a skill key is ${app}/<name>; got ${s.key}`);
  // The same content hash the platform computes and co-signs.
  const ch = registryContentHash({ key: s.key, version: s.version, kind: 'skill', body: s.body, requires: s.requires, offers: [], artifact_hash: null });
  const priv = createPrivateKey({ key: JSON.parse(await readFile(env('NEOP_AUTHOR_KEY_FILE'), 'utf8')), format: 'jwk' });
  const author_sig = sign(null, Buffer.from(ch, 'utf8'), priv).toString('base64url');
  const res = await fetch(`${env('NEOS_PLATFORM_URL', 'http://127.0.0.1:4700').replace(/\/$/, '')}/internal/registry/publish`, {
    method: 'POST',
    headers: { authorization: `Service ${app}:${env('NEOP_SERVICE_SECRET')}`, 'content-type': 'application/json' },
    body: JSON.stringify({ key: s.key, version: s.version, requires: s.requires, body: s.body, author_sig }),
  });
  const out = await res.json().catch(() => null);
  console.log(JSON.stringify({ status: res.status, content_hash: ch, ...(out ?? {}) }));
  if (!res.ok) process.exit(1);
}

if (cmd === 'keygen' && arg) await keygen(arg);
else if (cmd === 'publish' && arg) await publish(arg);
else {
  console.error('usage: registry.ts keygen <out-prefix> | publish <skill-dir>');
  process.exit(64);
}
