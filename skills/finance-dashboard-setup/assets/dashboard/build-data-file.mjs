// Builds dashboard-data.json from exported ledger files, in exactly the shape
// build-data.mjs and build-data-cloud.mjs produce, so everything downstream -
// the renderer, the headless check, the encrypted build - is untouched.
//
//   node build-data-file.mjs <folder-with-exports>
//
// Run inspect-ledger.mjs first. This one assumes the structure has already been
// confirmed; it will still refuse to guess, but the friendly diagnosis lives
// there rather than here.
//
// ---------------------------------------------------------------------------
// WHAT THIS ROUTE CAN AND CANNOT KNOW
//
// The general ledger gives every posting, so the profit and loss, the cash
// movements and the drill-downs are as solid here as on a live connection -
// arguably more so, since the cloud route has to reconstruct a ledger it cannot
// read directly.
//
// What it cannot give is a due date. Aging reports bucket by months since the
// invoice and carry no credit term, so "overdue" is derived from the term the
// user supplied in profile.json. That is a stated assumption, not a fact from
// the books, and it is labelled as such in the output.
import { readGrid, logicalCells, loadMap, fieldOf, asDate, asNumber } from "./read-ledger.mjs";
import { readAging } from "./read-aging.mjs";
import { profile } from "./profile.mjs";
import { readdirSync, writeFileSync, statSync } from "node:fs";
import { join, extname } from "node:path";

const dir = process.argv[2];
if (!dir) {
  console.error("用法: node build-data-file.mjs <汇出档资料夹>");
  process.exit(2);
}

const MAP = loadMap();
const MONTHS = profile.months || 37;
const TERM = (profile.creditTermDays || {});
const TODAY = new Date().toISOString().slice(0, 10);

// -------------------------------------------------------------- file discovery
// Students hand over .xls, .xlsx and .csv interchangeably, and name the files
// whatever their software called them. Classify on the filename, and say what
// was matched so a misfiled export is visible rather than silently skipped.
const KINDS = [
  { kind: "debtorAging",   re: /(debtor|receivable|ar|应收).*(aging|ageing|帐龄|账龄)|aging.*(debtor|receivable)/i },
  { kind: "creditorAging", re: /(creditor|payable|ap|应付).*(aging|ageing|帐龄|账龄)|aging.*(creditor|payable)/i },
  { kind: "salesLedger",   re: /(sales|debtor|receivable|应收).*(ledger|明细)/i },
  { kind: "purchaseLedger",re: /(purchase|creditor|payable|应付).*(ledger|明细)/i },
  { kind: "gl",            re: /(general\s*ledger|^gl\b|总帐|总账)/i },
];

function discover(folder) {
  const found = {};
  const skipped = [];
  for (const name of readdirSync(folder)) {
    const full = join(folder, name);
    if (statSync(full).isDirectory()) continue;
    const ext = extname(name).toLowerCase();
    if (![".xls", ".xlsx", ".csv"].includes(ext)) { skipped.push(name); continue; }
    const hit = KINDS.find((k) => k.re.test(name));
    if (!hit) { skipped.push(name); continue; }
    if (!found[hit.kind]) found[hit.kind] = full;
  }
  return { found, skipped };
}

// ------------------------------------------------------------- classification
const OV = MAP.classifyOverrides || [];
const PRESET = MAP.accountPrefixPresets[profile.accountPreset || "sql-accounting"] || {};
const CASH = MAP.cashAccounts;

function classify(code, name) {
  const n = String(name || "").toLowerCase();
  // Name overrides win: a prefix cannot tell a gain on disposal from turnover.
  for (const o of OV) if (n.includes(o.match)) return o.as;
  return PRESET[String(code || "").trim()[0]] || "other";
}
const LINE = { income: "SL", contraRevenue: "SL", otherIncome: "OI",
               costOfSales: "CO", contraCost: "CO", expense: "EP" };

function isCash(code, name) {
  const n = String(name || "").toLowerCase();
  if (CASH.nameExcludes.some((x) => n.includes(x))) return false;
  if (!CASH.nameMatches.some((x) => n.includes(x))) return false;
  return CASH.requireClass.includes(classify(code, name));
}

