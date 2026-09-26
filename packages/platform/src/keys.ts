// Gateway signing keyring (R10). Rotation is three-phase, like any JWKS issuer:
//   rotate()   publish a new key as `next` (in the JWKS, not yet signing)
//   activate() once every verifier's JWKS cache has refreshed, it signs;
//              the old key becomes `previous` and still verifies
//   retirePrevious() after 2× token TTL, the old key leaves the JWKS
// Signing with a key before verifiers can know it would fail every call.

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { exportJWK, generateKeyPair, importJWK, type JWK } from 'jose';

export interface SigningKey {
  kid: string;
  privateKey: CryptoKey;
  publicJwk: JWK;
  state: 'next' | 'active' | 'previous' | 'retired';
  created_at: string;
}

interface Persisted {
  keys: { kid: string; privateJwk: JWK; publicJwk: JWK; state: SigningKey['state']; created_at: string }[];
}

export class KeyRing {
  keys: SigningKey[];
  private readonly file: string | null;
  constructor(keys: SigningKey[], file: string | null = null) {
    this.keys = keys;
    this.file = file;
  }

  get active(): SigningKey {
    const k = this.keys.find((x) => x.state === 'active');
    if (!k) throw new Error('keyring has no active key');
    return k;
  }

  /** Back-compat: the active key's id and private key. */
  get kid(): string {
    return this.active.kid;
  }
  get privateKey(): CryptoKey {
    return this.active.privateKey;
  }

  jwks(): { keys: JWK[] } {
    return { keys: this.keys.filter((k) => k.state !== 'retired').map((k) => k.publicJwk) };
  }

  /** Pre-publish a new key: verifiers can fetch it before anything is signed with it. */
  async rotate(): Promise<SigningKey> {
    if (this.keys.some((k) => k.state === 'next')) throw new Error('a rotation is already in progress; activate it first');
    const k = { ...(await newKey()), state: 'next' as const };
    this.keys.push(k);
    this.keys = this.keys.filter((x) => x.state !== 'retired' || Date.now() - Date.parse(x.created_at) < 30 * 86_400_000);
    await this.save();
    return k;
  }

  /** Start signing with the pre-published key; the old active key still verifies as previous. */
  async activate(): Promise<SigningKey> {
    const next = this.keys.find((k) => k.state === 'next');
    if (!next) throw new Error('no pre-published key to activate; rotate first');
    for (const k of this.keys) if (k.state === 'previous') k.state = 'retired';
    for (const k of this.keys) if (k.state === 'active') k.state = 'previous';
    next.state = 'active';
    await this.save();
    return next;
  }

  /** Stop publishing the previous key (after 2× token TTL has passed). */
  async retirePrevious(): Promise<void> {
    for (const k of this.keys) if (k.state === 'previous') k.state = 'retired';
    await this.save();
  }

  async save(): Promise<void> {
    if (!this.file) return;
    const out: Persisted = {
      keys: await Promise.all(
        this.keys.map(async (k) => ({ kid: k.kid, privateJwk: await exportJWK(k.privateKey), publicJwk: k.publicJwk, state: k.state, created_at: k.created_at })),
      ),
    };
    await mkdir(path.dirname(this.file), { recursive: true });
    await writeFile(this.file, JSON.stringify(out), { mode: 0o600 });
  }
}

async function newKey(): Promise<SigningKey> {
  const { privateKey, publicKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
  const kid = randomUUID();
  return {
    kid,
    privateKey: privateKey as CryptoKey,
    publicJwk: { ...(await exportJWK(publicKey)), kid, alg: 'EdDSA', use: 'sig' },
    state: 'active',
    created_at: new Date().toISOString(),
  };
}

/** Ephemeral keyring (tests). */
export async function generateSigningKeys(): Promise<KeyRing> {
  return new KeyRing([await newKey()]);
}

/** Dev/ops: a keyring persisted to a file (0600). Production keeps this file in the secret store. */
export async function loadOrCreateSigningKeys(file: string): Promise<KeyRing> {
  const raw = await readFile(file, 'utf8').catch(() => null);
  if (raw) {
    const parsed = JSON.parse(raw) as Persisted | { kid: string; privateJwk: JWK; publicJwk: JWK };
    const list = 'keys' in parsed ? parsed.keys : [{ ...parsed, state: 'active' as const, created_at: new Date().toISOString() }];
    const keys = await Promise.all(
      list.map(async (k) => ({ kid: k.kid, privateKey: (await importJWK(k.privateJwk, 'EdDSA')) as CryptoKey, publicJwk: k.publicJwk, state: k.state, created_at: k.created_at })),
    );
    return new KeyRing(keys, file);
  }
  const ring = new KeyRing([await newKey()], file);
  await ring.save();
  return ring;
}

/** @deprecated name kept for callers: a keyring is the signing keys. */
export type SigningKeys = KeyRing;
