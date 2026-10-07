import type { AppDefinition } from '@neop/template';
import { isFleetApp, type FleetApp } from './apps.ts';
import { RuntimeConfigError } from './config.ts';

/** Backend-only loader. Never evaluate an environment value as a module path. */
const loaders: Record<FleetApp, () => Promise<AppDefinition>> = {
  ledger: async () => (await import('@neop/ledger')).ledgerApp(),
  wage: async () => (await import('@neop/wage')).wageApp(),
  asset: async () => (await import('@neop/asset')).assetApp(),
  buy: async () => (await import('@neop/buy')).buyApp(),
  clear: async () => (await import('@neop/clear')).clearApp(),
  deal: async () => (await import('@neop/deal')).dealApp(),
  desk: async () => (await import('@neop/desk')).deskApp(),
  grant: async () => (await import('@neop/grant')).grantApp(),
  guard: async () => (await import('@neop/guard')).guardApp(),
  hire: async () => (await import('@neop/hire')).hireApp(),
  pay: async () => (await import('@neop/pay')).payApp(),
  post: async () => (await import('@neop/post')).postApp(),
  quote: async () => (await import('@neop/quote')).quoteApp(),
  reach: async () => (await import('@neop/reach')).reachApp(),
  renew: async () => (await import('@neop/renew')).renewApp(),
  roster: async () => (await import('@neop/roster')).rosterApp(),
  shift: async () => (await import('@neop/shift')).shiftApp(),
  sign: async () => (await import('@neop/sign')).signApp(),
  sync: async () => (await import('@neop/sync')).syncApp(),
  vet: async () => (await import('@neop/vet')).vetApp(),
};

export async function loadFleetApp(app: string): Promise<AppDefinition> {
  if (!isFleetApp(app)) throw new RuntimeConfigError(['NEOP_APP']);
  const def = await loaders[app]();
  if (def.manifest.app !== app) throw new RuntimeConfigError(['NEOP_APP']);
  return def;
}