// --------------------------------------------------------------- ledger parse
function parseLedger(file) {
  const { grid, contRows } = readGrid(file);
  const secLabels = MAP.sectionLabels.map((s) => s.toLowerCase());
  const skip = MAP.skipRowLabels.map((s) => s.toLowerCase());
  let head = null, cur = null;
  const postings = [];
  const opening = new Map();     // account -> balance brought forward

  for (let r = 0; r < grid.length; r++) {
    if (contRows.has(r)) continue;          // one transaction, several grid rows
    const cells = logicalCells(grid[r]);
    if (!cells.length) continue;
    const first = cells[0].text.toLowerCase();

    if (secLabels.some((l) => first.startsWith(l))) {
      // Only the first cell is the label. Filtering the value cells by the same
      // list is what let an account NAMED "ACCOUNTING FEE" be mistaken for one.
      const rest = cells.slice(1);
      cur = rest.length >= 2 ? { code: rest[0].text.trim(), name: rest[1].text.trim() } : null;
      continue;
    }
    const mapped = {}; let hits = 0;
    for (const c of cells) {
      const f = fieldOf(c.text, MAP.columns);
      if (f && mapped[f] === undefined) { mapped[f] = c.col; hits++; }
    }
    if (hits >= 3) { head = mapped; continue; }
    if (!head || !cur) continue;
    if (skip.some((l) => first.startsWith(l))) {
      // BALANCE B/F is not a posting, but it is the opening balance - the one
      // thing the cloud route could never get. Captured here so cash and
      // liability figures are positions rather than twelve months of movement.
      const line = cells.map((c) => c.text).join(" ");
      if (/balance b\/f|承前|承上/i.test(line) && head.balance !== undefined && cur) {
        const v = asNumber(grid[r][head.balance]);
        if (v && !opening.has(cur.code)) opening.set(cur.code, v);
      }
      continue;
    }

    const date = asDate(grid[r][head.date]);
    if (!date) continue;
    const dr = asNumber(grid[r][head.debit]);
    const cr = asNumber(grid[r][head.credit]);
    if (!dr && !cr) continue;
    postings.push({
      date, ym: date.slice(0, 7), acc: cur.code, accName: cur.name,
      dr, cr,
      ref: head.ref !== undefined ? String(grid[r][head.ref] ?? "").trim() : "",
      desc: head.description !== undefined ? String(grid[r][head.description] ?? "").trim().slice(0, 70) : "",
      jt: head.journal !== undefined ? String(grid[r][head.journal] ?? "").trim() : "",
    });
  }
  return { postings, opening };
}

// --------------------------------------------------------------------- build
const { found, skipped } = discover(dir);
if (!found.gl) {
  console.error("找不到总帐档案。档名需含 'general ledger' / 'GL' / '总帐'，副档名 .xls/.xlsx/.csv");
  console.error("这个资料夹里看到的: " + readdirSync(dir).join(", "));
  process.exit(1);
}
console.log("辨识到的档案:");
for (const [k, v] of Object.entries(found)) console.log("  " + k.padEnd(16) + v.split("/").pop());
if (skipped.length) console.log("  （略过: " + skipped.join(", ") + "）");

// All three ledgers, merged.
//
// SQL Accounting splits postings by ledger TYPE: the General Ledger export
// deliberately excludes anything that belongs to the debtor or creditor
// sub-ledgers, which come out as the Sales and Purchase ledgers. Read alone the
// General Ledger is out by the whole of the other two - on the reference export
// by 453,475 - and looks like a broken parse. Together they balance to the cent
// and share no account codes, so merging cannot double count.
const sources = [["gl", found.gl], ["salesLedger", found.salesLedger],
                 ["purchaseLedger", found.purchaseLedger]].filter(([, f]) => f);
const gl = [];
const OPENING = new Map();
console.log("");
for (const [kind, file] of sources) {
  const parsed = parseLedger(file);
  const rows = parsed.postings;
  parsed.opening.forEach((v, k) => { if (!OPENING.has(k)) OPENING.set(k, v); });
  const d = rows.reduce((t, r) => t + r.dr, 0), c = rows.reduce((t, r) => t + r.cr, 0);
  console.log("  " + kind.padEnd(16) + String(rows.length).padStart(6) + " 笔 · 借 " +
    Math.round(d).toLocaleString().padStart(11) + " · 贷 " + Math.round(c).toLocaleString().padStart(11) +
    " · 差 " + Math.round(d - c).toLocaleString());
  gl.push(...rows);
}
if (!gl.length) { console.error("没有解析到任何分录。先跑 inspect-ledger.mjs。"); process.exit(1); }
if (sources.length < 3) {
  console.log("  ⚠️ 只读到 " + sources.length + "/3 份分类帐 —— 少一份就不会平衡。");
}

