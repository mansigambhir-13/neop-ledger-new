/** A door error that certainly did not produce the effect (e.g. a 4xx validation failure). */
export class DoorError extends Error {
  readonly definite: boolean;
  /** Why, when the door refused before anything was sent: undeclared_door, door_off, no_secret, secret_store, bad_name. */
  readonly code: string | null;
  constructor(message: string, opts: { definite: boolean; code?: string }) {
    super(message);
    this.definite = opts.definite;
    this.code = opts.code ?? null;
  }
}
