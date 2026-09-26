// PDF → text, Node zlib only. It reads the TEXT LAYER of a digitally made PDF:
// the page tree in order, each page's content streams (and the forms they draw),
// the strings shown by the text operators (Tj TJ ' "), each decoded through its
// font — a ToUnicode CMap when the font has one (browsers, Word and most billing
// tools embed subset fonts whose bytes are glyph ids, not letters), otherwise
// the font's single-byte encoding (WinAnsi, MacRoman, Differences). Lines and
// gaps are rebuilt from the text positioning operators. It does NOT OCR: a scan
// has no text layer and reads as (almost) nothing, which the caller reports.
//
// Ported from the Ledger documents door (src/doors/documents/pdf.mjs), which read
// literal strings only; that read "TAX INVOICE" as glyph ids from any PDF a
// browser printed, and ran every line into one.

import zlib from 'node:zlib';

// ── low-level syntax ─────────────────────────────────────────────────────────

const WS = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const DELIM = new Set(['(', ')', '<', '>', '[', ']', '{', '}', '/', '%']);
const isWs = (s: string, i: number) => WS.has(s.charCodeAt(i));

function skipWs(s: string, i: number): number {
  for (;;) {
    while (i < s.length && isWs(s, i)) i++;
    if (s[i] === '%') {
      while (i < s.length && s[i] !== '\n' && s[i] !== '\r') i++;
      continue;
    }
    return i;
  }
}

/** Index just past the literal string starting at `i` (which is '('). */
function endOfLiteral(s: string, i: number): number {
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    const ch = s[j];
    if (ch === '\\') j++;
    else if (ch === '(') depth++;
    else if (ch === ')' && --depth === 0) return j + 1;
  }
  return s.length;
}

/** One PDF value starting at `i`: its raw text and where it ends. References come back as "12 0 R". */
function readValue(s: string, i: number): [string, number] {
  i = skipWs(s, i);
  const ch = s[i];
  if (ch === '<' && s[i + 1] === '<') {
    let depth = 0;
    let j = i;
    while (j < s.length) {
      if (s[j] === '(') j = endOfLiteral(s, j);
      else if (s[j] === '<' && s[j + 1] === '<') {
        depth++;
        j += 2;
      } else if (s[j] === '>' && s[j + 1] === '>') {
        depth--;
        j += 2;
        if (depth === 0) break;
      } else j++;
    }
    return [s.slice(i, j), j];
  }
  if (ch === '[') {
    let depth = 0;
    let j = i;
    while (j < s.length) {
      if (s[j] === '(') {
        j = endOfLiteral(s, j);
        continue;
      }
      if (s[j] === '[') depth++;
      else if (s[j] === ']' && --depth === 0) {
        j++;
        break;
      }
      j++;
    }
    return [s.slice(i, j), j];
  }
  if (ch === '(') {
    const j = endOfLiteral(s, i);
    return [s.slice(i, j), j];
  }
  if (ch === '<') {
    const j = s.indexOf('>', i);
    return [s.slice(i, j + 1), j + 1];
  }
  const ref = /^(\d+)\s+(\d+)\s+R\b/.exec(s.slice(i, i + 32));
  if (ref) return [ref[0], i + ref[0].length];
  let j = i + (ch === '/' ? 1 : 0);
  while (j < s.length && !isWs(s, j) && !DELIM.has(s[j]!)) j++;
  return [s.slice(i, j), j];
}

/** The top-level entries of a dictionary's raw text. */
function entries(dict: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (!dict || !dict.startsWith('<<')) return out;
  let i = 2;
  for (;;) {
    i = skipWs(dict, i);
    if (i >= dict.length || dict.startsWith('>>', i)) break;
    if (dict[i] !== '/') {
      i++;
      continue;
    }
    const [key, k] = readValue(dict, i);
    const [val, v] = readValue(dict, k);
    out.set(key, val);
    i = v;
  }
  return out;
}

const refNum = (raw: string | undefined) => {
  const m = raw ? /^(\d+)\s+\d+\s+R$/.exec(raw.trim()) : null;
  return m ? Number(m[1]) : null;
};
const refsIn = (raw: string | undefined) => [...(raw ?? '').matchAll(/(\d+)\s+\d+\s+R/g)].map((m) => Number(m[1]));

