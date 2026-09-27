// THE DOCUMENTS DOOR — a reading door. It turns the bytes of an uploaded file
// into text, deterministically, and does nothing else: the text layer of a PDF,
// the cells of an XLSX workbook, a CSV / TSV / text file as rows. No model, no
// network, no writes: doors hold no model (v3 §13). Structuring what was read —
// which bill, which lines, which accounts — is the assistant's job, inside a job,
// where the text arrives as untrusted data and every write it leads to goes
// through the gate as a proposal. A scan or a photo has no text layer here and is
// refused plainly rather than guessed at.
//
// Ported from the Ledger documents door (src/doors/documents/*.mjs) and made
// stricter: ToUnicode fonts, line structure, sheet names and date cells, CSV
// quoting and delimiter sniffing, size limits, and a content hash.

import { createHash } from 'node:crypto';
import { decodeText, parseDelimited, toCsv } from './csv.ts';
import { extractPdfText } from './pdf.ts';
import { extractXlsx, type Sheet } from './xlsx.ts';

export { parseDelimited, toCsv } from './csv.ts';
export { extractPdfText } from './pdf.ts';
export { extractXlsx } from './xlsx.ts';
export { createDocumentStore, documentKey, documentStoreConfigFromEnv, LocalDocumentStore, S3DocumentStore, signV4, type DocumentStore, type DocumentStoreConfig } from './store.ts';
export { DOCUMENT_LINK_TTL_S, documentLink, fileMeta, keepUploads, recordFile, registerDocumentLinkKey, storeFor, verifyDocumentLink, type FileMeta, type KeptFile } from './files.ts';

/** Largest file the door reads (bytes). */
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
/** Most text one read keeps. */
export const MAX_DOCUMENT_TEXT = 200_000;
/** Most rows one table read returns. */
export const MAX_DOCUMENT_ROWS = 2_000;

export type DocumentErrorCode = 'empty' | 'too_large' | 'unsupported' | 'no_text';

