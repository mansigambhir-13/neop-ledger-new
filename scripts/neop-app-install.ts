import { readFile } from 'node:fs/promises';
import { FileAppReleaseRegistry, installAppRelease } from '@neop/template';

const [spec, registryDir, target] = process.argv.slice(2);
const match = /^([a-z][a-z0-9-]*)@(\d+\.\d+\.\d+)$/.exec(spec ?? '');
if (!match || !registryDir || !target) throw new Error('usage: neop-app-install.ts <app>@<version> <registry-dir> <target-dir>');
const trustFile = process.env.NEOS_APP_PUBLISH_JWKS_FILE;
if (!trustFile) throw new Error('NEOS_APP_PUBLISH_JWKS_FILE is required');
const trusted = JSON.parse(await readFile(trustFile, 'utf8')) as { keys: JsonWebKey[] };
const registry = new FileAppReleaseRegistry(registryDir);
const bundle = await registry.get(match[1]!, match[2]!);
const result = await installAppRelease({ bundle, target, trusted });
console.log(JSON.stringify({ result, app: bundle.release.app, version: bundle.release.version, content_hash: bundle.release.content_hash }));
