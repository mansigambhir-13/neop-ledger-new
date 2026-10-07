// Ed25519 signing keyrings (jose JWKs), persisted to a 0600 file. Two are used, each in its own process only:
//   · the registry's co-signing key (its public half is published at /.well-known/registry-jwks.json for
//     `neos install` and the package host to verify signatures);
//   · the platform's own key (NEOS_SIGNING_KEY_PATH): conversation stream tokens, checked in the same process, and
//     NeuralChat's routing-model session tokens, whose public half the LLM proxy holds (llm_runner_keys.neuralchat).
// v3 S9: there is no gateway key, no platform JWKS and no rotation schedule — nothing outside the platform verifies
// a platform token except the LLM proxy, which is given the public half.

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
    // Extractable: the ring is written back to its file when a scheduled key activates after a restart.
    const keys = await Promise.all(
      list.map(async (k) => ({ kid: k.kid, privateKey: (await importJWK(k.privateJwk, 'EdDSA', { extractable: true })) as CryptoKey, publicJwk: k.publicJwk, state: k.state, created_at: k.created_at })),
    );
    return new KeyRing(keys, file);
  }
  const ring = new KeyRing([await newKey()], file);
  await ring.save();
  return ring;
}

/** @deprecated name kept for callers: a keyring is the signing keys. */
export type SigningKeys = KeyRing;