// The one check that decides whether the parse can be trusted at all.
const totDr = gl.reduce((s, p) => s + p.dr, 0);
const totCr = gl.reduce((s, p) => s + p.cr, 0);
const outBal = Math.round((totDr - totCr) * 100) / 100;
console.log("\n合计: " + gl.length.toLocaleString() + " 笔 · 借 " +
  Math.round(totDr).toLocaleString() + " · 贷 " + Math.round(totCr).toLocaleString() +
  " · 差 " + outBal + (Math.abs(outBal) < 1 ? "  ✅ 平衡" : "  ⚠️ 不平衡"));

const num = (v) => Math.round((Number(v) || 0) * 100) / 100;
const months = [...new Set(gl.map((p) => p.ym))].sort().slice(-MONTHS);
const inMonths = new Set(months);
const post = gl.filter((p) => inMonths.has(p.ym));

const accInfo = new Map();
post.forEach((p) => {
  if (!accInfo.has(p.acc)) accInfo.set(p.acc, { name: p.accName, cls: classify(p.acc, p.accName) });
});
const clsOf = (a) => (accInfo.get(a) || {}).cls || "other";
const nameOf = (a) => (accInfo.get(a) || {}).name || a;
const lineOf = (a) => LINE[clsOf(a)] || null;
const signed = (p) => {
  const l = lineOf(p.acc);
  return (l === "SL" || l === "OI") ? p.cr - p.dr : p.dr - p.cr;
};

const out = {
  db: dir.split("/").filter(Boolean).pop(),
  name: profile.brand || dir.split("/").filter(Boolean).pop(),
  short: (profile.books && profile.books[0] && profile.books[0].short) || "CO1",
  tier: "active",
};

// ---- monthly P&L
const pm = new Map();
post.forEach((p) => {
  const l = lineOf(p.acc);
  if (!l) return;
  const e = pm.get(p.ym) || { rev: 0, cost: 0 };
  if (l === "SL" || l === "OI") e.rev += p.cr - p.dr; else e.cost += p.dr - p.cr;
  pm.set(p.ym, e);
});
out.pnlByMonth = months.map((m) => {
  const e = pm.get(m) || { rev: 0, cost: 0 };
  return { ym: m, rev: num(e.rev), cost: num(e.cost), profit: num(e.rev - e.cost) };
}).filter((x) => x.rev || x.cost);

// ---- per-account monthly folds
function fold(filterFn) {
  const by = new Map();
  post.forEach((p) => {
    if (!filterFn(p.acc)) return;
    const v = signed(p);
    if (!v) return;
    const e = by.get(p.acc) || { acc: p.acc, name: nameOf(p.acc), type: lineOf(p.acc), m: {}, total: 0 };
    e.m[p.ym] = num((e.m[p.ym] || 0) + v);
    e.total = num(e.total + v);
    by.set(p.acc, e);
  });
  return [...by.values()].filter((e) => Object.keys(e.m).length)
    .sort((a, b) => Math.abs(b.total) - Math.abs(a.total));
}
out.revenueAccounts = fold((a) => ["SL", "OI"].includes(lineOf(a)));
out.expenses = fold((a) => ["CO", "EP"].includes(lineOf(a)));

// ---- cash: banks identified by class AND name, never by name alone
const cashAccs = [...accInfo.keys()].filter((a) => isCash(a, nameOf(a)));
const cashSet = new Set(cashAccs);
const bal = new Map();
cashAccs.forEach((a) => { if (OPENING.has(a)) bal.set(a, num(OPENING.get(a))); });
gl.forEach((p) => { if (cashSet.has(p.acc)) bal.set(p.acc, num((bal.get(p.acc) || 0) + p.dr - p.cr)); });
out.cashAccounts = [...bal.entries()].filter(([, v]) => v !== 0)
  .map(([acc, v]) => ({ acc, name: nameOf(acc), kind: "SBK", bal: v }))
  .sort((a, b) => b.bal - a.bal);
