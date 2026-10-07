import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fleetManifest, FLEET_DECLARATION_SCHEMA_VERSION, FLEET_TEMPLATE_COMMIT, FLEET_TEMPLATE_REPOSITORY, FLEET_TEMPLATE_VERSION, readAppDeclaration, stableJson, templateManifest, type AppDeclaration } from '@neop/template';
import { composeYaml } from './deploy/compose.ts';
import { CATALOG_APPS, isFleetApp, type FleetApp } from './runtime/apps.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ICONS: Record<FleetApp, string> = {
  ledger: '📒', wage: '💷', clear: '🧹', reach: '📣', desk: '🗂️', hire: '🧑‍💼', deal: '🤝', buy: '🛒', grant: '🎁', shift: '🗓️',
  sync: '🔄', post: '📮', roster: '👥', quote: '🧾', sign: '✍️', guard: '🛡️', vet: '🔎', pay: '💸', asset: '🏷️', renew: '♻️',
};

function declarationFor(app: FleetApp, manifest: AppDeclaration['manifest']): AppDeclaration {
  return {
    schema_version: FLEET_DECLARATION_SCHEMA_VERSION,
    template: { repository: FLEET_TEMPLATE_REPOSITORY, commit: FLEET_TEMPLATE_COMMIT, version: FLEET_TEMPLATE_VERSION },
    role: manifest.subject,
    kit: 'NEOS V3',
    catalogue_id: `ne-${app}`,
    icon: { emoji: ICONS[app] },
    category: app === 'ledger' || app === 'wage' || app === 'pay' ? 'finance' : 'operations',
    manifest,
  };
}

export async function emitAppManifests(app: FleetApp, options: { bootstrap?: boolean; check?: boolean } = {}): Promise<void> {
  const appRoot = path.join(ROOT, 'apps', app);
  const declarationFile = path.join(appRoot, 'app.declaration.json');
  if (options.bootstrap) {
    const legacy = JSON.parse(await readFile(path.join(appRoot, 'manifest.json'), 'utf8')) as AppDeclaration['manifest'];
    await writeFile(declarationFile, stableJson(declarationFor(app, legacy)));
  }
  const declaration = readAppDeclaration(appRoot);
  const files = new Map<string, string>([
    [path.join(appRoot, 'manifest.json'), stableJson(fleetManifest(declaration))],
    [path.join(appRoot, 'manifest.template.json'), stableJson(templateManifest(declaration, appRoot))],
    [path.join(ROOT, 'deploy', 'fleet', 'generated', `${app}.compose.yaml`), composeYaml(app)],
  ]);
  for (const [file, content] of files) {
    if (options.check) {
      const actual = await readFile(file, 'utf8').catch(() => null);
      if (actual !== content) throw new Error(`${path.relative(ROOT, file)} is stale; run pnpm fleet:emit-manifests`);
    } else {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, content);
    }
  }
}

const args = process.argv.slice(2);
const bootstrap = args.includes('--bootstrap');
const check = args.includes('--check');
const appArg = args.find((arg) => arg.startsWith('--app='))?.slice('--app='.length);
const apps = appArg ? [appArg] : [...CATALOG_APPS];
for (const candidate of apps) {
  if (!isFleetApp(candidate)) throw new Error(`unknown app: ${candidate}`);
  await emitAppManifests(candidate, { bootstrap, check });
}
console.log(`${check ? 'verified' : 'emitted'} manifests and Compose contracts for ${apps.length} app(s)`);
