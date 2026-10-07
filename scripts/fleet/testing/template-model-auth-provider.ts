import { readFileSync } from 'node:fs';
import path from 'node:path';
import { decodeJwt, importJWK, jwtVerify } from 'jose';
import { generateLlmSigningKey, LLM_AUDIENCE, LlmSessions, runnerIssuer } from '../../../packages/neop-template/src/runner/llm.ts';
import { proxyModel } from '../../../packages/neop-template/src/agent/index.ts';
import { PINNED_TEMPLATE_COMMIT } from '../template-alignment.ts';
import type { FleetApp } from '../runtime/apps.ts';

export async function templateModelAuthProviderProblems(root: string, app: FleetApp): Promise<string[]> {
  const problems: string[] = [];
  const decision = JSON.parse(readFileSync(path.join(root, 'fleet/template-provider.json'), 'utf8')) as any;
  if (decision.schema_version !== 1 || decision.template_commit !== PINNED_TEMPLATE_COMMIT || decision.selected_contract !== 'runner-signed-keyless-proxy') problems.push(`${app} provider decision is invalid`);
  if (decision.direct_agent_provider_credentials !== false || decision.chatgpt_or_codex_plan_login_in_agent !== false || decision.fallback !== 'fail-closed-with-audited-retry') problems.push(`${app} provider decision weakens the keyless boundary`);
  if (!Array.isArray(decision.upstreams) || !decision.upstreams.includes('openrouter-anthropic-compatible')) problems.push(`${app} provider decision omits OpenRouter compatibility`);

  const primary = await generateLlmSigningKey(`llm-${app}`);
  const foreign = await generateLlmSigningKey('llm-foreign');
  const sessions = new LlmSessions(app, { proxyUrl: 'http://llm-proxy:4200/v1', signingKey: primary.privateJwk });
  const request = { company_id: '00000000-0000-4000-8000-000000000001', job_id: '00000000-0000-4000-8000-000000000002', sid: '00000000-0000-4000-8000-000000000003', ttl_seconds: 60, budget: { per_job_usd: 1, per_day_usd: 5 }, tz: 'UTC' };
  const minted = await sessions.mint(request);
  try {
    const key = await importJWK(primary.publicJwk, 'EdDSA');
    const verified = await jwtVerify(minted.token, key, { issuer: runnerIssuer(app), audience: LLM_AUDIENCE, subject: `app:${app}`, algorithms: ['EdDSA'] });
    if (verified.payload.company_id !== request.company_id || verified.payload.job_id !== request.job_id || verified.payload.sid !== request.sid) problems.push(`${app} model session is not bound to company/job/session`);
  } catch (error) { problems.push(`${app} model session did not verify: ${(error as Error).message}`); }
  try {
    const wrong = await importJWK(foreign.publicJwk, 'EdDSA');
    await jwtVerify(minted.token, wrong, { issuer: runnerIssuer(app), audience: LLM_AUDIENCE, subject: `app:${app}` });
    problems.push(`${app} model session verified with a foreign/revoked key`);
  } catch { /* expected */ }
  try {
    const model = proxyModel({ NEOP_LLM_MODEL: 'fixture-model', NEOP_LLM_PROVIDER: 'proxy' })({} as any, { base_url: minted.base_url, token: minted.token });
    if (model.getApiKey?.(model.model.provider) !== minted.token || model.model.baseUrl !== minted.base_url) problems.push(`${app} agent did not use only its runner session`);
    try { proxyModel({})({} as any, null); problems.push(`${app} agent fell back without a session token`); } catch { /* expected */ }
  } catch (error) { problems.push(`${app} keyless model binding failed: ${(error as Error).message}`); }
  const concurrent = await Promise.all(Array.from({ length: 24 }, (_, index) => sessions.mint({ ...request, sid: `00000000-0000-4000-8000-${String(index + 10).padStart(12, '0')}` })));
  if (new Set(concurrent.map((entry) => decodeJwt(entry.token).jti)).size !== concurrent.length) problems.push(`${app} concurrent model sessions reuse token identity`);
  const proxy = readFileSync(path.join(root, 'packages/platform/src/llm/proxy.ts'), 'utf8');
  for (const marker of ["auth?: 'x-api-key' | 'bearer'", 'modelPrefix?: string', 'pg_advisory_xact_lock', 'refused_budget', 'upstream_error']) if (!proxy.includes(marker)) problems.push(`${app} model proxy is missing ${marker}`);
  return [...new Set(problems)].sort();
}
