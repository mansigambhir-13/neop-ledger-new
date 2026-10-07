// Build-time roster only. The assistant imports this list, never an app loader.
export const CATALOG_APPS = [
  'ledger', 'wage', 'clear', 'reach', 'desk', 'hire', 'deal', 'buy', 'grant', 'shift',
  'sync', 'post', 'roster', 'quote', 'sign', 'guard', 'vet', 'pay', 'asset', 'renew',
] as const;
/** The original fixed-image draft cohort; Ledger and Wage keep their historical packaging paths. */
export const FLEET_APPS = [
  'asset', 'buy', 'clear', 'deal', 'desk', 'grant', 'guard', 'hire', 'pay',
  'post', 'quote', 'reach', 'renew', 'roster', 'shift', 'sign', 'sync', 'vet',
] as const;
export type FleetApp = typeof CATALOG_APPS[number];
export type DraftFleetApp = typeof FLEET_APPS[number];

export function isFleetApp(value: string): value is FleetApp {
  return (CATALOG_APPS as readonly string[]).includes(value);
}
