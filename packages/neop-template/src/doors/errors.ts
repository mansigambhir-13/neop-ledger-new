/** A door error that certainly did not produce the effect (e.g. a 4xx validation failure). */
export class DoorError extends Error {
  readonly definite: boolean;
  constructor(message: string, opts: { definite: boolean }) {
    super(message);
    this.definite = opts.definite;
  }
}