out.cash = num(out.cashAccounts.reduce((s, r) => s + r.bal, 0));

// ---- cash flow: bank movement against whatever it faced in the same document
const byRef = new Map();
post.forEach((p) => {
  const k = p.date + "|" + p.ref;
  (byRef.get(k) || byRef.set(k, []).get(k)).push(p);
});
const cfMap = new Map();
for (const group of byRef.values()) {
  const banks = group.filter((p) => cashSet.has(p.acc));
  const others = group.filter((p) => !cashSet.has(p.acc));
  if (!banks.length) continue;
  const contra = others.sort((a, b) => Math.abs(b.dr + b.cr) - Math.abs(a.dr + a.cr))[0];
  for (const b of banks) {
    const key = b.acc + "|" + b.ym + "|" + (contra ? contra.acc : "");
    const e = cfMap.get(key) || { bank: b.acc, ym: b.ym, contra: contra ? contra.acc : "", in: 0, out: 0, n: 0 };
    e.in = num(e.in + b.dr); e.out = num(e.out + b.cr); e.n++;
    cfMap.set(key, e);
  }
}
const bankIx = new Map(), contraIx = new Map();
out.cfBanks = []; out.cfContra = []; out.cashFlow = [];
for (const r of cfMap.values()) {
  if (!r.in && !r.out) continue;
  if (!bankIx.has(r.bank)) { bankIx.set(r.bank, out.cfBanks.length); out.cfBanks.push({ a: r.bank, n: nameOf(r.bank) }); }
  if (!contraIx.has(r.contra)) {
    contraIx.set(r.contra, out.cfContra.length);
    out.cfContra.push({ a: r.contra, n: r.contra ? nameOf(r.contra) : "(无对方科目)",
                        t: r.contra ? (lineOf(r.contra) || clsOf(r.contra)) : "?",
                        x: cashSet.has(r.contra) ? 1 : 0 });
  }
  out.cashFlow.push([bankIx.get(r.bank), r.ym, contraIx.get(r.contra), r.in, r.out, r.n]);
}

// ---- aging, from the aging reports, with the term stated
const limitations = [];
function ageFrom(file, termDays, label) {
  const empty = { notDue: 0, d30: 0, d60: 0, d90: 0, over90: 0, total: 0, overdue: 0 };
  if (!file) { limitations.push("没有" + label + "帐龄表，" + label + "帐龄留空。"); return { buckets: empty, rows: [] }; }
  const { rows } = readAging(file);
  const termMonths = (termDays || 0) / 30;
  const b = { ...empty };
  rows.forEach((r) => {
    r.buckets.forEach((bk) => {
      // Buckets count months since invoice; the term shifts where "overdue"
      // begins. Stated, not discovered - see the note pushed into limitations.
      const overdueMonths = bk.months - termMonths;
      const amt = bk.amount;
      if (!amt) return;
      if (overdueMonths <= 0) b.notDue += amt;
      else if (overdueMonths <= 1) b.d30 += amt;
      else if (overdueMonths <= 2) b.d60 += amt;
      else if (overdueMonths <= 3) b.d90 += amt;
      else b.over90 += amt;
    });
  });
  b.total = num(b.notDue + b.d30 + b.d60 + b.d90 + b.over90);
  b.overdue = num(b.d30 + b.d60 + b.d90 + b.over90);
  ["notDue", "d30", "d60", "d90", "over90"].forEach((k) => { b[k] = num(b[k]); });
  limitations.push(label + "帐龄以账期 " + (termDays || "?") +
    " 天推算：帐龄表按「距开票日几个月」分桶，没有到期日，这是推算不是事实。");
  return { buckets: b, rows };
}
const arA = ageFrom(found.debtorAging, TERM.ar, "应收");
const apA = ageFrom(found.creditorAging, TERM.ap, "应付");
out.ar = arA.buckets;
out.ap = apA.buckets;

