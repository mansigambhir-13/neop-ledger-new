// Backend → platform internal calls. Authenticated with the app's service
// secret. The assistant never reaches these; it has no route to the platform.
// v3 S1: the switchboard, the installs and the grants are read from the app's own schema
// (gate/switchboard.ts, gate/grants.ts) — never fetched from here.

import type { ManifestAbility, Setting } from '@neop/contracts';
import { DoorError } from './doors/errors.ts';

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

  async borrowDescribe(req: { company_id: string; app?: string; ability: string }): Promise<{ ability: ManifestAbility; owner_setting: Setting; acl: boolean; owner?: string }> {
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

  /** An a2a hand-off; with `ability`/`args` it is a borrowed write (v3 §10): one step the owner proposes and a person approves there. */
  async openA2A(req: { company_id: string; target: string; ask: string; parent_task_id: string | null; host_job_id: string; ability?: string; args?: unknown }): Promise<{ status: number; body: any }> {
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
    // No credential for this door (404) or not allowed (403): nothing was sent, so the outcome is definite.
    if (r.status === 404 || r.status === 403) throw new DoorError(`${door} is not connected for this company (vault ${r.status})`, { definite: true });
    if (r.status !== 200) throw new Error(`vault refused ${door}: ${r.status}`);
    return r.body.secret;
  }
}
