// Ledger's view of the shared testkit: the same pilot, with Ledger as the app.
import { bootPilot as boot, type BootOptions, type Pilot } from '@neop/testkit';
import { ledgerApp, seedLedger } from '../src/index.ts';

export * from '@neop/testkit';

export async function ledgerUnderTest() {
  return { def: await ledgerApp(), seed: seedLedger };
}

export async function bootPilot(opts: Omit<BootOptions, 'apps'> & { apps?: BootOptions['apps'] } = {}): Promise<Pilot> {
  return boot({ ...opts, apps: opts.apps ?? [await ledgerUnderTest()] });
}
