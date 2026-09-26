import type { JobTokenClaims } from '@neop/contracts';
import { SignJWT, jwtVerify } from 'jose';

/**
 * S5: the agent container can reach its backend, so the gate must know the call
 * came from the session the runner started for this job. The runner mints an
 * HS256 token (the secret never leaves the backend) scoped to one job, one
 * session, one company and the abilities switched on at spawn.
 */
export class JobTokens {
  /** First key signs; every key verifies (rotation, R10). */
  private keys: Uint8Array[];
  readonly app: string;
  constructor(secret: string | string[], app: string) {
    const list = (Array.isArray(secret) ? secret : secret.split(',')).map((s) => s.trim()).filter(Boolean);
    if (!list.length || list.some((s) => s.length < 32)) throw new Error('job token secrets must be at least 32 characters');
    this.keys = list.map((s) => new TextEncoder().encode(s));
    this.app = app;
  }

  async mint(c: Omit<JobTokenClaims, 'exp' | 'app'>, ttlMs: number): Promise<string> {
    return new SignJWT({ sid: c.sid, company_id: c.company_id, app: this.app, abilities: c.abilities })
      .setProtectedHeader({ alg: 'HS256', typ: 'neop-job' })
      .setSubject(c.sub)
      .setIssuedAt()
      .setExpirationTime(Math.floor((Date.now() + ttlMs) / 1000))
      .sign(this.keys[0]!);
  }

  async verify(token: string): Promise<JobTokenClaims> {
    let lastErr: unknown;
    for (const key of this.keys) {
      try {
        return await this.verifyWith(token, key);
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr;
  }

  private async verifyWith(token: string, key: Uint8Array): Promise<JobTokenClaims> {
    const { payload, protectedHeader } = await jwtVerify(token, key, { algorithms: ['HS256'] });
    if (protectedHeader.typ !== 'neop-job') throw new Error('not a job token');
    if (payload.app !== this.app) throw new Error('job token for another app');
    return payload as unknown as JobTokenClaims;
  }
}