function literalBytes(raw: string): string {
  let out = '';
  const body = raw.slice(1, -1);
  const esc: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' };
  for (let j = 0; j < body.length; j++) {
    const ch = body[j]!;
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    const nx = body[j + 1] ?? '';
    if (esc[nx] !== undefined) {
      out += esc[nx];
      j++;
    } else if (nx >= '0' && nx <= '7') {
      let oct = '';
      while (oct.length < 3 && body[j + 1]! >= '0' && body[j + 1]! <= '7') oct += body[++j];
      out += String.fromCharCode(parseInt(oct, 8) & 0xff);
    } else if (nx === '\r' || nx === '\n') {
      j++;
      if (nx === '\r' && body[j + 1] === '\n') j++;
    } else {
      out += nx;
      j++;
    }
  }
  return out;
}

function hexBytes(raw: string): string {
  let hex = raw.slice(1, -1).replace(/[^0-9a-fA-F]/g, '');
  if (hex.length % 2) hex += '0';
  let out = '';
  for (let k = 0; k < hex.length; k += 2) out += String.fromCharCode(parseInt(hex.slice(k, k + 2), 16));
  return out;
}

const stringBytes = (raw: string) => (raw.startsWith('(') ? literalBytes(raw) : hexBytes(raw));

// ── objects and streams ──────────────────────────────────────────────────────

interface Obj {
  body: string;
  stream?: Buffer;
}

function ascii85(data: Buffer): Buffer {
  const s = data.toString('latin1').replace(/\s/g, '').replace(/^<~/, '').replace(/~>.*$/, '');
  const out: number[] = [];
  let group: number[] = [];
  for (const ch of s) {
    if (ch === 'z' && group.length === 0) {
      out.push(0, 0, 0, 0);
      continue;
    }
    group.push(ch.charCodeAt(0) - 33);
    if (group.length === 5) {
      let v = 0;
      for (const g of group) v = v * 85 + g;
      out.push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
      group = [];
    }
  }
  if (group.length) {
    const n = group.length;
    while (group.length < 5) group.push(84);
    let v = 0;
    for (const g of group) v = v * 85 + g;
    out.push(...[(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255].slice(0, n - 1));
  }
  return Buffer.from(out);
}

const IMAGE_FILTERS = /\/(DCTDecode|JPXDecode|CCITTFaxDecode|JBIG2Decode|DCT|CCF)\b/;

function decodeStream(dict: Map<string, string>, raw: Buffer, maxOut: number): Buffer | null {
  const filters = [...(dict.get('/Filter') ?? '').matchAll(/\/([A-Za-z0-9]+)/g)].map((m) => m[1]!);
  let data = raw;
  for (const f of filters) {
    if (f === 'FlateDecode' || f === 'Fl') {
      try {
        data = zlib.inflateSync(data, { maxOutputLength: maxOut });
      } catch {
        try {
          data = zlib.inflateRawSync(data, { maxOutputLength: maxOut });
        } catch {
          return null;
        }
      }
    } else if (f === 'ASCIIHexDecode' || f === 'AHx') data = Buffer.from(hexBytes(`<${data.toString('latin1').replace(/>.*$/s, '')}>`), 'latin1');
    else if (f === 'ASCII85Decode' || f === 'A85') data = ascii85(data);
    else return null; // images and anything we do not read
  }
  return data;
}

function parseObjects(bytes: Buffer, maxOut: number): Map<number, Obj> {
  const s = bytes.toString('latin1');
  const objs = new Map<number, Obj>();
  const starts: { num: number; at: number }[] = [];
  for (const m of s.matchAll(/(?:^|[\s>\]])(\d+)\s+(\d+)\s+obj\b/g)) starts.push({ num: Number(m[1]), at: m.index! + m[0].length });
  const lengths: { num: number; lenRef: number; dataAt: number }[] = [];
  for (const [k, { num, at }] of starts.entries()) {
    const limit = starts[k + 1]?.at ?? s.length;
    const [first, afterFirst] = readValue(s, at);
    const next = skipWs(s, afterFirst);
    if (first.startsWith('<<') && s.startsWith('stream', next)) {
      let dataAt = next + 6;
      if (s[dataAt] === '\r') dataAt++;
      if (s[dataAt] === '\n') dataAt++;
      const dict = entries(first);
      const lenRaw = dict.get('/Length') ?? '';
      const direct = /^\d+$/.test(lenRaw) ? Number(lenRaw) : null;
      let end: number;
      if (direct !== null && s.startsWith('endstream', skipWs(s, dataAt + direct))) end = dataAt + direct;
      else {
        end = s.indexOf('endstream', dataAt);
        if (end < 0 || end > limit + 64) end = Math.min(limit, s.length);
        if (s[end - 1] === '\n') end--;
        if (s[end - 1] === '\r') end--;
        const lr = refNum(lenRaw);
        if (lr !== null) lengths.push({ num, lenRef: lr, dataAt });
      }
      objs.set(num, { body: first, stream: bytes.subarray(dataAt, end) });
    } else {
      const endobj = s.indexOf('endobj', afterFirst);
      objs.set(num, { body: s.slice(at, endobj >= 0 && endobj < limit + 16 ? endobj : afterFirst).trim() });
    }
  }
  // Indirect /Length: now that every object is known, cut exactly.
  for (const { num, lenRef, dataAt } of lengths) {
    const n = Number(objs.get(lenRef)?.body);
    if (Number.isInteger(n) && n >= 0 && dataAt + n <= bytes.length) objs.get(num)!.stream = bytes.subarray(dataAt, dataAt + n);
  }
  // Object streams (PDF 1.5+): many dictionaries — fonts, pages — live inside them.
  for (const o of [...objs.values()]) {
    const d = entries(o.body);
    if (!o.stream || !/\/ObjStm\b/.test(d.get('/Type') ?? '')) continue;
    const data = decodeStream(d, o.stream, maxOut);
    if (!data) continue;
    const t = data.toString('latin1');
    const n = Number(d.get('/N'));
    const first = Number(d.get('/First'));
    const nums = t.slice(0, first).trim().split(/\s+/).map(Number);
    for (let k = 0; k < n && 2 * k + 1 < nums.length; k++) {
      const num = nums[2 * k]!;
      const from = first + nums[2 * k + 1]!;
      const to = 2 * k + 3 < nums.length ? first + nums[2 * k + 3]! : t.length;
      if (!objs.has(num)) objs.set(num, { body: t.slice(from, to).trim() });
    }
  }
  return objs;
}

