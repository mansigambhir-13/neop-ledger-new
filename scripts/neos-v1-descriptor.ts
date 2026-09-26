// Writes the descriptor + schema document that today's NEOS platform installs an app from
// (neos-service-platform-api `pnpm neop:register --descriptor … --schema …`).
//   tsx scripts/neos-v1-descriptor.ts ledger          → apps/ledger/neos-v1/{descriptor,contract}.json
//   tsx scripts/neos-v1-descriptor.ts ledger --check  → exit 1 if the committed files drift from the manifest
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { neosV1Descriptor } from '@neop/template';

const apps: Record<string, () => Promise<{ manifest: any }>> = {
  ledger: async () => (await import('@neop/ledger')).ledgerApp(),
  marketing: async () => (await import('@neop/marketing')).marketingApp(),
};
const [key, flag] = process.argv.slice(2);
const load = apps[key ?? ''];
if (!load) {
  console.error('usage: neos-v1-descriptor.ts <app> [--check]');
  process.exit(64);
}
const { descriptor, schema } = neosV1Descriptor((await load()).manifest);
const dir = path.resolve(import.meta.dirname, '..', 'apps', key!, 'neos-v1');
const files = { 'descriptor.json': descriptor, 'contract.json': schema };
if (flag === '--check') {
  const stale = Object.entries(files).filter(([f, v]) => {
    try {
      return readFileSync(path.join(dir, f), 'utf8') !== `${JSON.stringify(v, null, 2)}\n`;
    } catch {
      return true;
    }
  });
  if (stale.length) {
    console.error(`stale: ${stale.map(([f]) => f).join(', ')} — run tsx scripts/neos-v1-descriptor.ts ${key}`);
    process.exit(1);
  }
  console.log('neos-v1 descriptor up to date');
} else {
  mkdirSync(dir, { recursive: true });
  for (const [f, v] of Object.entries(files)) writeFileSync(path.join(dir, f), `${JSON.stringify(v, null, 2)}\n`);
  console.log(JSON.stringify({ app: key, capabilities: (descriptor.capabilities as unknown[]).length, dir }));
}
