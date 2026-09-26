import { createHash } from 'node:crypto';
import { canonicalize } from './jcs.ts';

/** The exact thing a person says yes to (C4). */
export interface FingerprintInput {
  key: string;
  version: string;
  args: unknown;
  company_id: string;
  job_id: string;
}

/** SHA-256 over the RFC 8785 canonical form of {key, version, args, company_id, job_id}. */
export function fingerprint(input: FingerprintInput): string {
  const canonical = canonicalize({
    key: input.key,
    version: input.version,
    args: input.args,
    company_id: input.company_id,
    job_id: input.job_id,
  });
  return 'sha256:' + createHash('sha256').update(canonical, 'utf8').digest('hex');
}

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
