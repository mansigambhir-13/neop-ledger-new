// Build-time roster only. The assistant imports this list, never an app loader.
export const FLEET_APPS = [
  'asset', 'buy', 'clear', 'deal', 'desk', 'grant', 'guard', 'hire', 'pay',
  'post', 'quote', 'reach', 'renew', 'roster', 'shift', 'sign', 'sync', 'vet',
] as const;
export type FleetApp = typeof FLEET_APPS[number];

export function isFleetApp(value: string): value is FleetApp {
  return (FLEET_APPS as readonly string[]).includes(value);
}
