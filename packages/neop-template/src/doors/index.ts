// Doors: adapters to outside systems. Keys are read from the secret store (v3 §12)
// for one call and then forgotten; nothing long-lived is stored here. Every
// door call is journaled first (write-ahead) so read-back is exact.

import { EmailDoor } from './email.ts';
import { FileDoor } from './file.ts';
import type { DoorJournal } from './journal.ts';

export { DoorError } from './errors.ts';
export { FileDoor } from './file.ts';
export { GspProvider, GSP_DEFAULT_PATHS, resetGspSessions, sameFigures, type GspCredential } from './gsp.ts';
export { MemoryDoorJournal, PgDoorJournal, type DoorJournal } from './journal.ts';
export { DEFAULT_DOOR_SECRETS_DIR, doorSecretPaths, FileSecretStore, MemorySecretStore, type Secret, type SecretStore } from './secrets.ts';

export interface Doors {
  email: EmailDoor;
  /** Every other door the manifest (or an installed package) declares: social, ads, gst_portal … */
  [name: string]: any;
}

/** Read one door's credential for this company, now (the backend's lend: declared, switched on, provisioned — else a definite DoorError). */
export type Lend = (door: string) => Promise<Record<string, unknown>>;

export function createDoors(lend: Lend, companyId: string, declared: string[] = [], journal: DoorJournal | null = null): Doors {
  const doors: Doors = { email: new EmailDoor(() => lend('email'), journal) };
  for (const name of declared) {
    if (name !== 'email') doors[name] = new FileDoor(name, () => lend(name), journal, { companyId, lend });
  }
  return doors;
}
