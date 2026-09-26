// Key vault encryption at rest (R9): AES-256-GCM envelopes tagged with a key
// id, so keys rotate (re-encrypt under the active key) without downtime.

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export interface VaultKeys {
  active: string;
  /** kid → 32-byte key, base64 */
  keys: Record<string, string>;
}

export interface Envelope {
  v: 1;
  kid: string;
  iv: string;
  tag: string;
  ct: string;
}

export function isEnvelope(x: unknown): x is Envelope {
  return !!x && typeof x === 'object' && (x as Envelope).v === 1 && typeof (x as Envelope).ct === 'string';
}

export class VaultCipher {
  private readonly keys: Map<string, Buffer>;
  readonly active: string;
  constructor(cfg: VaultKeys) {
    this.keys = new Map(Object.entries(cfg.keys).map(([kid, b64]) => [kid, Buffer.from(b64, 'base64')]));
    for (const [kid, k] of this.keys) if (k.length !== 32) throw new Error(`vault key ${kid} must be 32 bytes`);
    if (!this.keys.has(cfg.active)) throw new Error('active vault key missing');
    this.active = cfg.active;
  }

  static generate(kid = 'k1'): VaultKeys {
    return { active: kid, keys: { [kid]: randomBytes(32).toString('base64') } };
  }

  seal(plain: unknown, aad: string): Envelope {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.keys.get(this.active)!, iv);
    c.setAAD(Buffer.from(aad));
    const ct = Buffer.concat([c.update(JSON.stringify(plain), 'utf8'), c.final()]);
    return { v: 1, kid: this.active, iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), ct: ct.toString('base64') };
  }

  /** The AAD binds a secret to its company and door: a row copied elsewhere will not open. */
  open(env: Envelope, aad: string): Record<string, unknown> {
    const key = this.keys.get(env.kid);
    if (!key) throw new Error(`vault key ${env.kid} is not in the keyring`);
    const d = createDecipheriv('aes-256-gcm', key, Buffer.from(env.iv, 'base64'));
    d.setAAD(Buffer.from(aad));
    d.setAuthTag(Buffer.from(env.tag, 'base64'));
    return JSON.parse(Buffer.concat([d.update(Buffer.from(env.ct, 'base64')), d.final()]).toString('utf8'));
  }
}
