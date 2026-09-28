// v3 §5/§16: only a person can say yes; the reasoning agent NEVER approves. Migration 016's per-bridge
// `may_approve` (a bridge's go-ahead carried as the yes of the person it relays for) is kept as a
// DELIBERATE, EXPLICIT exception: in production it exists only when the platform itself is started with
// NEOS_ALLOW_BRIDGE_APPROVE=1. Without that flag an admin cannot grant it (403 bridge_approve_not_allowed)
// and a row that already says may_approve is treated as false at runtime.

export function bridgeApproveAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NEOS_ENV !== 'production' || env.NEOS_ALLOW_BRIDGE_APPROVE === '1';
}

/** True when a grant is the production exception (audited as `chat.bridge_approve_exception`). */
export function bridgeApproveIsException(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NEOS_ENV === 'production' && env.NEOS_ALLOW_BRIDGE_APPROVE === '1';
}
