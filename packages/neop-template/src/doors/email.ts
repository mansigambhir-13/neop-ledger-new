import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DoorError } from './errors.ts';
import { providerCall, providerError } from './http.ts';
import type { DoorJournal } from './journal.ts';

export interface EmailMessage {
  to: string[];
  subject: string;
  text: string;
  attachments?: { filename: string; content: string; contentType: string }[];
}

export interface SentRecord extends EmailMessage {
  id: string;
  idempotency_key: string;
  sent_at: string;
  /** Provider delivery state when known (e.g. Resend: sent, delivered, bounced). */
  last_event?: string | null;
}

/** How long an approved send may still be recovered by re-sending (default 10 min; Resend keeps keys 24 h). */
export function recoveryWindowMs(): number {
  return Number(process.env.NEOP_DOOR_RECOVERY_MS ?? 10 * 60_000);
}

/**
 * Email door. The provider is chosen by the credential the vault lends for
 * this call:
 *   { provider: 'resend', api_key, from, base_url? }   production (Resend API)
 *   { provider: 'dev-mailbox', dir }                     local mailbox (dev/tests)
 * Contract (S1): send with a door-level idempotency key; look the message up by
 * that key for read-back. The door journal makes lookup exact even when the
 * process died between the provider accepting the message and recording it.
 */
export class EmailDoor {
  private readonly borrow: () => Promise<Record<string, unknown>>;
  private readonly journal: DoorJournal | null;
  constructor(borrow: () => Promise<Record<string, unknown>>, journal: DoorJournal | null = null) {
    this.borrow = borrow;
    this.journal = journal;
  }

