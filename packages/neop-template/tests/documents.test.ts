// documents.test · the documents door reads real files deterministically: PDFs a
// browser and macOS printed (subset fonts with ToUnicode, lines, two pages),
// XLSX workbooks (shared and inline strings, date cells, blank cells, two sheets,
// streamed ZIP entries), CSV in the shapes banks export, and refuses scans,
// images and the old .xls plainly. No model, no network.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { attachmentFact, DocumentError, extractPdfText, extractXlsx, parseDelimited, readDocument, validateAttachments } from '../src/doors/documents/index.ts';

const FX = path.join(import.meta.dirname, 'fixtures', 'documents');
const fx = (f: string) => readFileSync(path.join(FX, f));

// ── builders for synthetic files ─────────────────────────────────────────────

/** A PDF from object bodies (1-based), each either a dict/value or [dict, stream bytes]. */
function pdf(objs: (string | [string, Buffer] | null)[], root = 1): Buffer {
  const parts: Buffer[] = [Buffer.from('%PDF-1.5\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  objs.forEach((o, i) => {
    if (o === null) return; // a number defined elsewhere (an object stream)
    if (typeof o === 'string') parts.push(Buffer.from(`${i + 1} 0 obj\n${o}\nendobj\n`, 'latin1'));
    else parts.push(Buffer.from(`${i + 1} 0 obj\n${o[0].replace('LEN', String(o[1].length))}\nstream\n`, 'latin1'), o[1], Buffer.from('\nendstream\nendobj\n', 'latin1'));
  });
  parts.push(Buffer.from(`trailer\n<< /Root ${root} 0 R >>\n%%EOF\n`, 'latin1'));
  return Buffer.concat(parts);
}
const flate = (s: string) => zlib.deflateSync(Buffer.from(s, 'latin1'));

function zip(files: Record<string, string>, opts: { streamed?: boolean } = {}): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text, 'utf8');
    const comp = zlib.deflateRawSync(data);
    const crc = zlib.crc32(data);
    const nameB = Buffer.from(name, 'utf8');
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0);
    h.writeUInt16LE(20, 4);
    h.writeUInt16LE(opts.streamed ? 0x08 : 0, 6);
    h.writeUInt16LE(8, 8);
    h.writeUInt32LE(opts.streamed ? 0 : crc, 14);
    h.writeUInt32LE(opts.streamed ? 0 : comp.length, 18);
    h.writeUInt32LE(opts.streamed ? 0 : data.length, 22);
    h.writeUInt16LE(nameB.length, 26);
    const desc = Buffer.alloc(opts.streamed ? 16 : 0);
    if (opts.streamed) {
      desc.writeUInt32LE(0x08074b50, 0);
      desc.writeUInt32LE(crc, 4);
      desc.writeUInt32LE(comp.length, 8);
      desc.writeUInt32LE(data.length, 12);
    }
    locals.push(h, nameB, comp, desc);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(opts.streamed ? 0x08 : 0, 8);
    c.writeUInt16LE(8, 10);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(comp.length, 20);
    c.writeUInt32LE(data.length, 24);
    c.writeUInt16LE(nameB.length, 28);
    c.writeUInt32LE(offset, 42);
    central.push(c, nameB);
    offset += 30 + nameB.length + comp.length + desc.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

