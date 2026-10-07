/** The contract version an app registers with (manifest.contract_version). */
export const CONTRACT_VERSION = '1';

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