  private static validate(msg: EmailMessage): void {
    if (!msg.to.length) throw new DoorError('no recipients', { definite: true });
    for (const a of msg.to) {
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(a)) throw new DoorError(`invalid address ${a}`, { definite: true });
    }
  }

  async send(msg: EmailMessage, idempotencyKey: string): Promise<{ id: string }> {
    EmailDoor.validate(msg);
    const cred = await this.borrow();
    if (cred.provider === 'resend') return this.resendSend(cred, msg, idempotencyKey);
    if (cred.provider === 'dev-mailbox') return this.mailboxSend(cred, msg, idempotencyKey);
    throw new DoorError(`email provider ${String(cred.provider)} is not supported`, { definite: true });
  }

  async lookup(idempotencyKey: string): Promise<SentRecord | null> {
    const cred = await this.borrow();
    if (cred.provider === 'resend') return this.resendLookup(cred, idempotencyKey);
    if (cred.provider === 'dev-mailbox') return this.mailboxLookup(cred, idempotencyKey);
    throw new DoorError(`email provider ${String(cred.provider)} is not supported`, { definite: true });
  }

  // ── Resend ──────────────────────────────────────────────────────────────
  private base(cred: Record<string, unknown>): string {
    return String(cred.base_url ?? 'https://api.resend.com').replace(/\/$/, '');
  }

  private payload(cred: Record<string, unknown>, msg: EmailMessage) {
    if (typeof cred.from !== 'string' || typeof cred.api_key !== 'string') throw new DoorError('resend credential needs api_key and from', { definite: true });
    return {
      from: cred.from,
      to: msg.to,
      subject: msg.subject,
      text: msg.text,
      ...(msg.attachments?.length
        ? { attachments: msg.attachments.map((a) => ({ filename: a.filename, content: Buffer.from(a.content, 'utf8').toString('base64'), content_type: a.contentType })) }
        : {}),
    };
  }

  private async post(cred: Record<string, unknown>, payload: unknown, key: string): Promise<string> {
    const r = await providerCall(`${this.base(cred)}/emails`, {
      method: 'POST',
      headers: { authorization: `Bearer ${cred.api_key}`, 'content-type': 'application/json', 'idempotency-key': key },
      body: JSON.stringify(payload),
    });
    if (r.status >= 200 && r.status < 300 && typeof r.body?.id === 'string') return r.body.id;
    throw providerError('email send', r);
  }

  private async resendSend(cred: Record<string, unknown>, msg: EmailMessage, key: string): Promise<{ id: string }> {
    if (!this.journal) throw new DoorError('the resend provider needs a door journal', { definite: true });
    // Write-ahead: the exact payload is recorded first, and every retry sends that same payload.
    const j = await this.journal.begin('email', key, 'resend', this.payload(cred, msg));
    if (j.provider_ref) return { id: j.provider_ref };
    if (j.status === 'rejected') throw new DoorError('this send was closed without going out; a new approval is needed', { definite: true });
    try {
      const id = await this.post(cred, j.payload, key);
      await this.journal.accept('email', key, id);
      return { id };
    } catch (e) {
      if (e instanceof DoorError && e.definite) await this.journal.reject('email', key, e.message);
      throw e;
    }
  }

  private async resendLookup(cred: Record<string, unknown>, key: string): Promise<SentRecord | null> {
    const j = this.journal ? await this.journal.get('email', key) : null;
    if (!j || j.status === 'rejected') return null; // never sent, or definitely refused
    let id = j.provider_ref;
    if (!id) {
      // No id recorded: the provider's answer was lost (or never came). Within the recovery
      // window, the identical payload under the same key makes the provider return the
      // original id — or send it now, exactly once. Past the window, it did not happen, and
      // the entry is closed so nothing goes out late.
      if (j.age_ms > recoveryWindowMs()) {
        await this.journal!.reject('email', key, 'recovery window passed without a provider id');
        return null;
      }
      id = await this.post(cred, j.payload, key);
      await this.journal!.accept('email', key, id);
    }
    const r = await providerCall(`${this.base(cred)}/emails/${encodeURIComponent(id)}`, { method: 'GET', headers: { authorization: `Bearer ${cred.api_key}` } });
    if (r.status === 404) return null;
    if (r.status !== 200) throw providerError('email lookup', r);
    const b = r.body ?? {};
    return {
      id,
      idempotency_key: key,
      to: Array.isArray(b.to) ? b.to : j.payload.to,
      subject: b.subject ?? j.payload.subject,
      text: j.payload.text,
      sent_at: b.created_at ?? new Date().toISOString(),
      last_event: b.last_event ?? null,
    };
  }

  // ── dev mailbox ─────────────────────────────────────────────────────────
  private static file(dir: string, key: string): string {
    return path.join(dir, key.replace(/[^a-zA-Z0-9_.-]/g, '_') + '.json');
  }

  private async mailboxDir(cred: Record<string, unknown>): Promise<string> {
    if (typeof cred.dir !== 'string') throw new DoorError('dev-mailbox credential needs dir', { definite: true });
    await mkdir(cred.dir, { recursive: true });
    return cred.dir;
  }

  private async mailboxSend(cred: Record<string, unknown>, msg: EmailMessage, key: string): Promise<{ id: string }> {
    const dir = await this.mailboxDir(cred);
    const f = EmailDoor.file(dir, key);
    const existing = await readFile(f, 'utf8').catch(() => null);
    if (existing) return { id: (JSON.parse(existing) as SentRecord).id };
    const rec: SentRecord = { ...msg, id: `msg_${key.slice(-12)}`, idempotency_key: key, sent_at: new Date().toISOString() };
    await writeFile(f, JSON.stringify(rec, null, 2), { flag: 'wx' }).catch((e) => {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    });
    return { id: rec.id };
  }

  private async mailboxLookup(cred: Record<string, unknown>, key: string): Promise<SentRecord | null> {
    const dir = await this.mailboxDir(cred);
    const raw = await readFile(EmailDoor.file(dir, key), 'utf8').catch(() => null);
    return raw ? (JSON.parse(raw) as SentRecord) : null;
  }
}
