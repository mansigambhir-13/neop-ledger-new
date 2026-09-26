// Backend → platform internal calls. Authenticated with the app's service
// secret. The assistant never reaches these; it has no route to the platform.

import type { ManifestAbility, Setting } from '@neop/contracts';

export interface SwitchboardDoc {
  version: number;
  /** Company settings by ability key (can only tighten the floor). */
  settings: Record<string, Setting>;
  rules: unknown[];
  budget: { per_job_usd?: number; per_day_usd?: number };
  company: { id: string; name: string; time_zone: string };
}

export interface GrantTokenRequest {
  company_id: string;
  job_id: string;
  proposal_id: string;
  ability_key: string;
  ability_version: string;
  fingerprint: string;
  amount_minor?: number;
  currency?: string;
  recipients?: string[];
}

export class PlatformClient {
  readonly base: string;
  readonly app: string;
  readonly secret: string;
  constructor(base: string, app: string, secret: string) {
    this.base = base.replace(/\/$/, '');
    this.app = app;
    this.secret = secret;
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
    const res = await fetch(this.base + path, {
      method,
      headers: {
        authorization: `Service ${this.app}:${this.secret}`,
        'content-type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
  }

  async switchboard(companyId: string): Promise<SwitchboardDoc> {
    const r = await this.call<SwitchboardDoc>('GET', `/internal/switchboard?company_id=${encodeURIComponent(companyId)}`);
    if (r.status !== 200) throw new Error(`switchboard fetch failed: ${r.status}`);
    return r.body;
  }

  /** Ask for an execution token under a standing grant. Null when no grant covers it. */
  async grantExecutionToken(req: GrantTokenRequest): Promise<{ token: string; grant_id: string } | null> {
    const r = await this.call<{ token: string; grant_id: string } | { error: string }>('POST', '/internal/grants/execution-token', req);
    if (r.status === 200) return r.body as { token: string; grant_id: string };
    if (r.status === 404 || r.status === 409) return null;
    throw new Error(`grant token request failed: ${r.status}`);
  }

  async borrowDescribe(req: { company_id: string; app: string; ability: string }): Promise<{ ability: ManifestAbility; owner_setting: Setting; acl: boolean }> {
    const r = await this.call<any>('POST', '/internal/borrow/describe', req);
    if (r.status !== 200) throw new Error(`borrow describe ${req.app}.${req.ability}: ${r.status}`);
    return r.body;
  }

  /** Call another app through the gateway as this app (borrowed reads). */
  async gatewayCall(req: { company_id: string; app: string; endpoint: string; body?: unknown; idem_key: string }): Promise<{ status: number; body: any; request_id: string | null }> {
    const r = await this.call<any>('POST', '/internal/gateway/call', req);
    if (r.status === 200) return r.body;
    return { status: r.status, body: r.body, request_id: null };
  }

  async openA2A(req: { company_id: string; target: string; ask: string; parent_task_id: string | null; host_job_id: string }): Promise<{ status: number; body: any }> {
    return this.call<any>('POST', '/internal/a2a/open', req);
  }

  async registryEntries(companyId: string): Promise<any[]> {
    const r = await this.call<{ entries: any[] }>('GET', `/internal/registry/entries?company_id=${encodeURIComponent(companyId)}`);
    if (r.status !== 200) throw new Error(`registry entries: ${r.status}`);
    return r.body.entries;
  }

  async registryArtifact(hash: string): Promise<string> {
    const r = await this.call<{ base64: string }>('GET', `/internal/registry/artifacts/${encodeURIComponent(hash)}`);
    if (r.status !== 200) throw new Error(`artifact ${hash}: ${r.status}`);
    return r.body.base64;
  }

  /** An LLM session token for one assistant session; null when the platform runs no proxy. */
  async llmSession(req: { company_id: string; job_id: string; sid: string; ttl_seconds: number }): Promise<{ base_url: string; token: string } | null> {
    const r = await this.call<{ base_url: string; token: string }>('POST', '/internal/llm/session', req);
    if (r.status === 200) return r.body;
    if (r.status === 404) return null;
    throw new Error(`llm session refused: ${r.status}`);
  }

  /** Borrow a door credential for one call. */
  async lend(companyId: string, door: string): Promise<Record<string, unknown>> {
    const r = await this.call<{ secret: Record<string, unknown> }>('POST', '/internal/vault/lend', { company_id: companyId, door });
    if (r.status !== 200) throw new Error(`vault refused ${door}: ${r.status}`);
    return r.body.secret;
  }
}
