// PRESENCE · files attached to a typed task, fetched BY REFERENCE (v3 S5; V3-MIGRATION-PLAN default 7: "attachments:
// refs in the event body"). A task event never carries bytes: NeuralChat puts {id, filename, sha256, bytes, link} in its
// `fields` (contracts readTaskFields). The link is a PATH on the platform, resolved here against this backend's own
// configured platform URL — never a host the sender names — signed and short-lived by the platform. What comes back
// must be the size and the sha256 the reference promised, or nothing is kept and the task is refused.

import { createHash } from 'node:crypto';
import type { TaskFileRef } from '@neop/contracts';
import type { Core } from '../core.ts';
import { MAX_DOCUMENT_BYTES, type DocumentUpload } from '../doors/documents/index.ts';

export class TaskFileError extends Error {}

/** Fetch every referenced file (in order) and check it; throws TaskFileError naming the first that fails. */
export async function fetchTaskFiles(core: Core, refs: TaskFileRef[], o: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}): Promise<DocumentUpload[]> {
  if (refs.length > 5) throw new TaskFileError('at most 5 files may be attached to a task');
  const base = new URL(core.cfg.platformUrl);
  const out: DocumentUpload[] = [];
  for (const r of refs) {
    if (r.bytes > MAX_DOCUMENT_BYTES) throw new TaskFileError(`${r.filename} is larger than ${MAX_DOCUMENT_BYTES} bytes`);
    const url = new URL(r.link, base);
    if (url.origin !== base.origin) throw new TaskFileError(`${r.filename}: the link does not point at the platform`);
    let res: Response;
    try {
      res = await (o.fetchImpl ?? fetch)(url, { signal: AbortSignal.timeout(o.timeoutMs ?? 30_000) });
    } catch (e) {
      throw new TaskFileError(`${r.filename} could not be fetched (${String((e as Error).message ?? e).slice(0, 200)})`);
    }
    if (!res.ok) throw new TaskFileError(`${r.filename} could not be fetched (the platform answered ${res.status})`);
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length !== r.bytes || createHash('sha256').update(bytes).digest('hex') !== r.sha256) throw new TaskFileError(`${r.filename} is not the file that was attached (size or sha256 differ)`);
    out.push({ filename: r.filename, ...(r.content_type ? { content_type: r.content_type } : {}), content_base64: bytes.toString('base64') });
  }
  return out;
}