// ── fonts ────────────────────────────────────────────────────────────────────

const WIN_ANSI_HIGH: Record<number, string> = {
  0x80: '€', 0x82: '‚', 0x83: 'ƒ', 0x84: '„', 0x85: '…', 0x86: '†', 0x87: '‡', 0x88: 'ˆ', 0x89: '‰', 0x8a: 'Š', 0x8b: '‹', 0x8c: 'Œ', 0x8e: 'Ž',
  0x91: '‘', 0x92: '’', 0x93: '“', 0x94: '”', 0x95: '•', 0x96: '–', 0x97: '—', 0x98: '˜', 0x99: '™', 0x9a: 'š', 0x9b: '›', 0x9c: 'œ', 0x9e: 'ž', 0x9f: 'Ÿ',
};
const MAC_ROMAN_HIGH =
  'ÄÅÇÉÑÖÜáàâäãåçéèêëíìîïñóòôöõúùûü†°¢£§•¶ß®©™´¨≠ÆØ∞±≤≥¥µ∂∑∏π∫ªºΩæø¿¡¬√ƒ≈∆«»… ÀÃÕŒœ–—“”‘’÷◊ÿŸ⁄€‹›ﬁﬂ‡·‚„‰ÂÊÁËÈÍÎÏÌÓÔÒÚÛÙıˆ˜¯˘˙˚¸˝˛ˇ';
const GLYPHS: Record<string, string> = {
  space: ' ', quoteright: '’', quoteleft: '‘', quotedblleft: '“', quotedblright: '”', endash: '–', emdash: '—', bullet: '•', ellipsis: '…',
  rupee: '₹', Euro: '€', sterling: '£', fi: 'fi', fl: 'fl', hyphen: '-', minus: '−', periodcentered: '·', nbspace: ' ', degree: '°',
  zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9',
  period: '.', comma: ',', colon: ':', semicolon: ';', slash: '/', percent: '%', parenleft: '(', parenright: ')', ampersand: '&', at: '@', numbersign: '#',
};