/** A workbook shaped as Excel writes one: two sheets (the second listed first in the zip), shared strings, dates, gaps. */
function workbook(opts: { streamed?: boolean } = {}): Buffer {
  const ns = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
  return zip(
    {
      '[Content_Types].xml': '<?xml version="1.0"?><Types/>',
      'xl/worksheets/sheet2.xml': `<worksheet ${ns}><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Notes &amp; totals</t></is></c></row></sheetData></worksheet>`,
      'xl/workbook.xml': `<workbook ${ns}><sheets><sheet name="Statement" sheetId="1" r:id="rId1"/><sheet name="Notes" sheetId="2" r:id="rId2"/></sheets></workbook>`,
      'xl/_rels/workbook.xml.rels':
        '<Relationships><Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="worksheet" Target="/xl/worksheets/sheet2.xml"/></Relationships>',
      'xl/styles.xml': '<styleSheet><numFmts count="1"><numFmt numFmtId="164" formatCode="dd/mm/yyyy"/></numFmts><cellXfs count="3"><xf numFmtId="0"/><xf numFmtId="164"/><xf numFmtId="4"/></cellXfs></styleSheet>',
      'xl/sharedStrings.xml':
        '<sst><si><t>Date</t></si><si><t>Narration</t></si><si><t>Amount</t></si><si><r><t>NEFT CR </t></r><r><rPr><b/></rPr><t>KAPOOR, TRADERS</t></r><rPh><t>x</t></rPh></si><si><t xml:space="preserve">SMS "ALERT" CHARGES</t></si></sst>',
      'xl/worksheets/sheet1.xml': `<worksheet ${ns}><sheetData>
        <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="D1" t="s"><v>2</v></c></row>
        <row r="2"><c r="A2" s="1"><v>46291</v></c><c r="B2" t="s"><v>3</v></c><c r="D2" s="2"><v>177000</v></c></row>
        <row r="4"><c r="A4" s="1"><v>46294</v></c><c r="B4" t="s"><v>4</v></c><c r="D4" s="2"><f>-100-18</f><v>-118</v></c><c r="E4" t="b"><v>1</v></c></row>
      </sheetData></worksheet>`,
    },
    opts,
  );
}

// ── PDF ──────────────────────────────────────────────────────────────────────

