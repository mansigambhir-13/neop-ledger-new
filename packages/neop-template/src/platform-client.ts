// Backend → platform internal calls. Authenticated with the app's service
// secret. The assistant never reaches these; it has no route to the platform.
// v3 S1: the switchboard, the installs and the grants are read from the app's own schema
// (gate/switchboard.ts, gate/grants.ts) — never fetched from here.

import type { ManifestAbility, Setting } from '@neop/contracts';

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

  // v3 (S7): no registry calls at run time. Packages are installed at build time (`neos install`: src/packages,
  // packages.lock.json) and pinned skills are read from neos_registry.skills with the app's own role.
  // v3 (S8): door credentials come from the secret store (doors/secrets.ts) and LLM session tokens are minted by
  // the runner (runner/llm.ts); the backend no longer asks the platform for either.
}