interface Font {
  /** code bytes → text; codes sized by the CMap's codespace. */
  map: Map<number, string> | null;
  widths: number[]; // byte widths the codespace allows, ascending
  single: (code: number) => string;
}

function parseCMap(text: string): { map: Map<number, string>; widths: number[] } {
  const map = new Map<number, string>();
  const widths = new Set<number>();
  const utf16 = (hex: string) => {
    const b = Buffer.from(hex.length % 2 ? hex + '0' : hex, 'hex');
    let out = '';
    for (let i = 0; i + 1 < b.length; i += 2) out += String.fromCharCode(b.readUInt16BE(i));
    return out;
  };
  for (const blk of text.matchAll(/begincodespacerange([\s\S]*?)endcodespacerange/g)) {
    for (const m of blk[1]!.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) widths.add(m[1]!.length / 2);
  }
  for (const blk of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const m of blk[1]!.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]*)>/g)) {
      map.set(parseInt(m[1]!, 16), utf16(m[2]!));
      widths.add(m[1]!.length / 2);
    }
  }
  for (const blk of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const m of blk[1]!.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(<[0-9a-fA-F]*>|\[[^\]]*\])/g)) {
      const lo = parseInt(m[1]!, 16);
      const hi = parseInt(m[2]!, 16);
      widths.add(m[1]!.length / 2);
      if (hi < lo || hi - lo > 65_535) continue;
      if (m[3]!.startsWith('[')) {
        const dsts = [...m[3]!.matchAll(/<([0-9a-fA-F]*)>/g)].map((x) => x[1]!);
        dsts.forEach((d, k) => lo + k <= hi && map.set(lo + k, utf16(d)));
      } else {
        const base = m[3]!.slice(1, -1);
        const start = utf16(base);
        for (let c = lo; c <= hi; c++) {
          const last = start.charCodeAt(start.length - 1) + (c - lo);
          map.set(c, start.slice(0, -1) + String.fromCharCode(last));
        }
      }
    }
  }
  return { map, widths: [...widths].filter((w) => w >= 1 && w <= 4).sort((a, b) => a - b) };
}

// ── the reader ───────────────────────────────────────────────────────────────

export interface PdfText {
  text: string;
  pages: number;
}

