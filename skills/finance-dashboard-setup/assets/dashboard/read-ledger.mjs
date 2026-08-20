// Reads an accounting export that is a REPORT LAYOUT rather than a table, and
// turns it into rows.
//
// Exports of this kind are not spreadsheets in any useful sense. They carry a
// report header, then repeat a block per account: a section line naming the
// account, a column-header line, an opening balance, the transactions, a total.
// Values sit in merged cells, and - this is the part that quietly ruins a naive
// parser - the header label and the value underneath it do NOT share a column
// index. On the reference export the "Debit" label sits at column 30 while its
// numbers sit at 27, because each is anchored at the start of a different merged
// range. Reading by the header's own column index yields empty cells, and an
// empty cell reads as zero.
//
// Flattening the merges first fixes it: every cell in a merged range takes the
// range's value, so the label's column and the number's column finally coincide.
// That one step is what makes this work across packages, because the layout
// differs but the merging behaviour does not.
import XLSX from "xlsx";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));

// A cell grid with merges expanded, addressed [row][col], both 0-based.
export function readGrid(file, sheetName) {
  // No cellDates. Letting the reader build Date objects hands the result to the
  // machine's timezone: the same file read in UTC+8 and UTC+9 produced 30 and 31
  // December for one cell. The raw serial is unambiguous, and students run this
  // on their own machines, so the answer must not depend on where they sit.
  const wb = XLSX.readFile(file);
  const name = sheetName || wb.SheetNames[0];
  const ws = wb.Sheets[name];
  if (!ws) throw new Error(file + ": no sheet named " + name);

  // Absolute indexing throughout: grid[r][c] is always sheet row r, column c.
  //
  // A report export usually does not start at A1 - this one begins at A2 - so a
  // grid built from range.s.r is offset from the merge list, which is always
  // absolute. Applying merges against an offset grid writes every value one row
  // out of place, and the result is not an error: headers stop matching their
  // own columns and every amount reads as zero. Paying for a few empty leading
  // rows removes a whole class of that.
  const range = XLSX.utils.decode_range(ws["!ref"] || "A1");
  const grid = [];
  for (let r = 0; r <= range.e.r; r++) {
    const row = [];
    for (let c = 0; c <= range.e.c; c++) {
      if (r < range.s.r || c < range.s.c) { row.push(null); continue; }
      const cell = ws[XLSX.utils.encode_cell({ r, c })];
      row.push(cell === undefined ? null : (cell.v === undefined ? null : cell.v));
    }
    grid.push(row);
  }

  // Expand merges. Without this the parser reads holes where the numbers are.
  //
  // Vertical merges also mean one transaction occupies several grid rows, all
  // identical once expanded. Counting them all doubles every figure, so the
  // continuation rows are recorded here and skipped by callers. This is taken
  // from the merge list rather than by comparing adjacent rows: two genuinely
  // identical postings on the same day are ordinary in a ledger, and a
  // similarity test would silently delete one of them.
  const contRows = new Set();
  for (const m of ws["!merges"] || []) {
    const v = grid[m.s.r] ? grid[m.s.r][m.s.c] : null;
    for (let r = m.s.r; r <= m.e.r; r++) {
      if (r > m.s.r) contRows.add(r);
      if (v === null || v === undefined) continue;
      for (let c = m.s.c; c <= m.e.c; c++) {
        if (grid[r]) grid[r][c] = v;
      }
    }
  }
  return { grid, sheet: name, sheets: wb.SheetNames, contRows };
}

// After flattening, a merged value repeats across its columns. Collapsing runs
// of the identical value gives back the logical cells of the row.
export function logicalCells(row) {
  const out = [];
  let prev = null;
  for (let c = 0; c < row.length; c++) {
    const v = row[c];
    if (v === null || v === undefined || String(v).trim() === "") { prev = null; continue; }
    const s = String(v);
    if (s === prev) continue;
    out.push({ col: c, value: v, text: s.trim() });
    prev = s;
  }
  return out;
}

// Resolved against this file, not the working directory - the export files live
// wherever the user keeps them, and that is where the command gets run from.
export function loadMap(path) {
  return JSON.parse(readFileSync(path || resolve(HERE, "ledger-map.json"), "utf8"));
}

// Which field, if any, a header cell names. Longest match wins so that
// "due date" is not swallowed by "date".
export function fieldOf(text, columns) {
  const t = String(text || "").trim().toLowerCase();
  if (!t) return null;
  let best = null, bestLen = 0;
  for (const [field, labels] of Object.entries(columns)) {
    for (const l of labels) {
      const ll = l.toLowerCase();
      if (t.startsWith(ll) && ll.length > bestLen) { best = field; bestLen = ll.length; }
    }
  }
  return best;
}

export const asNumber = (v) => {
  if (v === null || v === undefined || v === "") return 0;
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  const s = String(v).trim().replace(/,/g, "");
  const neg = /^\(.*\)$/.test(s);
  const n = Number(neg ? s.slice(1, -1) : s);
  return Number.isFinite(n) ? (neg ? -n : n) : 0;
};

const ymd = (y, m, d) =>
  y + "-" + String(m).padStart(2, "0") + "-" + String(d).padStart(2, "0");

export const asDate = (v) => {
  // Local components, never toISOString(). A date cell holding 31 Dec arrives as
  // a Date at local midnight; rendering it through UTC moves it to the 30th east
  // of Greenwich, and a transaction on the 1st slides into the previous month.
  // Month totals then differ from the accounting system with nothing to show why.
  if (v instanceof Date && !isNaN(v)) return ymd(v.getFullYear(), v.getMonth() + 1, v.getDate());
  if (typeof v === "number" && v > 20000 && v < 60000) {
    // Excel serial date, 1900 epoch with its off-by-one. Read back in UTC
    // because that is how it was constructed here.
    const d = new Date(Date.UTC(1899, 11, 30) + v * 86400000);
    return ymd(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
  }
  const s = String(v || "").trim();
  const iso = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (iso) return iso[1] + "-" + iso[2].padStart(2, "0") + "-" + iso[3].padStart(2, "0");
  const dmy = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})/);
  // Ambiguous by nature. The exports seen so far are d/m/Y; a package that
  // writes m/d/Y would need this told to it rather than guessed.
  if (dmy) return dmy[3] + "-" + dmy[2].padStart(2, "0") + "-" + dmy[1].padStart(2, "0");
  return null;
};
