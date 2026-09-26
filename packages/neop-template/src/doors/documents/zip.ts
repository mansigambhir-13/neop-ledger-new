// A small ZIP reader (Node zlib only) for the parts of an .xlsx we read. It walks
// the central directory — the authoritative list with every entry's real sizes —
// and falls back to scanning local headers when the directory is missing or
// damaged. Stored (0) and deflated (8) entries only; that is all Office writes.

import zlib from 'node:zlib';

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

export interface ZipLimits {
  /** Refuse to inflate more than this in total (zip bombs). */
  maxTotalBytes: number;
}

function inflate(method: number, data: Buffer, room: number): Buffer | null {
  if (method === 0) return data;
  if (method !== 8) return null;
  try {
    return zlib.inflateRawSync(data, { maxOutputLength: Math.max(1, room) });
  } catch {
    return null;
  }
}

function findEocd(buf: Buffer): number {
  // The end record is at least 22 bytes and may be followed by a comment of up to 64 KiB.
  const stop = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= stop; i--) if (buf.readUInt32LE(i) === EOCD) return i;
  return -1;
}

/** Entries whose name passes `want`, decompressed. Unreadable entries are skipped, never guessed. */
export function unzip(buf: Buffer, want: (name: string) => boolean, limits: ZipLimits = { maxTotalBytes: 64 * 1024 * 1024 }): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  let total = 0;
  const take = (name: string, method: number, data: Buffer) => {
    const room = limits.maxTotalBytes - total;
    if (room <= 0) return;
    const b = inflate(method, data, room);
    if (!b) return;
    total += b.length;
    out.set(name, b);
  };

  const eocd = buf.length >= 22 ? findEocd(buf) : -1;
  if (eocd >= 0) {
    const count = buf.readUInt16LE(eocd + 10);
    let p = buf.readUInt32LE(eocd + 16);
    for (let n = 0; n < count && p + 46 <= buf.length && buf.readUInt32LE(p) === CENTRAL; n++) {
      const method = buf.readUInt16LE(p + 10);
      const compSize = buf.readUInt32LE(p + 20);
      const nameLen = buf.readUInt16LE(p + 28);
      const extraLen = buf.readUInt16LE(p + 30);
      const commentLen = buf.readUInt16LE(p + 32);
      const localAt = buf.readUInt32LE(p + 42);
      const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
      p += 46 + nameLen + extraLen + commentLen;
      if (!want(name) || localAt + 30 > buf.length || buf.readUInt32LE(localAt) !== LOCAL) continue;
      const start = localAt + 30 + buf.readUInt16LE(localAt + 26) + buf.readUInt16LE(localAt + 28);
      if (start + compSize > buf.length) continue;
      take(name, method, buf.subarray(start, start + compSize));
    }
    if (out.size) return out;
  }

  // No usable directory: walk the local headers. A streamed entry (flag bit 3, sizes
  // in a trailing descriptor) is bounded by the next header, and inflate stops at
  // the end of its deflate stream, so trailing descriptor bytes are harmless.
  let i = 0;
  while (i + 30 <= buf.length && buf.readUInt32LE(i) === LOCAL) {
    const flags = buf.readUInt16LE(i + 6);
    const method = buf.readUInt16LE(i + 8);
    const compSize = buf.readUInt32LE(i + 18);
    const nameLen = buf.readUInt16LE(i + 26);
    const extraLen = buf.readUInt16LE(i + 28);
    const name = buf.toString('utf8', i + 30, i + 30 + nameLen);
    const start = i + 30 + nameLen + extraLen;
    let end: number;
    if (flags & 0x08 && compSize === 0) {
      const next = [buf.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]), start), buf.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]), start)].filter((x) => x >= 0);
      end = next.length ? Math.min(...next) : buf.length;
    } else end = start + compSize;
    if (want(name)) take(name, method, buf.subarray(start, Math.min(end, buf.length)));
    i = end;
    if (i + 4 > buf.length || buf.readUInt32LE(i) !== LOCAL) {
      const n = buf.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]), i);
      if (n < 0) break;
      i = n;
    }
  }
  return out;
}