describe('PDF', () => {
  it('reads a bill macOS printed (TrueType, MacRoman), line by line', () => {
    const d = readDocument({ bytes: fx('bill-quartz.pdf'), filename: 'MW-2041.pdf', contentType: 'application/pdf' });
    expect(d.method).toBe('pdf-text');
    expect(d.pages).toBe(1);
    expect(d.text.split('\n')).toEqual([
      'TAX INVOICE',
      'Mehta Wholesale Supplies',
      'Invoice No: MW-2041',
      'Date: 2026-09-12 Due: 2026-10-12',
      'GSTIN: 27AAPFU0939F1ZV',
      'Rice bags x 20 Rs 40,000.00',
      'GST 18% Rs 7,200.00',
      'Total Rs 47,200.00',
    ]);
    expect(d.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('reads an invoice Chrome printed: subset fonts whose bytes are glyph ids, decoded through ToUnicode (₹, —)', () => {
    const d = readDocument({ bytes: fx('invoice-chrome.pdf'), filename: 'CS-7781.pdf' });
    expect(d.text).toContain('Invoice No: CS-7781');
    expect(d.text).toContain('Annual licence — ERP seats ₹ 25,000.00');
    expect(d.text).toContain('IGST 18% ₹ 4,500.00');
    expect(d.text.split('\n')).toContain('Total ₹ 29,500.00');
  });

  it('reads a two-page bank statement with table rows kept on their lines', () => {
    const d = readDocument({ bytes: fx('statement-chrome-2p.pdf'), filename: 'hdfc-sep.pdf' });
    expect(d.pages).toBe(2);
    const lines = d.text.split('\n');
    expect(lines).toContain('15/09/2026 NEFT CR SHARMA RETAIL INV-0003 UTR0003 2,00,000.00');
    expect(lines).toContain('28/09/2026 SALARY SEP UTR0004 1,80,000.00');
    expect(lines.at(-1)).toBe('Page 2 — Closing balance 12,34,567.89');
  });

  it('follows the page tree through object streams, bfrange CMaps, TJ kerning, WinAnsi and forms', () => {
    const cmap = `/CIDInit /ProcSet findresource begin 12 dict begin begincmap
      1 begincodespacerange <0000> <FFFF> endcodespacerange
      2 beginbfchar <0003> <0020> <0010> <20B9> endbfchar
      1 beginbfrange <0024> <003D> <0041> endbfrange
      endcmap CMapName currentdict /CMap defineresource pop end end`;
    // Object stream holding the font dictionaries (objects 7 and 8).
    const inner = ['<< /Type /Font /Subtype /Type0 /BaseFont /ABCDEF+Inter /Encoding /Identity-H /ToUnicode 6 0 R >>', '<< /Type /Font /Subtype /TrueType /Encoding /WinAnsiEncoding >>'];
    const head = `7 0 8 ${inner[0]!.length + 1} `;
    const objstm = head + inner.join(' ');
    const page2 = 'BT /F2 10 Tf 72 700 Td (Page two \x96 caf\xe9 \x80) Tj ET q /Fm1 Do Q';
    const form = 'BT /F2 10 Tf 72 600 Td [(Sub)-40(total)-600(99.00)] TJ ET';
    const doc = pdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R 9 0 R] /Count 2 /Resources << /Font << /F1 7 0 R /F2 8 0 R >> >> >>',
      '<< /Type /Page /Parent 2 0 R /Contents [4 0 R 5 0 R] >>',
      ['<< /Length LEN /Filter /FlateDecode >>', flate('BT /F1 12 Tf 1 0 0 1 72 720 Tm <0024002500260003002700280029> Tj ET')],
      ['<< /Length LEN /Filter /FlateDecode >>', flate('BT /F1 12 Tf 1 0 0 1 72 700 Tm <0010002A> Tj 200 0 Td <002B> Tj ET')],
      ['<< /Length LEN /Filter /FlateDecode >>', flate(cmap)],
      null,
      null,
      '<< /Type /Page /Parent 2 0 R /Contents 10 0 R /Resources << /Font << /F2 8 0 R >> /XObject << /Fm1 12 0 R >> >> >>',
      ['<< /Length 11 0 R >>', Buffer.from(page2, 'latin1')],
      String(page2.length),
      ['<< /Type /XObject /Subtype /Form /Length LEN /Resources << /Font << /F2 8 0 R >> >> >>', Buffer.from(form, 'latin1')],
      ['<< /Type /ObjStm /N 2 /First LEN2 /Length LEN /Filter /FlateDecode >>'.replace('LEN2', String(head.length)), flate(objstm)],
    ]);
    const r = extractPdfText(doc);
    expect(r.pages).toBe(2); // pages are separated by a blank line
    expect(r.text.split('\n')).toEqual(['ABC DEF', '₹G H', '', 'Page two – café €', 'Subtotal 99.00']);
  });

  it('refuses a scan (an image and no text layer) plainly', () => {
    const scan = pdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /Contents 4 0 R /Resources << /XObject << /Im1 5 0 R >> >> >>',
      ['<< /Length LEN >>', Buffer.from('q 595 0 0 842 0 0 cm /Im1 Do Q', 'latin1')],
      ['<< /Type /XObject /Subtype /Image /Filter /DCTDecode /Length LEN >>', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x42, 0x54, 0x20, 0x28, 0x78, 0x29, 0x20, 0x54, 0x6a])],
    ]);
    expect(() => readDocument({ bytes: scan, filename: 'scan.pdf' })).toThrow(expect.objectContaining({ code: 'no_text', message: expect.stringMatching(/scan/) }));
  });
});

// ── XLSX ─────────────────────────────────────────────────────────────────────

describe('XLSX', () => {
  it('reads sheets in workbook order, keeps blank cells and rows, and reads date cells as dates', () => {
    const sheets = extractXlsx(workbook());
    expect(sheets.map((s) => s.name)).toEqual(['Statement', 'Notes']);
    expect(sheets[0]!.rows).toEqual([
      ['Date', 'Narration', '', 'Amount'],
      ['2026-09-26', 'NEFT CR KAPOOR, TRADERS', '', '177000'],
      [],
      ['2026-09-29', 'SMS "ALERT" CHARGES', '', '-118', 'TRUE'],
    ]);
    expect(sheets[1]!.rows).toEqual([['Notes & totals']]);
  });

  it('reads a workbook whose entries were streamed (sizes after the data), and renders CSV text', () => {
    const d = readDocument({ bytes: workbook({ streamed: true }), filename: 'statement.xlsx' });
    expect(d.method).toBe('xlsx');
    expect(d.tables!.map((t) => t.name)).toEqual(['Statement', 'Notes']);
    expect(d.text).toContain('2026-09-26,"NEFT CR KAPOOR, TRADERS",,177000');
    expect(d.text).toContain('2026-09-29,"SMS ""ALERT"" CHARGES",,-118,TRUE');
    expect(d.text).toContain('# Notes\nNotes & totals');
  });

  it('refuses a damaged workbook and the old binary .xls with a sentence a person can act on', () => {
    expect(() => readDocument({ bytes: Buffer.from('PK\x03\x04garbage'), filename: 'x.xlsx' })).toThrow(/save the sheet as CSV/);
    expect(() => readDocument({ bytes: Buffer.from([0xd0, 0xcf, 0x11, 0xe0]), filename: 'old.xls' })).toThrow(/old binary \.xls/);
  });
});

