// .xlsx → cell text, Node built-ins only. An .xlsx is a ZIP of XML: the workbook
// names the sheets in order, the shared-strings table holds most text, and each
// worksheet lists its cells by reference (B7), so a blank cell keeps its column.
// Formulas read as their cached value; a number formatted as a date reads as
// YYYY-MM-DD (bank statements are mostly dates). Styles beyond that, charts and
// images are ignored. Not a spreadsheet engine: the visible values, in order.

import { unzip } from './zip.ts';

export interface Sheet {
  name: string;
  rows: string[][];
}

const ENT: Record<string, string> = { lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' };
const dec = (s: string) =>
  s.replace(/&(#x[0-9a-fA-F]+|#\d+|lt|gt|quot|apos|amp);/g, (_, e: string) =>
    e[0] === '#' ? String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENT[e]!,
  );
/** Text of a string item: its <t> runs, leaving out phonetic guides (<rPh>). */
const textOf = (xml: string) => [...xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '').matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((m) => dec(m[1]!)).join('');
const attr = (tag: string, name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1];

/** Column letters → 0-based index (A → 0, AA → 26). */
function colIndex(ref: string): number {
  const letters = /^[A-Z]+/.exec(ref)?.[0] ?? '';
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

const BUILTIN_DATE_FMTS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

function dateStyles(styles: string | undefined): Set<number> {
  const out = new Set<number>();
  if (!styles) return out;
  const custom = new Map<number, string>();
  for (const m of styles.matchAll(/<numFmt\b([^>]*)\/?>/g)) {
    const id = Number(attr(m[1]!, 'numFmtId'));
    const code = dec(attr(m[1]!, 'formatCode') ?? '');
    custom.set(id, code);
  }
  const xfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(styles)?.[1] ?? '';
  let i = 0;
  for (const m of xfs.matchAll(/<xf\b([^>]*?)(\/>|>)/g)) {
    const id = Number(attr(m[1]!, 'numFmtId') ?? 0);
    // A custom format is a date when it has day/month/year codes outside quoted or bracketed text.
    const code = (custom.get(id) ?? '').replace(/"[^"]*"|\[[^\]]*\]/g, '');
    if (BUILTIN_DATE_FMTS.has(id) || (custom.has(id) && /[dy]|m{3,}/i.test(code) && !/^[#0.,%\s]+$/.test(code))) out.add(i);
    i++;
  }
  return out;
}

function serialToDate(v: number, date1904: boolean): string {
  // 1900 system: serial 1 is 1900-01-01, and Excel counts a 29 Feb 1900 that never was.
  const days = date1904 ? v + 24107 : v < 60 ? v - 1 : v - 2;
  const ms = Date.UTC(1900, 0, 1) + Math.floor(days) * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

export function extractXlsx(bytes: Buffer): Sheet[] {
  const files = unzip(bytes, (n) => /^xl\/(workbook\.xml|_rels\/workbook\.xml\.rels|sharedStrings\.xml|styles\.xml|worksheets\/[^/]+\.xml)$/.test(n));
  const str = (n: string) => files.get(n)?.toString('utf8');

  const shared: string[] = [];
  for (const m of (str('xl/sharedStrings.xml') ?? '').matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) shared.push(textOf(m[1]!));
  const dates = dateStyles(str('xl/styles.xml'));
  const workbook = str('xl/workbook.xml') ?? '';
  const date1904 = /<workbookPr\b[^>]*\bdate1904="(1|true)"/.test(workbook);

  // Sheet order and names from the workbook, resolved through its relationships.
  const rels = new Map<string, string>();
  for (const m of (str('xl/_rels/workbook.xml.rels') ?? '').matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    const id = attr(m[1]!, 'Id');
    const target = attr(m[1]!, 'Target');
    if (id && target) rels.set(id, target.replace(/^\/?(xl\/)?/, 'xl/'));
  }
  const order: { name: string; file: string }[] = [];
  for (const m of workbook.matchAll(/<sheet\b([^>]*)\/?>/g)) {
    const file = rels.get(attr(m[1]!, 'r:id') ?? '');
    if (file && files.has(file)) order.push({ name: dec(attr(m[1]!, 'name') ?? file), file });
  }
  if (!order.length) {
    for (const f of [...files.keys()].filter((k) => k.startsWith('xl/worksheets/')).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))) {
      order.push({ name: f.replace(/^.*\/|\.xml$/g, ''), file: f });
    }
  }

  return order.map(({ name, file }) => {
    const xml = files.get(file)!.toString('utf8');
    const rows: string[][] = [];
    for (const r of xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>|<row\b([^>]*)\/>/g)) {
      const cells: string[] = [];
      let next = 0;
      for (const c of (r[2] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const a = c[1] ?? '';
        const inner = c[2] ?? '';
        const ref = attr(a, 'r');
        const at = ref ? colIndex(ref) : next;
        const t = attr(a, 't');
        const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
        let val = '';
        if (t === 's') val = shared[Number(v)] ?? '';
        else if (t === 'inlineStr') val = textOf(inner);
        else if (t === 'str' || t === 'e') val = dec(v ?? '');
        else if (t === 'b') val = v === '1' ? 'TRUE' : v === '0' ? 'FALSE' : '';
        else if (v !== undefined) {
          const num = Number(v);
          val = dates.has(Number(attr(a, 's') ?? -1)) && Number.isFinite(num) && num > 0 ? serialToDate(num, date1904) : dec(v);
        }
        while (cells.length < at) cells.push('');
        cells[at] = val;
        next = at + 1;
      }
      while (cells.length && cells[cells.length - 1] === '') cells.pop();
      // Rows carry their number (r="12"); keep the gaps Excel leaves out, up to a sane bound.
      const rowNo = Number(attr(r[1] ?? r[3] ?? '', 'r'));
      if (Number.isInteger(rowNo) && rowNo > rows.length + 1 && rowNo - rows.length < 1000) while (rows.length < rowNo - 1) rows.push([]);
      rows.push(cells);
    }
    while (rows.length && !rows[rows.length - 1]!.length) rows.pop();
    return { name, rows };
  });
}