export function extractPdfText(bytes: Buffer, opts: { maxChars?: number; maxInflate?: number } = {}): PdfText {
  const maxChars = opts.maxChars ?? 200_000;
  const maxOut = opts.maxInflate ?? 64 * 1024 * 1024;
  const objs = parseObjects(bytes, maxOut);
  const resolve = (raw: string | undefined): string | undefined => {
    const n = refNum(raw);
    return n === null ? raw : objs.get(n)?.body;
  };
  const streamOf = (num: number): Buffer | null => {
    const o = objs.get(num);
    return o?.stream ? decodeStream(entries(o.body), o.stream, maxOut) : null;
  };

  const fonts = new Map<number, Font>();
  const fontFor = (num: number): Font => {
    const hit = fonts.get(num);
    if (hit) return hit;
    const d = entries(objs.get(num)?.body);
    let map: Map<number, string> | null = null;
    let widths = [1];
    const tu = refNum(d.get('/ToUnicode'));
    if (tu !== null) {
      const cm = streamOf(tu);
      if (cm) {
        const p = parseCMap(cm.toString('latin1'));
        if (p.map.size) {
          map = p.map;
          widths = p.widths.length ? p.widths : [1];
        }
      }
    }
    const type0 = /\/Type0\b/.test(d.get('/Subtype') ?? '');
    if (type0 && !map) widths = [2]; // glyph ids with no map: unreadable, but consume them in pairs
    const enc = resolve(d.get('/Encoding')) ?? '';
    const mac = /MacRoman/.test(enc);
    const diff = new Map<number, string>();
    const diffs = entries(enc.startsWith('<<') ? enc : undefined).get('/Differences');
    if (diffs) {
      let code = 0;
      for (const t of diffs.slice(1, -1).trim().split(/(?=\/)|\s+/).filter(Boolean)) {
        if (/^\d+$/.test(t)) code = Number(t);
        else if (t.startsWith('/')) {
          const g = t.slice(1);
          const u = /^uni([0-9A-F]{4})$/.exec(g);
          const ch = u ? String.fromCharCode(parseInt(u[1]!, 16)) : GLYPHS[g] ?? (g.length === 1 ? g : '');
          diff.set(code++, ch);
        }
      }
    }
    const single = (c: number) => {
      if (type0) return '';
      if (diff.has(c)) return diff.get(c)!;
      if (c < 0x80) return c >= 0x20 || c === 0x09 ? String.fromCharCode(c) : '';
      if (mac) return MAC_ROMAN_HIGH[c - 0x80] ?? '';
      return WIN_ANSI_HIGH[c] ?? (c >= 0xa0 ? String.fromCharCode(c) : '');
    };
    const f: Font = { map, widths, single };
    fonts.set(num, f);
    return f;
  };

  const decode = (font: Font | null, bytesStr: string): { text: string; glyphs: number } => {
    if (!font) {
      let t = '';
      for (const ch of bytesStr) {
        const c = ch.charCodeAt(0);
        t += c < 0x80 ? (c >= 0x20 || c === 9 ? ch : '') : WIN_ANSI_HIGH[c] ?? (c >= 0xa0 ? ch : '');
      }
      return { text: t, glyphs: bytesStr.length };
    }
    let t = '';
    let glyphs = 0;
    for (let i = 0; i < bytesStr.length; ) {
      let done = false;
      if (font.map) {
        for (const w of font.widths) {
          if (i + w > bytesStr.length) break;
          let code = 0;
          for (let k = 0; k < w; k++) code = code * 256 + bytesStr.charCodeAt(i + k);
          const u = font.map.get(code);
          if (u !== undefined) {
            t += u;
            i += w;
            glyphs++;
            done = true;
            break;
          }
        }
      }
      if (done) continue;
      const w = font.widths[font.widths.length - 1] ?? 1;
      if (w === 1) t += font.single(bytesStr.charCodeAt(i));
      i += Math.max(1, font.map ? w : 1);
      glyphs++;
    }
    return { text: t, glyphs };
  };

  let out = '';
  const emit = (s: string) => {
    if (out.length < maxChars) out += s;
  };
  const newline = () => {
    if (out && !out.endsWith('\n')) emit('\n');
  };
  const space = () => {
    if (out && !/[\s]$/.test(out)) emit(' ');
  };

  /** Run one content stream with a resources dictionary; forms recurse (bounded). */
  const run = (content: string, resources: string | undefined, depth: number) => {
    const res = entries(resolve(resources));
    const fontRefs = entries(resolve(res.get('/Font')));
    const xobjs = entries(resolve(res.get('/XObject')));
    let font: Font | null = null;
    let fs = 12;
    let scale = 1; // Tm's horizontal scale
    let lineX = 0;
    let lineY = 0;
    let curX = 0;
    let leading = 0;
    let started = false;
    const moveTo = (x: number, y: number) => {
      if (started && Math.abs(y - lineY) > Math.max(1, 0.5 * fs * Math.abs(scale))) newline();
      else if (started && x - curX > 0.8 * fs * Math.abs(scale)) space();
      lineX = x;
      lineY = y;
      curX = x;
      started = true;
    };
    const show = (raw: string) => {
      const d = decode(font, stringBytes(raw));
      emit(d.text);
      curX += d.glyphs * 0.5 * fs * scale;
    };
    const ops: string[] = [];
    let i = 0;
    while (i < content.length) {
      i = skipWs(content, i);
      if (i >= content.length) break;
      const ch = content[i]!;
      if (ch === '(' || ch === '<' || ch === '[' || ch === '/') {
        if (ch === '<' && content[i + 1] === '<') {
          const [, j] = readValue(content, i);
          ops.push('<<>>');
          i = j;
          continue;
        }
        const [v, j] = readValue(content, i);
        ops.push(v);
        i = j;
        continue;
      }
      if (ch === ']' || ch === ')' || ch === '>' || ch === '{' || ch === '}') {
        i++;
        continue;
      }
      let j = i;
      while (j < content.length && !isWs(content, j) && !DELIM.has(content[j]!)) j++;
      if (j === i) j++;
      const tok = content.slice(i, j);
      i = j;
      if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(tok)) {
        ops.push(tok);
        continue;
      }
      const num = (k: number) => Number(ops[ops.length - k]);
      switch (tok) {
        case 'BI': {
          // inline image: skip to EI
          const e = content.indexOf('EI', i);
          i = e < 0 ? content.length : e + 2;
          break;
        }
        case 'BT':
          lineX = curX = 0;
          break;
        case 'Tf': {
          fs = Math.abs(num(1)) || fs;
          const n = refNum(fontRefs.get(ops[ops.length - 2] ?? ''));
          font = n === null ? null : fontFor(n);
          break;
        }
        case 'TL':
          leading = num(1);
          break;
        case 'Tm': {
          scale = Number(ops[ops.length - 6]) || 1;
          moveTo(num(2), num(1));
          break;
        }
        case 'Td':
        case 'TD': {
          const tx = num(2);
          const ty = num(1);
          if (tok === 'TD') leading = -ty;
          const x = lineX + tx * Math.abs(scale);
          const y = lineY + ty * Math.abs(scale);
          moveTo(x, y);
          break;
        }
        case 'T*':
          moveTo(lineX, lineY - (leading || fs) * Math.abs(scale));
          break;
        case 'Tj':
          show(ops[ops.length - 1] ?? '()');
          break;
        case "'":
        case '"':
          moveTo(lineX, lineY - (leading || fs) * Math.abs(scale));
          show(ops[ops.length - 1] ?? '()');
          break;
        case 'TJ': {
          const arr = ops[ops.length - 1] ?? '[]';
          let k = 1;
          while (k < arr.length - 1) {
            k = skipWs(arr, k);
            if (k >= arr.length - 1) break;
            const [v, e] = readValue(arr, k);
            if (e <= k) break;
            k = e;
            if (v.startsWith('(') || v.startsWith('<')) show(v);
            else if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(v)) {
              const adj = Number(v);
              if (adj < -250) space();
              curX -= (adj / 1000) * fs * scale;
            }
          }
          break;
        }
        case 'Do': {
          const n = refNum(xobjs.get(ops[ops.length - 1] ?? ''));
          const o = n === null ? undefined : objs.get(n);
          if (o && depth < 4 && /\/Form\b/.test(entries(o.body).get('/Subtype') ?? '')) {
            const data = streamOf(n!);
            if (data) {
              newline();
              run(data.toString('latin1'), entries(o.body).get('/Resources') ?? resources, depth + 1);
            }
          }
          break;
        }
      }
      ops.length = 0;
    }
    newline();
  };

  // Pages in reading order, each with its (possibly inherited) resources.
  const pages: { contents: string | undefined; resources: string | undefined }[] = [];
  const seen = new Set<number>();
  const walk = (raw: string | undefined, inherited: string | undefined, depth: number) => {
    const n = refNum(raw);
    if (n !== null) {
      if (seen.has(n)) return;
      seen.add(n);
    }
    const d = entries(resolve(raw));
    const resources = d.get('/Resources') ?? inherited;
    const kids = d.get('/Kids');
    if (kids && depth < 50) for (const k of refsIn(kids)) walk(`${k} 0 R`, resources, depth + 1);
    else if (d.has('/Contents')) pages.push({ contents: d.get('/Contents'), resources });
  };
  const s = bytes.toString('latin1');
  const roots = [...s.matchAll(/\/Root\s+(\d+)\s+\d+\s+R/g)];
  const catalog = roots.length ? entries(objs.get(Number(roots[roots.length - 1]![1]))?.body) : new Map<string, string>();
  walk(catalog.get('/Pages'), undefined, 0);

  if (pages.length) {
    for (const p of pages) {
      const raw = resolve(p.contents) ?? '';
      const nums = raw.trim().startsWith('[') ? refsIn(raw) : refsIn(p.contents);
      const text = nums.map((n) => streamOf(n)?.toString('latin1') ?? '').join('\n');
      run(text, p.resources, 0);
      if (out.length >= maxChars) break;
      emit('\n');
    }
  } else {
    // No page tree we can follow: read every text-bearing stream, in file order.
    for (const [num, o] of objs) {
      if (!o.stream || IMAGE_FILTERS.test(o.body)) continue;
      const data = streamOf(num)?.toString('latin1');
      if (data && /\bBT\b/.test(data) && /T[jJ]\b/.test(data)) run(data, undefined, 0);
    }
  }
  const text = out
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { text: text.slice(0, maxChars), pages: pages.length };
}
