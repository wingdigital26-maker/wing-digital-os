// Tiny dependency-free CSV parser. Handles quoted fields, commas and newlines
// inside quotes, escaped double-quotes (""), CRLF or LF line endings, and a
// header row. Returns an array of row objects keyed by the (lowercased,
// trimmed) header names. Anything the real world throws at a pasted export.
//
// Deliberately not RFC-4180-perfect: it tolerates a trailing newline, blank
// lines, and rows with fewer columns than the header (missing cells read as "").

// Split raw CSV text into rows of string cells, respecting quotes.
function tokenize(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const n = text.length;

  const endField = () => {
    row.push(field);
    field = "";
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };

  while (i < n) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += c;
      i += 1;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (c === ",") {
      endField();
      i += 1;
      continue;
    }
    if (c === "\r") {
      // Swallow CRLF as one line break; a lone CR also ends the row.
      if (text[i + 1] === "\n") i += 1;
      endRow();
      i += 1;
      continue;
    }
    if (c === "\n") {
      endRow();
      i += 1;
      continue;
    }
    field += c;
    i += 1;
  }
  // Flush the last field/row unless the file ended exactly on a line break with
  // nothing after it.
  if (field.length > 0 || row.length > 0) endRow();
  return rows;
}

// Parse CSV text into row objects keyed by lowercased header names. A row that
// is entirely empty (blank line) is skipped.
export function parseCsv(text: string): Record<string, string>[] {
  if (typeof text !== "string" || text.trim() === "") return [];
  const rows = tokenize(text);
  if (!rows.length) return [];

  const headers = rows[0].map((h) => h.trim().toLowerCase());
  const out: Record<string, string>[] = [];

  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r];
    // Skip blank lines (a single empty cell and nothing else).
    if (cells.length === 1 && cells[0].trim() === "") continue;
    const obj: Record<string, string> = {};
    for (let c = 0; c < headers.length; c++) {
      const key = headers[c];
      if (!key) continue;
      obj[key] = (cells[c] ?? "").trim();
    }
    out.push(obj);
  }
  return out;
}
