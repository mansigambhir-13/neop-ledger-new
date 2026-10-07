// Conformance at registration (plan, Test bar: "The platform registers an app only
// when all template tests pass"). scripts/conformance.ts runs the required suites
// against the app and writes an attestation bound to the exact manifest (JCS hash);
// registerApp refuses in production without one that matches and is green.

import { canonicalize, sha256Tagged, type Manifest } from '@neop/contracts';

/** The V3 template bar, plus the shared testkit conformance suite. */
export const REQUIRED_SUITES = [
  'contract',
  'proposal',
  'switchboard',
  'resume',
  'injection',
  'a2a',
  'honesty',
  'migration',
  'tenant',
  'wake-order',
  // Matrix is the only ingress in V3. Together these replace the deleted
  // gateway-token inbound-auth suite: appservice token/room binding, sender
  // classes, redelivery idempotency, and typed-event authorization.
  'appservice-auth',
  'presence-sender',
  'presence-dedupe',
  'presence-typed',
  'jobtoken',
  'network',
  'conformance',
] as const;

export interface ConformanceAttestation {
  app: string;
  /** sha256 over the RFC 8785 canonical form of the manifest that was tested. */
  manifest_sha256: string;
  commit: string;
  suites: { name: string; file: string; passed: number; failed: number }[];
  failed: number;
  generated_at: string;
}

export function manifestSha256(manifest: Manifest | unknown): string {
  return sha256Tagged(canonicalize(manifest));
}

/** Null when the attestation proves this manifest passed every required suite; else what is wrong. */
export function attestationProblem(att: unknown, app: string, manifest: Manifest): string | null {
  const a = att as Partial<ConformanceAttestation> | null;
  if (!a || typeof a !== 'object') return 'no conformance attestation';
  if (a.app !== app) return `attestation is for ${JSON.stringify(a.app)}, not ${app}`;
  if (a.manifest_sha256 !== manifestSha256(manifest)) return 'attestation was made for a different manifest (manifest_sha256 does not match)';
  if (typeof a.commit !== 'string' || !a.commit) return 'attestation names no commit';
  if (typeof a.generated_at !== 'string' || Number.isNaN(Date.parse(a.generated_at))) return 'attestation has no generated_at';
  if (!Array.isArray(a.suites)) return 'attestation lists no suites';
  if (a.failed !== 0) return `attestation reports ${String(a.failed)} failed test(s)`;
  for (const name of REQUIRED_SUITES) {
    const s = a.suites.find((x) => x?.name === name);
    if (!s) return `required suite ${name} is missing from the attestation`;
    if (!(Number.isInteger(s.passed) && s.passed > 0)) return `required suite ${name} passed no tests`;
    if (s.failed !== 0) return `required suite ${name} has ${s.failed} failed test(s)`;
  }
  return null;
}
