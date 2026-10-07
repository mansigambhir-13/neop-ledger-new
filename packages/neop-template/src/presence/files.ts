// PRESENCE · files attached to a typed task, fetched BY REFERENCE (v3 S5; V3-MIGRATION-PLAN default 7: "attachments:
// refs in the event body"; v3 S9: over Matrix only). A task event never carries bytes: NeuralChat uploads the file to
// the homeserver's media store and puts {id, filename, sha256, bytes, link: mxc://<server>/<media id>} in the task's
// `fields` (contracts readTaskFields). This backend downloads it from ITS OWN homeserver with its own token (the
// authenticated media API) — never from a host the sender names, never from the platform — and what comes back must
// be the size and the sha256 the reference promised, or nothing is kept and the task is refused.

import { createHash } from 'node:crypto';
import type { TaskFileRef } from '@neop/contracts';
import type { Road } from '../runner/inbound.ts';
import { MAX_DOCUMENT_BYTES, type DocumentUpload } from '../doors/documents/index.ts';

export class TaskFileError extends Error {}

/** mxc://<server>/<media id> → its two parts, or null. */
export function parseMxc(uri: string): { server: string; media: string } | null {
  const m = /^mxc:\/\/([^/\s]+)\/([A-Za-z0-9_-]+)$/.exec(uri);
  return m ? { server: m[1]!, media: m[2]! } : null;
}

type BytesFetch = (url: string, init?: any) => Promise<{ ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer> }>;

/**
 * Download one mxc:// URI from the homeserver with an access token (appservice: its as_token and the name it speaks
 * as). The authenticated media endpoint (Matrix v1.11) first; the legacy one if the homeserver is older.
 */
export async function downloadMedia(o: { homeserverUrl: string; token: string; asUser?: string; fetchImpl?: BytesFetch; timeoutMs?: number }, mxc: string, maxBytes: number): Promise<Buffer> {
  const p = parseMxc(mxc);
  if (!p) throw new TaskFileError(`not a Matrix media URI: ${mxc.slice(0, 100)}`);
  const base = o.homeserverUrl.replace(/\/+$/, '');
  const q = o.asUser ? `?user_id=${encodeURIComponent(o.asUser)}` : '';
  const f = (o.fetchImpl ?? (fetch as unknown as BytesFetch));
  const get = (path: string) => f(`${base}${path}/${encodeURIComponent(p.server)}/${encodeURIComponent(p.media)}${q}`, { headers: { authorization: `Bearer ${o.token}` }, signal: AbortSignal.timeout(o.timeoutMs ?? 30_000) });
  let res = await get('/_matrix/client/v1/media/download');
  if (res.status === 404 || res.status === 400) res = await get('/_matrix/media/v3/download');
  if (!res.ok) throw new TaskFileError(`the homeserver answered ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length > maxBytes) throw new TaskFileError(`larger than ${maxBytes} bytes`);
  return bytes;
}

/** Fetch every referenced file (in order) over the road the task came on, and check it; throws TaskFileError naming the first that fails. */
export async function fetchTaskFiles(road: Pick<Road, 'download'>, refs: TaskFileRef[]): Promise<DocumentUpload[]> {
  if (refs.length > 5) throw new TaskFileError('at most 5 files may be attached to a task');
  const out: DocumentUpload[] = [];
  for (const r of refs) {
    if (r.bytes > MAX_DOCUMENT_BYTES) throw new TaskFileError(`${r.filename} is larger than ${MAX_DOCUMENT_BYTES} bytes`);
    if (!parseMxc(r.link)) throw new TaskFileError(`${r.filename}: the link is not a Matrix media URI`);
    if (!road.download) throw new TaskFileError(`${r.filename} could not be fetched (this road cannot download media)`);
    let bytes: Buffer;
    try {
      bytes = await road.download(r.link, MAX_DOCUMENT_BYTES);
    } catch (e) {
      throw new TaskFileError(`${r.filename} could not be fetched (${String((e as Error).message ?? e).slice(0, 200)})`);
    }
    if (bytes.length !== r.bytes || createHash('sha256').update(bytes).digest('hex') !== r.sha256) throw new TaskFileError(`${r.filename} is not the file that was attached (size or sha256 differ)`);
    out.push({ filename: r.filename, ...(r.content_type ? { content_type: r.content_type } : {}), content_base64: bytes.toString('base64') });
  }
  return out;
}
