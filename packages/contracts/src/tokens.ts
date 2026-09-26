/**
 * Gateway token (JWT, EdDSA, TTL 60 s). Every call into an app's L3 carries one.
 * The app verifies it against the gateway JWKS and never learns what a NEOS user
 * or role is beyond `sub`.
 */
export const GATEWAY_ISSUER = 'neos-gateway';
export const GATEWAY_TOKEN_TTL_S = 60;
export const CONTRACT_VERSION = '1';

export interface GatewayClaims {
  iss: typeof GATEWAY_ISSUER;
  /** The target app key. */
  aud: string;
  /** Caller: `user:<uuid>`, `app:<key>` or `platform`. */
  sub: string;
  /** Null only for platform-wide calls such as outbox reads. */
  company_id: string | null;
  /** The L3 endpoint or ability key this token is good for. */
  ability: string;
  ability_version?: string;
  idem_key: string;
  jti: string;
  /** Switchboard version at mint time; the gate refetches when newer than its cache. */
  sb_version?: number;
  /** Execution tokens only. */
  exec?: true;
  proposal_id?: string;
  fingerprint?: string;
  iat?: number;
  exp?: number;
}

/**
 * Job token: minted by the runner, verified by the gate. Scoped to one job, one
 * session (claim), one company and the abilities switched on at spawn.
 */
export interface JobTokenClaims {
  /** job id */
  sub: string;
  /** session / claim id; must match jobs.claimed_by */
  sid: string;
  company_id: string;
  app: string;
  abilities: string[];
  exp?: number;
}
