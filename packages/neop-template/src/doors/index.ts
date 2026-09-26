// Doors: adapters to outside systems. Keys are borrowed from the platform vault
// for one call and then forgotten; nothing long-lived is stored here. Every
// door call is journaled first (write-ahead) so read-back is exact.

import type { PlatformClient } from '../platform-client.ts';
import { EmailDoor } from './email.ts';
import { FileDoor } from './file.ts';
import type { DoorJournal } from './journal.ts';

export { DoorError } from './errors.ts';
export { FileDoor } from './file.ts';
export { MemoryDoorJournal, PgDoorJournal, type DoorJournal } from './journal.ts';

export interface Doors {
  email: EmailDoor;
  /** Every other door the manifest (or an installed package) declares: social, ads, gst_portal … */
  [name: string]: any;
}

export function createDoors(platform: PlatformClient, companyId: string, declared: string[] = [], journal: DoorJournal | null = null): Doors {
  const doors: Doors = { email: new EmailDoor(() => platform.lend(companyId, 'email'), journal) };
  for (const name of declared) {
    if (name !== 'email') doors[name] = new FileDoor(name, () => platform.lend(companyId, name), journal);
  }
  return doors;
}
