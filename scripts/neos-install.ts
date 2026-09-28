// `neos install` (v3 §10, S7): install a registry package or pin a registry skill into an app, at build time.
//   tsx scripts/neos-install.ts <app> <key>@<version> [--proven "<where it was proven>"] [--no-tests] [--trust <jwks file>]
//   tsx scripts/neos-install.ts <app> --remove <key>
// What it does (packages/neop-template/src/packages/install.ts):
//   fetch the entry and the artifact by hash from the registry · verify the hash and the registry's co-signature
//   (and, with --trust, that the key is one of the registry's pinned keys) · unpack read-only into
//   apps/<app>/src/packages/nep-<name>/ · pin it in apps/<app>/packages.lock.json · append its migrations to
//   apps/<app>/migrations/ (+ migrate.json; --proven fills proven_on_populated_data) · write its lines into the
//   manifest's `packages` · run its self-test inside the host (the host's whole migration set in a scratch database
//   on NEOS_ADMIN_URL's cluster). Any failure leaves the app exactly as it was.
// A skill (<owner>/<name>@x.y.z) is only pinned (lock + manifest `registry_skills`): its text stays in the registry.
// --remove takes the package's files, lock entry and lines out; its migrations stay (forward only) and so do its tables.
// Then: commit, build, give the DBA the app's migration file (scripts/dba-bundle.ts), deploy, re-register.
// Env: NEOS_PLATFORM_URL; NEOS_OPERATOR_TOKEN (an operator) or NEOP_APP_KEY + NEOP_SERVICE_SECRET[_FILE] (the app's
// own build); NEOS_ADMIN_URL[_FILE] for the scratch database the tests run in.
import { readFileSync } from 'node:fs';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { httpRegistrySource, installEntry, InstallError, removeEntry } from '@neop/template';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (name: string) => {
  const i = argv.indexOf(name);
  if (i < 0) return undefined;
  const v = argv[i + 1];
  argv.splice(i, 2);
  return v;
};
const has = (name: string) => {
  const i = argv.indexOf(name);
  if (i >= 0) argv.splice(i, 1);
  return i >= 0;
};
const env = (name: string): string | undefined => {
  const f = process.env[`${name}_FILE`];
  return f ? readFileSync(f, 'utf8').trim() : process.env[name];
};

const removeKey = flag('--remove');
const proven = flag('--proven');
const trustFile = flag('--trust');
const noTests = has('--no-tests');
const [app, spec] = argv;
if (!app || (!removeKey && !spec)) {
  console.error('usage: neos-install.ts <app> <key>@<version> [--proven "<where>"] [--no-tests] [--trust <jwks file>] | <app> --remove <key>');
  process.exit(64);
}
const root = path.join(ROOT, 'apps', app);
await access(path.join(root, 'manifest.json')).catch(() => {
  console.error(`no app at ${root}`);
  process.exit(64);
});
const log = (m: string) => console.error(m);
try {
  if (removeKey) {
    console.log(JSON.stringify(await removeEntry({ root, key: removeKey, log })));
  } else {
    const platformUrl = env('NEOS_PLATFORM_URL') ?? 'http://127.0.0.1:4700';
    const bearer = env('NEOS_OPERATOR_TOKEN');
    const service = env('NEOP_APP_KEY') && env('NEOP_SERVICE_SECRET') ? { app: env('NEOP_APP_KEY')!, secret: env('NEOP_SERVICE_SECRET')! } : undefined;
    if (!bearer && !service) throw new InstallError('set NEOS_OPERATOR_TOKEN, or NEOP_APP_KEY and NEOP_SERVICE_SECRET', 'no_credentials');
    const trusted = trustFile ? (JSON.parse(readFileSync(trustFile, 'utf8')) as { keys: Record<string, unknown>[] }) : null;
    const r = await installEntry({ root, spec: spec!, source: httpRegistrySource({ platformUrl, bearer, service }), trusted, tests: noTests ? false : undefined, proven, log });
    console.log(JSON.stringify(r));
  }
} catch (e) {
  console.error(e instanceof InstallError ? `refused (${e.code}): ${e.message}` : String((e as Error).stack ?? e));
  process.exit(1);
}
