// Shared HTTP plumbing for provider doors: timeouts, and the one rule that
// matters for money and messages — only a definite refusal is "did not happen".

import { DoorError } from './errors.ts';

export async function providerCall(url: string, init: RequestInit & { timeoutMs?: number }): Promise<{ status: number; body: any }> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(init.timeoutMs ?? 15_000), redirect: 'error' });
  } catch (e) {
    // Network error or timeout: the provider may or may not have acted.
    throw new DoorError(`provider unreachable: ${(e as Error).message}`, { definite: false });
  }
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text.slice(0, 500) };
  }
  return { status: res.status, body };
}

/** 4xx except 408/409/425/429 are definite refusals; everything else is indeterminate. */
export function isDefiniteRefusal(status: number): boolean {
  return status >= 400 && status < 500 && ![408, 409, 425, 429].includes(status);
}

export function providerError(what: string, r: { status: number; body: any }): DoorError {
  const msg = r.body?.message ?? r.body?.error?.message ?? r.body?.error ?? r.body?.raw ?? '';
  return new DoorError(`${what}: provider answered ${r.status}${msg ? ` (${String(msg).slice(0, 200)})` : ''}`, { definite: isDefiniteRefusal(r.status) });
}
