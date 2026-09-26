// Delimited text → rows. RFC 4180 quoting (quoted fields may hold the delimiter,
// quotes doubled, and newlines), the delimiter sniffed from the first lines
// (comma, semicolon, tab or pipe — Indian bank exports use all four), and the
// text decoded from UTF-8, UTF-8 with a BOM, or UTF-16 with a BOM.

export function decodeText(bytes: Buffer): string {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.subarray(2).toString('utf16le');
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    const le = Buffer.alloc(bytes.length - 2);
    for (let i = 2; i + 1 < bytes.length; i += 2) {
      le[i - 2] = bytes[i + 1]!;
      le[i - 1] = bytes[i]!;
    }
    return le.toString('utf16le');
  }
  const s = bytes.toString('utf8');
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

export function sniffDelimiter(text: string): string {
  const lines = text.split(/\r?\n/).filter((l) => l.trim()).slice(0, 10);
  let best = ',';
  let bestScore = 0;
  for (const d of [',', ';', '\t', '|']) {
    const counts = lines.map((l) => l.replace(/"[^"]*"/g, '').split(d).length - 1);
    const min = Math.min(...counts);
    // Consistent across lines beats frequent on one line.
    const score = min > 0 ? min * 10 + counts.filter((c) => c === counts[0]).length : 0;
    if (score > bestScore) {
      best = d;
      bestScore = score;
    }
  }
  return best;
}

export function parseDelimited(text: string, delimiter = sniffDelimiter(text)): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"' && field === '') quoted = true;
    else if (ch === delimiter) {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.map((r) => r.map((c) => c.trim())).filter((r) => r.some((c) => c !== ''));
}

/** Rows back to CSV text, quoting only where needed. */
export function toCsv(rows: string[][]): string {
  return rows.map((r) => r.map((c) => (/[",\n\r]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(',')).join('\n');
}
