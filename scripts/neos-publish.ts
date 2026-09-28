// `neos publish` (v3 §10): submit a package or a skill to the registry. A person then reviews the diff and a second
// operator co-signs it (the platform's registry publish → review → co-sign path, unchanged); only then can an app
// `neos install` it. The registry refuses a package version that drops, recasts or major-bumps an ability a pinned
// skill or package still requires (409 breaks_pinned) until the version that served it has been deprecated 30 days.
//   tsx scripts/neos-publish.ts <package dir>     nep.json / manifest.json + handlers.js (+ migrations/, skills/, …)
//                                                 as an operator: NEOS_OPERATOR_TOKEN; NEOS_AUTHOR_KEY_FILE (optional,
//                                                 an Ed25519 private JWK) signs the content hash as the author
//   tsx scripts/neos-publish.ts <skill dir>       SKILL.md with front matter key/version/requires, as the owning app
//                                                 (scripts/registry.ts publish: NEOP_APP_KEY, NEOP_SERVICE_SECRET,
//                                                 NEOP_AUTHOR_KEY_FILE)
// Env: NEOS_PLATFORM_URL (default http://127.0.0.1:4700).
import { spawnSync } from 'node:child_process';
import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256Bytes } from '@neop/platform';
import { buildPackage, packageContentHash } from '@neop/template';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = process.argv[2];
if (!dir) {
  console.error('usage: neos-publish.ts <package dir | skill dir>');
  process.exit(64);
}
const platformUrl = (process.env.NEOS_PLATFORM_URL ?? 'http://127.0.0.1:4700').replace(/\/$/, '');

if (await access(path.join(dir, 'SKILL.md')).then(() => true, () => false)) {
  // A skill is published by the app that owns it, signed with that app's author key.
  const r = spawnSync(process.execPath, [...process.execArgv, path.join(here, 'registry.ts'), 'publish', dir], { stdio: 'inherit', env: process.env });
  process.exit(r.status ?? 1);
}

const bundle = await buildPackage(dir);
const { signature: _unsigned, ...m } = bundle.manifest as typeof bundle.manifest & { signature?: string };
let author: { public_key: unknown; sig: string } | null = null;
const keyFile = process.env.NEOS_AUTHOR_KEY_FILE;
if (keyFile) {
  // The registry hashes exactly these bytes; the author signs the content hash over them.
  const signed = { ...bundle, manifest: m };
  const artifact = sha256Bytes(Buffer.from(JSON.stringify(signed)));
  const ch = packageContentHash(signed, artifact);
  const jwk = JSON.parse(await readFile(keyFile, 'utf8'));
  const priv = createPrivateKey({ key: jwk, format: 'jwk' });
  author = { public_key: createPublicKey(priv).export({ format: 'jwk' }), sig: sign(null, Buffer.from(ch, 'utf8'), priv).toString('base64url') };
}
const res = await fetch(`${platformUrl}/api/registry/packages`, {
  method: 'POST',
  headers: { authorization: `Bearer ${process.env.NEOS_OPERATOR_TOKEN ?? 'dev_operator'}`, 'content-type': 'application/json' },
  body: JSON.stringify({ bundle: { ...bundle, manifest: m }, author }),
});
const out = await res.json().catch(() => null);
console.log(JSON.stringify({ status: res.status, ...(out ?? {}) }));
if (!res.ok) process.exit(1);
