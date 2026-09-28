// LLM session tokens, minted by the runner itself (v3: no platform call). The backend holds an
// Ed25519 signing key the LLM proxy trusts for this app only (the proxy has the public half);
// each assistant session gets one short-lived token scoped to one job, one session and one
// company, with the budget read from this app's own switchboard. The agent holds that token and
// nothing else; the proxy (ops infrastructure) holds the provider key and meters spend.

import { randomUUID } from 'node:crypto';
import { importJWK, SignJWT, type JWK } from 'jose';

/** Issuer of runner-minted tokens; the proxy checks `sub` is `app:<app>` for the key it matched. */
export const runnerIssuer = (app: string) => `neop-runner:${app}`;
export const LLM_AUDIENCE = 'llm-proxy';

export interface LlmConfig {
  /** Where agents reach the LLM proxy (Anthropic Messages-compatible). */
  proxyUrl: string;
  /** Private Ed25519 JWK (with `kid`) the proxy trusts for this app. Injected into the backend only. */
  signingKey: JWK;
}

export interface LlmSessionRequest {
  company_id: string;
  job_id: string;
  sid: string;
  ttl_seconds: number;
  budget: { per_job_usd?: number; per_day_usd?: number };
  /** The company's time zone: the day cap is a company day. */
  tz: string;
}

export class LlmSessions {
  readonly app: string;
  readonly proxyUrl: string;
  private readonly jwk: JWK;
  private key: Promise<CryptoKey | Uint8Array> | null = null;

  constructor(app: string, cfg: LlmConfig) {
    if (cfg.signingKey?.kty !== 'OKP' || cfg.signingKey.crv !== 'Ed25519' || !cfg.signingKey.d) throw new Error('llm signing key must be a private Ed25519 JWK');
    if (!cfg.signingKey.kid) throw new Error('llm signing key needs a kid');
    this.app = app;
    this.proxyUrl = cfg.proxyUrl.replace(/\/$/, '');
    this.jwk = cfg.signingKey;
  }

  /** One token for one assistant session. Same claims the proxy has always metered on. */
  async mint(r: LlmSessionRequest): Promise<{ base_url: string; token: string }> {
    this.key ??= importJWK(this.jwk, 'EdDSA');
    const token = await new SignJWT({
      company_id: r.company_id,
      job_id: r.job_id,
      sid: r.sid,
      budget_micros: Math.round(Number(r.budget?.per_job_usd ?? 5) * 1_000_000),
      day_cap_micros: Math.round(Number(r.budget?.per_day_usd ?? 50) * 1_000_000),
      tz: r.tz,
    })
      .setProtectedHeader({ alg: 'EdDSA', kid: this.jwk.kid!, typ: 'JWT' })
      .setIssuer(runnerIssuer(this.app))
      .setAudience(LLM_AUDIENCE)
      .setSubject(`app:${this.app}`)
      .setJti(randomUUID())
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + Math.max(60, r.ttl_seconds))
      .sign(await this.key);
    return { base_url: this.proxyUrl, token };
  }
}

/** A fresh keypair for one app: the private JWK for its backend, the public JWK for the proxy. */
export async function generateLlmSigningKey(kid = `llm-${randomUUID().slice(0, 8)}`): Promise<{ privateJwk: JWK; publicJwk: JWK }> {
  const { generateKeyPair, exportJWK } = await import('jose');
  const { privateKey, publicKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
  const privateJwk = { ...(await exportJWK(privateKey)), kid, alg: 'EdDSA' };
  const publicJwk = { ...(await exportJWK(publicKey)), kid, alg: 'EdDSA' };
  return { privateJwk, publicJwk };
}
