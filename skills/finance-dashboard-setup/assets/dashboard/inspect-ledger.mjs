// Says what it found in an export, and computes nothing.
//
//   node inspect-ledger.mjs <file.xlsx> [more.xlsx ...]
//
// Run this before build-data-file.mjs, always. Every package words its exports
// differently, and a parser that guesses wrong does not crash - it produces a
// smaller number. Structure first, arithmetic second.
//
// Prints column names, section counts and date ranges. It does not print
// customer names or amounts: knowing the shape is the job here, and export files
// are somebody's real ledger.
import { readGrid, logicalCells, loadMap, fieldOf, asDate, asNumber } from "./read-ledger.mjs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const files = process.argv.slice(2);
if (!files.length) {
  console.error("用法: node inspect-ledger.mjs <档案.xlsx> [更多档案...]");
  process.exit(2);
}
const MAP = loadMap();

export function scan(file) {
  const { grid, sheet, sheets } = readGrid(file);
  const secLabels = MAP.sectionLabels.map((s) => s.toLowerCase());
  const skip = MAP.skipRowLabels.map((s) => s.toLowerCase());

  let header = null;            // field -> column, from the first header row seen
  const headerVariants = [];    // every distinct header row, to catch mid-file changes
  const sections = [];
  let dataRows = 0, dmin = null, dmax = null;
  let cur = null;

  for (let r = 0; r < grid.length; r++) {
    const cells = logicalCells(grid[r]);
    if (!cells.length) continue;
    const first = cells[0].text.toLowerCase();

    // Section line: "Account Code:  3000-001  Some Customer"
    if (secLabels.some((l) => first.startsWith(l))) {
      // Only the first cell is the label. Filtering the value cells by the same
      // list is what let an account NAMED "ACCOUNTING FEE" be mistaken for one.
      const rest = cells.slice(1);
      cur = { code: rest[0] ? rest[0].text : null, name: rest[1] ? rest[1].text : null, rows: 0 };
      if (cur.code) sections.push(cur);
      continue;
    }

    // Header line: two or more cells that name known fields.
    const mapped = {};
    let hits = 0;
    for (const c of cells) {
      const f = fieldOf(c.text, MAP.columns);
      if (f && mapped[f] === undefined) { mapped[f] = c.col; hits++; }
    }
    if (hits >= 3) {
      const sig = Object.keys(mapped).sort().join(",");
      if (!headerVariants.some((h) => h.sig === sig)) headerVariants.push({ sig, map: mapped, row: r + 1 });
      if (!header) header = mapped;
      continue;
    }

    if (!header) continue;
    if (skip.some((l) => first.startsWith(l))) continue;

    const d = asDate(grid[r][header.date]);
    if (!d) continue;
    dataRows++;
    if (cur) cur.rows++;
    if (!dmin || d < dmin) dmin = d;
    if (!dmax || d > dmax) dmax = d;
  }

  return { file, sheet, sheets, header, headerVariants, sections, dataRows, dmin, dmax };
}

// Comparing the URL to a hand-built "file://" + path breaks the moment the path
// contains a space, because the URL percent-encodes it and the string does not.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const REQUIRED = ["date", "debit", "credit"];
  let problems = 0;

  for (const f of files) {
    let s;
    try { s = scan(f); }
    catch (e) { console.log("\n" + f + "\n  读取失败: " + e.message); problems++; continue; }

    console.log("\n" + "=".repeat(72));
    console.log(f.split("/").pop());
    console.log("=".repeat(72));
    console.log("  工作表: " + s.sheet + (s.sheets.length > 1 ? "（共 " + s.sheets.length + " 个）" : ""));

    if (!s.header) {
      console.log("  ❌ 找不到栏位标题列。");
      console.log("     这份档案的标题用词不在 ledger-map.json 里 —— 把实际用词加进去即可。");
      problems++;
      continue;
    }
    console.log("  栏位对应:");
    for (const [k, v] of Object.entries(s.header)) {
      console.log("     " + k.padEnd(12) + "→ 第 " + (v + 1) + " 栏");
    }
    const missing = REQUIRED.filter((k) => s.header[k] === undefined);
    if (missing.length) { console.log("  ❌ 缺少必要栏位: " + missing.join(", ")); problems++; }

    // A file whose header row changes partway through is a file that will be
    // parsed correctly at the top and wrongly at the bottom.
    if (s.headerVariants.length > 1) {
      console.log("  ⚠️  档案中出现 " + s.headerVariants.length + " 种不同的标题列组合:");
      s.headerVariants.forEach((h) => console.log("       第 " + h.row + " 列: " + h.sig));
      problems++;
    }

    console.log("  科目段: " + s.sections.length);
    console.log("  交易列: " + s.dataRows.toLocaleString());
    console.log("  期间:   " + (s.dmin || "—") + " → " + (s.dmax || "—"));

    const pre = {};
    s.sections.forEach((x) => {
      const p = String(x.code || "").trim()[0] || "?";
      pre[p] = (pre[p] || 0) + 1;
    });
    const kinds = Object.entries(pre).sort()
      .map(([p, n]) => p + "xxx " + (MAP.accountPrefixes[p] || "?") + " ×" + n);
    if (kinds.length) console.log("  科目前缀: " + kinds.join(" · "));

    const empty = s.sections.filter((x) => !x.rows).length;
    if (empty) console.log("  （其中 " + empty + " 个科目段没有交易，属正常）");

    if (s.header.dueDate === undefined)
      console.log("  ⚠️  没有『到期日』栏 —— 帐龄无法按到期日分桶。另外要一份帐龄表。");
    if (s.header.outstanding === undefined)
      console.log("  ⚠️  没有『未清金额』栏 —— 逐张单据的未结金额要用余额推算。");
  }

  console.log("\n" + "-".repeat(72));
  if (problems) {
    console.log(problems + " 个问题需要处理。改 ledger-map.json 加上这份档案的实际用词，再跑一次。");
    process.exit(1);
  }
  console.log("结构没问题，可以跑 build-data-file.mjs。");
}
