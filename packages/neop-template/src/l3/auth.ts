// Every call into an app is one signed request from the gateway (B4). The app
// verifies it with the gateway's public keys (JWKS) and never learns more
// about the caller than the claims say.

import { CONTRACT_VERSION, GATEWAY_ISSUER, GATEWAY_TOKEN_TTL_S, type GatewayClaims } from '@neop/contracts';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import type { Pool } from '@neop/pgkit';

export class AuthError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export class GatewayAuth {
  private jwks: JWTVerifyGetKey;
  readonly app: string;
  private readonly runnerPool: Pool;
  private readonly schema: string;
  constructor(opts: { jwksUrl: string; app: string; runnerPool: Pool; schema: string; cacheMs?: number }) {
    // A retired (e.g. compromised) key stops being trusted within cacheMs (R10).
    const cacheMs = opts.cacheMs ?? 60_000;
    this.jwks = createRemoteJWKSet(new URL(opts.jwksUrl), { cooldownDuration: Math.min(5_000, cacheMs), cacheMaxAge: cacheMs });
    this.app = opts.app;
    this.runnerPool = opts.runnerPool;
    this.schema = opts.schema;
  }

  /** Verify signature, issuer, audience, age; then burn the jti (single use). */
  async verify(token: string | null | undefined, expect: { ability: string; contractVersion?: string | null }): Promise<GatewayClaims> {
    if (!token) throw new AuthError(401, 'unauthenticated', 'missing bearer token');
    if (expect.contractVersion !== undefined && expect.contractVersion !== CONTRACT_VERSION) {
      throw new AuthError(400, 'contract_version', `Contract-Version must be ${CONTRACT_VERSION}`);
    }
    let claims: GatewayClaims;
    try {
      const { payload } = await jwtVerify(token, this.jwks, {
        issuer: GATEWAY_ISSUER,
        audience: this.app,
        algorithms: ['EdDSA'],
        maxTokenAge: `${GATEWAY_TOKEN_TTL_S + 5}s`,
        requiredClaims: ['jti', 'sub', 'exp', 'iat'],
      });
      claims = payload as unknown as GatewayClaims;
    } catch (e) {
      throw new AuthError(401, 'unauthenticated', `invalid gateway token: ${(e as Error).message}`);
    }
    if (claims.ability !== expect.ability) {
      throw new AuthError(403, 'wrong_ability', `token is for ${claims.ability}, not ${expect.ability}`);
    }
    const r = await this.runnerPool.query(
      `insert into ${this.schema}.seen_tokens (jti, expires_at) values ($1, to_timestamp($2)) on conflict do nothing`,
      [claims.jti, claims.exp],
    );
    if (!r.rowCount) throw new AuthError(401, 'replayed', 'token already used');
    return claims;
  }

  /** An execution token: single use, minted only when the platform holds a matching yes. */
  async verifyExecution(token: string, expect: { company_id: string; proposal_id: string; fingerprint: string }): Promise<GatewayClaims> {
    const claims = await this.verify(token, { ability: 'proposals.execute' });
    if (!claims.exec) throw new AuthError(403, 'not_execution_token', 'not an execution token');
    if (claims.company_id !== expect.company_id) throw new AuthError(403, 'customer_mismatch', 'company mismatch');
    if (claims.proposal_id !== expect.proposal_id || claims.fingerprint !== expect.fingerprint) {
      throw new AuthError(409, 'fingerprint_mismatch', 'execution token is bound to a different proposal or fingerprint');
    }
    return claims;
  }

  async pruneSeen(): Promise<void> {
    await this.runnerPool.query(`delete from ${this.schema}.seen_tokens where expires_at < now() - interval '5 minutes'`);
  }
}
