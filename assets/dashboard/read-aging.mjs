// Reads a Debtor / Creditor Aging report exported to Excel.
//
// Shape is one row per counterparty and one column per age bucket:
//
//   CODE | CURRENT | 1 MONTH | 2 MONTHS | ... | 11 & OVER | BALANCE
//
// ⚠️ The buckets count months since the INVOICE date. The report carries no due
// date and no credit term, so it cannot say what is overdue - only how old
// things are. With 60-day terms the "1 MONTH" column is not yet due at all.
// Deciding otherwise without asking produces a confident overdue figure that
// sends someone chasing customers who still have a month to pay. The term has to
// come from the user; see the finance-dashboard-import skill.
import { readGrid, logicalCells, loadMap, asNumber } from "./read-ledger.mjs";

export function readAging(file) {
  const MAP = loadMap();
  const { grid, contRows } = readGrid(file);
  const cols = MAP.agingColumns;
  const bucketRe = new RegExp(MAP.agingBucketPattern, "i");
  const overRe = new RegExp(MAP.agingOverPattern, "i");

  const matches = (text, list) => {
    const t = String(text || "").trim().toLowerCase();
    return list.some((l) => t === l.toLowerCase() || t.startsWith(l.toLowerCase()));
  };

  // The header is spread over consecutive rows here: the bucket names sit on one
  // line and COMPANY NAME on the next, so the scan keeps going until it has both.
  let head = null;              // { code, name, balance, buckets: [{label, months, col}] }
  let headRow = -1;
  for (let r = 0; r < grid.length && r < 60; r++) {
    const cells = logicalCells(grid[r]);
    if (!cells.length) continue;
    const found = { buckets: [] };
    for (const c of cells) {
      const t = c.text;
      if (matches(t, cols.code) && found.code === undefined) { found.code = c.col; continue; }
      if (matches(t, cols.name) && found.name === undefined) { found.name = c.col; continue; }
      if (matches(t, cols.balance) && found.balance === undefined) { found.balance = c.col; continue; }
      if (matches(t, cols.current)) { found.buckets.push({ label: t, months: 0, col: c.col }); continue; }
      const m = bucketRe.exec(t);
      if (m) {
        found.buckets.push({ label: t, months: Number(m[1]), col: c.col, over: overRe.test(t) });
        continue;
      }
      if (overRe.test(t) && /\d/.test(t)) {
        const n = (t.match(/\d+/) || [0])[0];
        found.buckets.push({ label: t, months: Number(n), col: c.col, over: true });
      }
    }
    if (found.buckets.length >= 3) {
      head = head || { buckets: [] };
      head.buckets = found.buckets;
      if (found.code !== undefined) head.code = found.code;
      if (found.name !== undefined) head.name = found.name;
      if (found.balance !== undefined) head.balance = found.balance;
      headRow = r;
    } else if (head && headRow >= 0 && r <= headRow + 2) {
      // Continuation of a two-line header.
      if (found.name !== undefined && head.name === undefined) head.name = found.name;
      if (found.balance !== undefined && head.balance === undefined) head.balance = found.balance;
      if (found.code !== undefined && head.code === undefined) head.code = found.code;
    }
  }
  if (!head || !head.buckets.length) {
    throw new Error(file.split("/").pop() +
      ": 找不到帐龄分桶标题（CURRENT / 1 MONTH / …）。把实际用词加进 ledger-map.json 的 agingColumns。");
  }
  head.buckets.sort((a, b) => a.months - b.months);

  // Data rows: a code row carries the numbers, and the name usually lands on the
  // next row. Pair them rather than assuming one row per counterparty.
  // Continuation rows are NOT skipped here, unlike in the ledger parser. In this
  // layout the counterparty's name sits on the continuation row underneath its
  // code, so skipping them loses every name. Double counting is prevented by
  // keying on the code instead: only a row carrying bucket numbers opens a new
  // record, and a code already seen is ignored.
  const rows = [];
  const seen = new Set();
  let pending = null;
  for (let r = headRow + 1; r < grid.length; r++) {
    const cells = logicalCells(grid[r]);
    if (!cells.length) continue;
    const firstText = cells[0].text;
    if (/^(group total|grand total|end of report|report criteria|合计|总计)/i.test(firstText)) {
      pending = null;
      continue;
    }
    const hasNumbers = head.buckets.some((b) => {
      const v = grid[r][b.col];
      return typeof v === "number" || (v !== null && v !== "" && !isNaN(Number(String(v).replace(/,/g, ""))));
    });
    if (hasNumbers && head.code !== undefined && grid[r][head.code] !== null) {
      const code = String(grid[r][head.code]).trim();
      if (seen.has(code)) continue;
      seen.add(code);
      pending = {
        code: code,
        name: null,
        balance: head.balance !== undefined ? asNumber(grid[r][head.balance]) : 0,
        buckets: head.buckets.map((b) => ({ label: b.label, months: b.months, amount: asNumber(grid[r][b.col]) })),
      };
      // The balance column can be merged a cell off; fall back to the bucket sum.
      if (!pending.balance) pending.balance = pending.buckets.reduce((s, b) => s + b.amount, 0);
      rows.push(pending);
    } else if (pending && head.name !== undefined) {
      const nm = grid[r][head.name];
      if (!pending.name && nm !== null && String(nm).trim()) pending.name = String(nm).trim();
      // The balance often lands on this row rather than the code row.
      if (head.balance !== undefined) {
        const b = asNumber(grid[r][head.balance]);
        if (b) pending.balanceRow = b;
      }
    }
  }
  return { head, rows };
}