// ── CSV and text ─────────────────────────────────────────────────────────────

describe('CSV', () => {
  it('parses quoted fields, doubled quotes and newlines inside quotes', () => {
    expect(parseDelimited('a,b\n"x, y","say ""hi""\nthere"\n')).toEqual([
      ['a', 'b'],
      ['x, y', 'say "hi"\nthere'],
    ]);
  });

  it('sniffs semicolon and tab statements and decodes a BOM and UTF-16', () => {
    const semi = readDocument({ bytes: Buffer.from('﻿Date;Narration;Amount\n26/09/2026;NEFT CR KAPOOR;1.770,00\n'), filename: 'hdfc.csv' });
    expect(semi.tables![0]!.rows[1]).toEqual(['26/09/2026', 'NEFT CR KAPOOR', '1.770,00']);
    const tsv = readDocument({ bytes: Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Date\tAmount\n2026-09-27\t-8260\n', 'utf16le')]), filename: 'icici.tsv' });
    expect(tsv.tables![0]!.rows).toEqual([
      ['Date', 'Amount'],
      ['2026-09-27', '-8260'],
    ]);
  });

  it('refuses images and binary files, and empty files', () => {
    expect(() => readDocument({ bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47]), filename: 'receipt.png' })).toThrow(/images and scans are not read/);
    expect(() => readDocument({ bytes: Buffer.from([0, 1, 2, 3, 4]), filename: 'blob.bin' })).toThrow(/not a file type that is read/);
    expect(() => readDocument({ bytes: Buffer.alloc(0), filename: 'e.csv' })).toThrow(DocumentError);
  });
});

// ── attachments on a job ────────────────────────────────────────────────────

describe('attachments', () => {
  it('become a note carrying the text and hash, or a note saying why the file could not be read', () => {
    const ok = attachmentFact({ filename: 'MW-2041.pdf', content_type: 'application/pdf', content_base64: fx('bill-quartz.pdf').toString('base64') });
    expect(ok.subject).toBe('document:MW-2041.pdf');
    expect(ok.source).toMatch(/^upload:sha256:[0-9a-f]{64}$/);
    expect(ok.value).toMatchObject({ kind: 'attached_document', method: 'pdf-text', pages: 1, text_truncated: false });
    expect(String(ok.value.text)).toContain('Total Rs 47,200.00');
    const bad = attachmentFact({ filename: 'photo.jpg', content_base64: Buffer.from('xx').toString('base64') });
    expect(bad).toMatchObject({ source: 'upload:unreadable', value: { error: 'unsupported' } });
    const junk = attachmentFact({ filename: 'x.csv', content_base64: '***' });
    expect(junk.value).toMatchObject({ error: 'unsupported', message: expect.stringMatching(/not base64/) });
  });

  it('are validated before anything is written', () => {
    expect(validateAttachments(undefined)).toBeNull();
    expect(validateAttachments([{ filename: 'a.csv', content_base64: 'YQ==' }])).toBeNull();
    expect(validateAttachments('x')).toMatch(/list/);
    expect(validateAttachments(Array(6).fill({ filename: 'a.csv', content_base64: 'YQ==' }))).toMatch(/at most 5/);
    expect(validateAttachments([{ filename: '', content_base64: 'YQ==' }])).toMatch(/filename/);
    expect(validateAttachments([{ filename: 'a.csv' }])).toMatch(/content_base64/);
  });
});