export class DocumentError extends Error {
  readonly code: DocumentErrorCode;
  constructor(code: DocumentErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export type DocumentMethod = 'pdf-text' | 'xlsx' | 'csv' | 'text';

export interface DocumentText {
  filename: string;
  content_type: string;
  method: DocumentMethod;
  /** sha256 of the bytes: the same file read twice is the same document. */
  sha256: string;
  bytes: number;
  text: string;
  chars: number;
  truncated: boolean;
  /** PDFs: pages read. */
  pages?: number;
  /** Spreadsheets and delimited files: one table per sheet (a CSV is one sheet). */
  tables?: { name: string; rows: string[][]; truncated: boolean }[];
}

export interface DocumentUpload {
  filename: string;
  content_type?: string;
  /** The file's bytes, base64. */
  content_base64: string;
}

function methodOf(contentType: string, name: string, head: Buffer): DocumentMethod | 'image' | null {
  if (contentType.startsWith('image/') || /\.(png|jpe?g|webp|gif|heic|heif|tiff?|bmp)$/.test(name)) return 'image';
  if (head.subarray(0, 5).toString('latin1') === '%PDF-' || contentType.includes('pdf') || name.endsWith('.pdf')) return 'pdf-text';
  if (contentType.includes('spreadsheetml') || name.endsWith('.xlsx') || name.endsWith('.xlsm')) return 'xlsx';
  if (contentType.includes('csv') || contentType.includes('tab-separated') || /\.(csv|tsv)$/.test(name)) return 'csv';
  if (contentType.startsWith('text/') || contentType.includes('json') || /\.(txt|json|md)$/.test(name)) return 'text';
  if (name.endsWith('.xls') || contentType.includes('ms-excel')) return null; // the old binary format
  return 'text';
}

const cap = (rows: string[][]) => ({ rows: rows.slice(0, MAX_DOCUMENT_ROWS), truncated: rows.length > MAX_DOCUMENT_ROWS });

/** Bytes → text. Throws DocumentError with a sentence a person can act on. */
export function readDocument(input: { bytes: Buffer; filename: string; contentType?: string }): DocumentText {
  const bytes = input.bytes;
  const filename = String(input.filename || 'document').slice(0, 200);
  const name = filename.toLowerCase();
  const contentType = String(input.contentType ?? '').toLowerCase();
  if (!bytes.length) throw new DocumentError('empty', `${filename} is empty`);
  if (bytes.length > MAX_DOCUMENT_BYTES) throw new DocumentError('too_large', `${filename} is ${bytes.length} bytes; the most read at once is ${MAX_DOCUMENT_BYTES}`);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const method = methodOf(contentType, name, bytes);
  if (method === 'image') throw new DocumentError('unsupported', `${filename} is an image; images and scans are not read. Upload a PDF with a text layer, an XLSX sheet or a CSV.`);
  if (method === null) throw new DocumentError('unsupported', `${filename} is an old binary .xls; save it as .xlsx or CSV and upload that.`);

  let text = '';
  let pages: number | undefined;
  let tables: DocumentText['tables'];
  if (method === 'pdf-text') {
    const r = extractPdfText(bytes, { maxChars: MAX_DOCUMENT_TEXT + 1 });
    pages = r.pages;
    text = r.text;
    if (text.replace(/\s/g, '').length < 20) {
      throw new DocumentError('no_text', `could not read text from ${filename}; it may be a scan or an image-only PDF. Export the figures as CSV, or upload a PDF with a text layer.`);
    }
  } else if (method === 'xlsx') {
    let sheets: Sheet[];
    try {
      sheets = extractXlsx(bytes);
    } catch {
      sheets = [];
    }
    tables = sheets.filter((s) => s.rows.length).map((s) => ({ name: s.name, ...cap(s.rows) }));
    text = tables.map((t) => (tables!.length > 1 ? `# ${t.name}\n` : '') + toCsv(t.rows)).join('\n\n');
    if (text.replace(/\s/g, '').length < 2) throw new DocumentError('no_text', `could not read ${filename} as a workbook; save the sheet as CSV and upload that.`);
  } else {
    const s = decodeText(bytes);
    if ([...s.slice(0, 512)].some((c) => c.charCodeAt(0) < 9 || (c.charCodeAt(0) > 13 && c.charCodeAt(0) < 32))) {
      throw new DocumentError('unsupported', `${filename} is not a file type that is read; upload a PDF, an XLSX sheet or a CSV.`);
    }
    text = s;
    if (method === 'csv') tables = [{ name: filename, ...cap(parseDelimited(s)) }];
  }
  const truncated = text.length > MAX_DOCUMENT_TEXT;
  return {
    filename,
    content_type: contentType || 'application/octet-stream',
    method,
    sha256,
    bytes: bytes.length,
    text: text.slice(0, MAX_DOCUMENT_TEXT),
    chars: Math.min(text.length, MAX_DOCUMENT_TEXT),
    truncated,
    ...(pages !== undefined ? { pages } : {}),
    ...(tables ? { tables } : {}),
  };
}

/** Decode an upload's base64 strictly (a stray character is a refusal, not a silent drop). */
export function uploadBytes(u: DocumentUpload): Buffer {
  const b64 = String(u.content_base64 ?? '').replace(/\s/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64) || b64.length % 4 === 1) throw new DocumentError('unsupported', `${u.filename}: content_base64 is not base64`);
  return Buffer.from(b64, 'base64');
}

/** Text kept on a job for the assistant; the rest is read in pages by an app's own extract ability. */
export const ATTACHMENT_TEXT = 12_000;

/**
 * What a job carries for one attached file: a note in the job's book (a fact) whose
 * value is the extracted text. The runner shows facts to the assistant inside
 * <data trust="untrusted">, so a file's words are information, never instructions.
 * A file that cannot be read becomes a note saying why, so the assistant can tell
 * the person instead of guessing.
 */
export function attachmentFact(u: DocumentUpload, kept?: { sha256: string } | null): { subject: string; value: Record<string, unknown>; source: string } {
  const f = attachmentFactOf(u);
  // The original is kept (store + documents_files): the fact carries its id, so a write can cite it.
  if (kept) f.value = { ...f.value, document_id: kept.sha256, stored: true };
  return f;
}

function attachmentFactOf(u: DocumentUpload): { subject: string; value: Record<string, unknown>; source: string } {
  const filename = String(u.filename || 'document').slice(0, 200);
  try {
    const d = readDocument({ bytes: uploadBytes(u), filename, contentType: u.content_type });
    return {
      subject: `document:${filename}`,
      source: `upload:sha256:${d.sha256}`,
      value: {
        kind: 'attached_document',
        filename,
        content_type: d.content_type,
        method: d.method,
        sha256: d.sha256,
        bytes: d.bytes,
        ...(d.pages !== undefined ? { pages: d.pages } : {}),
        chars: d.chars,
        text: d.text.slice(0, ATTACHMENT_TEXT),
        text_truncated: d.chars > ATTACHMENT_TEXT || d.truncated,
      },
    };
  } catch (e) {
    const err = e instanceof DocumentError ? e : new DocumentError('unsupported', `${filename} could not be read`);
    return { subject: `document:${filename}`, source: 'upload:unreadable', value: { kind: 'attached_document', filename, error: err.code, message: err.message } };
  }
}

/** Refuse malformed attachment lists before anything is written. */
export function validateAttachments(v: unknown): string | null {
  if (v === undefined) return null;
  if (!Array.isArray(v) || v.length > 5) return 'attachments must be a list of at most 5 files';
  for (const a of v) {
    if (!a || typeof a !== 'object') return 'each attachment is { filename, content_type?, content_base64 }';
    if (typeof a.filename !== 'string' || !a.filename.trim() || a.filename.length > 200) return 'attachment filename (1..200 chars) required';
    if (a.content_type !== undefined && (typeof a.content_type !== 'string' || a.content_type.length > 200)) return 'attachment content_type must be a string';
    if (typeof a.content_base64 !== 'string' || !a.content_base64.length) return 'attachment content_base64 required';
    if (a.content_base64.length > Math.ceil((MAX_DOCUMENT_BYTES * 4) / 3) + 8) return `attachment ${a.filename} is larger than ${MAX_DOCUMENT_BYTES} bytes`;
  }
  return null;
}