const partyIx = new Map(); out.parties = [];
const party = (n) => {
  const k = n || "(未命名)";
  if (!partyIx.has(k)) { partyIx.set(k, out.parties.length); out.parties.push(k); }
  return partyIx.get(k);
};
const termMonthsAr = (TERM.ar || 0) / 30;
out.topDebtors = arA.rows.slice().sort((a, b) => b.balance - a.balance).slice(0, 10).map((r) => {
  const oldest = r.buckets.filter((b) => b.amount).map((b) => b.months).sort((a, b) => b - a)[0] || 0;
  return { name: r.name || r.code, acc: r.code, docs: 0, owing: num(r.balance),
           oldestLate: Math.round((oldest - termMonthsAr) * 30), limit: 0, overLimit: false, group: false };
});
const termMonthsAp = (TERM.ap || 0) / 30;
out.topCreditors = apA.rows.slice().sort((a, b) => b.balance - a.balance).slice(0, 15).map((r) => {
  const oldest = r.buckets.filter((b) => b.amount).map((b) => b.months).sort((a, b) => b - a)[0] || 0;
  return { name: r.name || r.code, docs: 0, owing: num(r.balance),
           late: Math.round((oldest - termMonthsAp) * 30) };
});

// ---- transaction detail
const accIx = new Map(); out.accs = [];
const accRef = (a) => {
  if (!a) return -1;
  if (!accIx.has(a)) { accIx.set(a, out.accs.length); out.accs.push({ a, n: nameOf(a), t: lineOf(a) || clsOf(a) }); }
  return accIx.get(a);
};
out.txns = post.filter((p) => lineOf(p.acc) || cashSet.has(p.acc)).map((p) => {
  const l = lineOf(p.acc);
  let kind, amt;
  if (cashSet.has(p.acc)) { kind = "C"; amt = num(p.dr - p.cr); }
  else if (l === "SL" || l === "OI") { kind = "R"; amt = num(p.cr - p.dr); }
  else if (clsOf(p.acc) === "liability") { kind = "L"; amt = num(p.cr - p.dr); }
  else { kind = "E"; amt = num(p.dr - p.cr); }
  return [p.date, p.ref, p.desc, accRef(p.acc), -1, amt, kind, p.jt];
}).filter((t) => t[5] !== 0).sort((a, b) => (a[0] < b[0] ? 1 : -1));

// Not derivable from these exports; left empty rather than invented.
out.billingsByMonth = [];
out.serviceLines = [];
out.customers = [];
out.openInvoices = [];
out.arDocs = [];
out.apDocs = [];
out.slDocs = [];
out.liabilities = [];
out.deptCoverage = { lines: post.length, filled: 0, share: 0 };
out.sourceCounts = { glPostings: gl.length, debtors: arA.rows.length, creditors: apA.rows.length };
out.glPostings = gl.length;

const openCount = cashAccs.filter((a) => OPENING.has(a)).length;
limitations.push(openCount
  ? "现金余额含期初（帐上 BALANCE B/F），是当下位置不是期间变动 —— " +
    openCount + "/" + cashAccs.length + " 个银行现金科目有期初余额。"
  : "⚠️ 没有抓到期初余额，现金只是期间变动，不是余额。");
limitations.push("资料来自汇出档，新鲜度取决于上次汇出（" + (months[months.length - 1] || "?") + "）。");
limitations.push("明细帐没有逐张单据的未清金额，所以催收清单只到客户层级，没有单据下钻。");
if (Math.abs(outBal) >= 1)
  limitations.push("⚠️ 借贷不平衡，差 " + outBal +
    " —— 通常是少给了某一份分类帐（General / Sales / Purchase 要三份都有），" +
    "或解析漏了。数字先不要用。");
out.limitations = limitations;

writeFileSync("dashboard-data.json", JSON.stringify({
  generatedAt: new Date().toISOString(),
  monthsCovered: MONTHS,
  months,
  companies: [out],
  source: "file-import",
}), "utf8");

console.log("\n写入 dashboard-data.json");
console.log("  月数 " + months.length + " · 科目 " + out.accs.length +
  " · 分录 " + out.txns.length.toLocaleString() +
  " · 现金 " + out.cash.toLocaleString() +
  " · 应收 " + out.ar.total.toLocaleString() + " · 应付 " + out.ap.total.toLocaleString());
console.log("\n口径说明:");
limitations.forEach((l) => console.log("  · " + l));
