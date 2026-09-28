// The door secret store on disk (v3 §12), for ops tools: write one credential (0600, atomically), and seal /
// open the whole store for backups. Layout (same as the template's FileSecretStore reads):
//   <root>/<company_id>/<app>/<door>.json   an app's own credential
//   <root>/<company_id>/<door>.json         company-wide ('*')
// Nothing here ever prints or logs a secret value.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmod, mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { doorSecretPaths } from '@neop/template';

/** Write one credential where the backend will read it. `app` '*' (or omitted) = company-wide. Returns the path. */
export async function writeDoorSecret(root: string, company: string, door: string, secret: Record<string, unknown>, app = '*'): Promise<string> {
  if (!secret || typeof secret !== 'object' || Array.isArray(secret)) throw new Error('a credential is a JSON object');
  const p = doorSecretPaths(root, company, app === '*' ? 'x' : app, door);
  const file = app === '*' ? p.company : p.own;
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  // Rotation is write-then-rename: a backend reading mid-rotation sees the old credential or the new one, never half.
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(tmp, JSON.stringify(secret) + '\n', { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, file);
  return file;
}

/** Every credential file under the root, as relative paths (for listings and backups; never the contents). */
export async function listDoorFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string, depth: number) => {
    let names: string[];
    try {
      names = await readdir(d);
    } catch {
      return;
    }
    for (const n of names.sort()) {
      if (n.startsWith('.')) continue;
      const f = path.join(d, n);
      const st = await stat(f);
      if (st.isDirectory() && depth < 2) await walk(f, depth + 1);
      else if (st.isFile() && n.endsWith('.json')) out.push(path.relative(root, f));
    }
  };
  await walk(root, 0);
  return out;
}

const MAGIC = 'neos-doors-v1';

/** Seal the whole store (AES-256-GCM, 32-byte key): one blob, nothing readable without the key. */
export async function sealDoors(root: string, key: Buffer): Promise<{ blob: Buffer; files: number }> {
  if (key.length !== 32) throw new Error('the doors backup key must be 32 bytes');
  const files: Record<string, string> = {};
  for (const rel of await listDoorFiles(root)) files[rel] = await readFile(path.join(root, rel), 'utf8');
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(MAGIC));
  const ct = Buffer.concat([c.update(JSON.stringify(files), 'utf8'), c.final()]);
  const blob = Buffer.from(JSON.stringify({ v: MAGIC, iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), ct: ct.toString('base64') }));
  return { blob, files: Object.keys(files).length };
}

/** Open a sealed store and write it under `target` (0600 files, 0700 directories). Returns the relative paths. */
export async function restoreDoors(blob: Buffer, key: Buffer, target: string): Promise<string[]> {
  const env = JSON.parse(blob.toString('utf8'));
  if (env.v !== MAGIC) throw new Error('not a sealed doors backup');
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(env.iv, 'base64'));
  d.setAAD(Buffer.from(MAGIC));
  d.setAuthTag(Buffer.from(env.tag, 'base64'));
  const files = JSON.parse(Buffer.concat([d.update(Buffer.from(env.ct, 'base64')), d.final()]).toString('utf8')) as Record<string, string>;
  const out: string[] = [];
  for (const [rel, text] of Object.entries(files)) {
    const f = path.resolve(target, rel);
    if (!f.startsWith(path.resolve(target) + path.sep)) throw new Error(`refusing a path outside the target: ${rel}`);
    await mkdir(path.dirname(f), { recursive: true, mode: 0o700 });
    await writeFile(f, text, { mode: 0o600 });
    await chmod(f, 0o600);
    out.push(rel);
  }
  return out;
}
