// Collects the boss dashboard data from AutoCount Cloud and writes
// dashboard-data.json, in exactly the shape build-data.mjs produces, so that
// render-dashboard.mjs and headless-check.mjs work unchanged.
//
// ---------------------------------------------------------------------------
// HOW THIS DIFFERS FROM THE DIRECT-DATABASE PATH, AND WHY IT MATTERS
//
// build-data.mjs queries GLDTL - one table holding every posting AutoCount ever
// made, with the contra account on each line. The Cloud API has no equivalent:
// it exposes documents, not postings. There is no ledger endpoint.
//
// So the ledger here is REASSEMBLED from document detail lines. Verified
// against the reference tenant before this was written:
//
//   * /journalentry returns HAND-WRITTEN journals only. Sales invoice document
//     numbers do not appear among journal document numbers, so combining
//     journals with documents does not double-count. Confirm this with
//     cloud-probe.mjs on any new tenant before trusting these numbers - if a
//     tenant behaves differently, every revenue figure here doubles, and the
//     charts still draw.
//
//   * Revenue is taken as the net credit to accounts of AccType SL/OI, from
//     every source. This handles deferred revenue correctly without special
//     cases: fees billed into a liability account are simply not SL/OI, and the
//     journal that later releases them to revenue is picked up in the month it
//     was posted. On the reference books that matters - month-end cut-off
//     journals move six figures between adjacent months and reverse the next
//     day, and taking invoice totals as revenue would misstate every one of
//     those months.
//
// WHAT THIS RECONSTRUCTION IS NOT: a complete double-entry ledger. It carries
// the postings the dashboard measures - revenue, cost, cash movement, liability
// balances - not every tax and rounding line. Do not use it to prove a trial
// balance; use AutoCount's own reports for that.
//
// A CONTRA ACCOUNT IS AN INFERENCE HERE. GLDTL stores it per line; documents do
// not. For a two-line journal it is exact. For longer ones this takes the
// largest line on the opposite side, which is right for the common shapes and
// approximate for a genuinely multi-sided journal. Drill-downs are labelled
// from it, so treat it as a navigation aid, not evidence.
import {
  pageAll, request, assertFields, BOOKS, redact,
} from "../mcp-server/cloud-api.js";
import { profile, groupHints } from "./profile.mjs";
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const CACHE = resolve(HERE, "cloud-cache");
const REFRESH = process.argv.includes("--refresh");

const MONTHS = profile.months || 37;   // 3 years + current, enough for year-on-year

// EDIT THIS. One entry per live company book. "book" is the account book id.
// Check the latest transaction date per book before listing it - dormant and
// test books are common and they dilute every group total.
// Books come from profile.json when it lists them, otherwise from the credentials
// file, so a first run works before anyone has filled the profile in.
const COMPANIES = (profile.books && profile.books.length
  ? profile.books
  : BOOKS.map((id, i) => ({ id, short: "B" + (i + 1) }))
).map((b, i) => ({
  book: String(b.id),
  index: i,
  name: b.name || ("Book " + b.id),
  short: b.short || ("B" + (i + 1)),
  tier: b.tier || "active",
}));

// Names that suggest a counterparty inside the group. Flagged, never asserted.
// Empty by default: guessing at group membership from a name is worse than not
// flagging it at all.
const GROUP_HINTS = groupHints;

// Payment methods whose account is not a real bank or cash account (customer
// deposits, third-party wallets) are movements between ledgers, not cash flow.
// Overridable because it is a judgement call, not a fact.
const CASH_SPECIAL_TYPES = (process.env.ACCT_CLOUD_CASH_TYPES || "SBK,SCH").split(",");

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
};

// The amount that actually posts to the account on a document line.
//
// `localSubTotal` is NOT it. On a tax-inclusive line that figure contains the
// tax, which belongs to the tax control account and never reaches revenue or
// cost. On the reference books 53 of 601 invoice lines differ between the two,
// and `inclusiveTax` is not even returned by the listing endpoints - so there
// is no way to tell which lines are affected except by using the ex-tax field
// everywhere. Caught by cross-checking one month against AutoCount's own P&L:
// a credit note of 10,000 reduced revenue by 9,259.26, and the 740.74 gap was
// exactly its tax.
const lineAmount = (l) => num(l.localSubTotalExTax ?? l.localSubTotal);
const ym = (d) => String(d || "").slice(0, 7);
const day = (d) => String(d || "").slice(0, 10);
const daysBetween = (a, b) => Math.round((new Date(b) - new Date(a)) / 86400000);

const today = new Date();
const TODAY = today.toISOString().slice(0, 10);
const START = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - MONTHS + 1, 1))
  .toISOString().slice(0, 10);

// ------------------------------------------------------------------- fetching

// Raw responses are cached so a re-run during development does not re-hit live
// books, and so a failed later stage does not mean fetching everything again.
// The cache holds real ledger data; .gitignore excludes the folder.
async function cached(key, fn) {
  if (!existsSync(CACHE)) mkdirSync(CACHE, { recursive: true });
  const path = resolve(CACHE, key.replace(/[^A-Za-z0-9_.-]/g, "_") + ".json");
  if (!REFRESH && existsSync(path)) return JSON.parse(readFileSync(path, "utf8"));
  const data = await fn();
  writeFileSync(path, JSON.stringify(data), "utf8");
  return data;
}

const listing = (book, path, query, tag) =>
  cached(book + "_" + tag, async () =>
    (await pageAll("GET", path, { book, query, max: 400 })).rows);

// --------------------------------------------------------------- foldMonthly

// Folds [{key, ym, amt}] into [{acc, name, m:{ym:amt}, total}] - same shape the
// SQL path produces, because the page reads it directly.
function foldMonthly(rows, keyOf, extra) {
  const byKey = new Map();
  for (const r of rows) {
    const k = keyOf(r);
    let e = byKey.get(k);
    if (!e) { e = { m: {}, total: 0, ...extra(r) }; byKey.set(k, e); }
    const v = num(r.amt);
    if (v !== 0) { e.m[r.ym] = num((e.m[r.ym] || 0) + v); e.total = num(e.total + v); }
  }
  return [...byKey.values()]
    .filter((e) => Object.keys(e.m).length > 0)
    .sort((a, b) => Math.abs(b.total) - Math.abs(a.total));
}

// ------------------------------------------------------------- per company

async function collect(c) {
  const book = c.book;
  const out = { db: book, name: c.name, short: c.short, tier: c.tier };
  const limitations = [];

  // The book's own name beats a placeholder. Only the short code stays
  // configurable, because it is a label the user picks, not a fact in the data.
  const profile = await cached(book + "_profile", () =>
    request("GET", "/{book}/companyprofile", { book }));
  if (profile?.companyName) {
    out.name = profile.companyName;
    if (!(profile.books || [])[c.index]?.short) {
      // First word, minus the usual Malaysian company suffixes.
      out.short = profile.companyName
        .replace(/\b(SDN|BHD|BERHAD|PLT|ENTERPRISE)\b\.?/gi, "")
        .trim().split(/\s+/)[0].slice(0, 12) || c.short;
    }
  }

  // ---- reference data ------------------------------------------------------
  const ACC_FIELDS = ["AccNo", "Description", "AccType", "SpecialAccType"];
  const accounts = await cached(book + "_accounts", async () =>
    (await pageAll("POST", "/{book}/account/listing",
      { book, query: { field: ACC_FIELDS }, body: {}, max: 60 })).rows);
  assertFields(accounts, ACC_FIELDS, "account/listing");
  const CHART = new Map(accounts.map((a) => [a.AccNo, a]));
  const typeOf    = (a) => CHART.get(a)?.AccType || "?";
  const specialOf = (a) => CHART.get(a)?.SpecialAccType || "";
  const nameOf    = (a) => CHART.get(a)?.Description || a;
  const isBankAcc = (a) => CASH_SPECIAL_TYPES.includes(specialOf(a));
  // SA is Sales Adjustment - customer refunds and sales returns. AutoCount's own
  // P&L presents it inside the revenue section as a deduction, and a debit to an
  // SA account therefore reduces revenue here too. Verified against the vendor's
  // June statement: excluding SA overstated revenue by exactly the refund.
  const isRevenue = (a) => ["SL", "OI", "SA"].includes(typeOf(a));
  const isCost    = (a) => ["EP", "CO"].includes(typeOf(a));

  const payMethods = new Map(
    (await cached(book + "_paymethods", async () =>
      (await pageAll("GET", "/{book}/paymentmethod/listing", { book, max: 20 })).rows))
      .map((p) => [p.paymentMethod, p]));

  const debtors = await cached(book + "_debtors", async () =>
    (await pageAll("GET", "/{book}/debtor/listing",
      { book, query: { field: ["AccNo", "CompanyName"] }, max: 200 })).rows);
  const debtorName = new Map(debtors.map((d) => [d.AccNo, d.CompanyName]));
  const creditors = await cached(book + "_creditors", async () =>
    (await pageAll("GET", "/{book}/creditor/listing",
      { book, query: { field: ["AccNo", "CompanyName"] }, max: 200 })).rows);
  const creditorName = new Map(creditors.map((d) => [d.AccNo, d.CompanyName]));

  // ---- documents -----------------------------------------------------------
  const range = { startDate: START, endDate: TODAY };
  const live = (rows) => rows.filter((r) => !(r.master ?? r).cancelled);

  const invoices  = live(await listing(book, "/{book}/invoice/listing",         range, "inv"));
  const purchases = live(await listing(book, "/{book}/purchaseinvoice/listing", range, "pinv"));
  const cnotes    = live(await listing(book, "/{book}/creditnote/listing",      range, "cn"));
  const payments  = live(await listing(book, "/{book}/payment/listing",         range, "pay"));
  const journals  = live(await listing(book, "/{book}/journalentry/listing",    range, "je"));

  // Whether a department/project code is actually filled in on transactions
  // decides if profit-by-department is possible at all. Measured, not assumed -
  // a suggestion engine that asserts "not available" without counting is just a
  // hard-coded opinion.
  {
    const lines = [
      ...invoices.flatMap((d) => d.details || []),
      ...purchases.flatMap((d) => d.details || []),
      ...cnotes.flatMap((d) => d.details || []),
      ...payments.flatMap((d) => d.details || []),
      ...journals.flatMap((d) => d.details || []),
    ];
    const filled = lines.filter((l) => l && l.deptNo).length;
    out.deptCoverage = { lines: lines.length, filled,
                         share: lines.length ? filled / lines.length : 0 };
  }

  out.sourceCounts = {
    invoices: invoices.length, purchaseInvoices: purchases.length,
    creditNotes: cnotes.length, payments: payments.length, journals: journals.length,
  };

  // ---- the reassembled ledger ---------------------------------------------
  // { dt, ym, acc, dr, cr, contra, ref, ds, jt }
  const gl = [];
  const post = (dt, acc, dr, cr, contra, ref, ds, jt) => {
    if (!acc || (num(dr) === 0 && num(cr) === 0)) return;
    gl.push({ dt: day(dt), ym: ym(dt), acc, dr: num(dr), cr: num(cr),
              contra: contra || "", ref: ref || "", ds: String(ds || "").slice(0, 70), jt });
  };

  // Sales invoices: each line credits the account it was coded to, facing the
  // customer. A line coded to a liability (deferred fees, a levy collected on
  // someone else's behalf) is therefore NOT revenue, which is the correct
  // treatment and needs no special case.
  for (const d of invoices) {
    const m = d.master;
    for (const l of d.details || [])
      post(m.docDate, l.accNo, 0, lineAmount(l), m.debtorCode, m.docNo,
           l.description || m.description, "SA");
  }
  // Purchase invoices: cost side debits, facing the supplier.
  for (const d of purchases) {
    const m = d.master;
    for (const l of d.details || [])
      post(m.docDate, l.accNo, lineAmount(l), 0, m.creditorCode, m.docNo,
           l.description || m.description, "PU");
  }
  // Credit notes reduce what was billed, so they reverse the invoice side.
  for (const d of cnotes) {
    const m = d.master;
    for (const l of d.details || [])
      post(m.docDate, l.accNo, lineAmount(l), 0, m.debtorCode, m.docNo,
           l.description || m.description, "CN");
  }
  // Cash book entries have two sides in different arrays: paymentDetails holds
  // the bank (via the payment method), details holds what the money was for.
  // docType OR is money in, PV is money out.
  for (const d of payments) {
    const m = d.master;
    const inflow = m.docType === "OR";
    const banks = (d.paymentDetails || []).map((p) => ({
      acc: payMethods.get(p.paymentMethod)?.bankAccount,
      amt: num(p.localPaymentAmt),
    })).filter((b) => b.acc);
    const lines = (d.details || []);
    const mainContra = lines.length
      ? lines.slice().sort((a, b) => Math.abs(num(b.localAmount)) - Math.abs(num(a.localAmount)))[0].accNo
      : "";
    const mainBank = banks.length ? banks[0].acc : "";
    for (const b of banks)
      post(m.docDate, b.acc, inflow ? b.amt : 0, inflow ? 0 : b.amt,
           mainContra, m.docNo, m.description || m.dealWith, "CB");
    for (const l of lines)
      post(m.docDate, l.accNo, inflow ? 0 : l.localAmount, inflow ? l.localAmount : 0,
           mainBank, m.docNo, l.description || m.description, "CB");
  }
  // Journals carry their own debits and credits. The contra is inferred - see
  // the note at the top of this file.
  for (const d of journals) {
    const m = d.master;
    const lines = d.details || [];
    const biggestOn = (wantDebitSide) => {
      const side = lines.filter((l) => wantDebitSide ? num(l.localDR) > 0 : num(l.localCR) > 0);
      return side.sort((a, b) =>
        Math.abs(num(b.localDR) + num(b.localCR)) - Math.abs(num(a.localDR) + num(a.localCR))
      )[0]?.accNo || "";
    };
    const contraForCredit = biggestOn(true);    // a credit faces the biggest debit
    const contraForDebit  = biggestOn(false);
    for (const l of lines) {
      const dr = num(l.localDR), cr = num(l.localCR);
      post(m.docDate, l.accNo, dr, cr, dr > 0 ? contraForDebit : contraForCredit,
           m.docNo, l.description || m.description, m.journalType || "GL");
    }
  }
  out.glPostings = gl.length;

  // ---- monthly profit and loss --------------------------------------------
  const pnl = new Map();
  for (const p of gl) {
    if (!isRevenue(p.acc) && !isCost(p.acc)) continue;
    const e = pnl.get(p.ym) || { rev: 0, cost: 0 };
    if (isRevenue(p.acc)) e.rev  = num(e.rev  + (p.cr - p.dr));
    else                  e.cost = num(e.cost + (p.dr - p.cr));
    pnl.set(p.ym, e);
  }
  out.pnlByMonth = [...pnl.entries()].sort()
    .map(([m, v]) => ({ ym: m, rev: v.rev, cost: v.cost, profit: num(v.rev - v.cost) }));

  // ---- monthly billings ----------------------------------------------------
  const bill = new Map();
  for (const d of invoices) {
    const m = d.master, k = ym(m.docDate);
    const e = bill.get(k) || { amt: 0, docs: 0 };
    e.amt = num(e.amt + num(m.localNetTotal)); e.docs++;
    bill.set(k, e);
  }
  out.billingsByMonth = [...bill.entries()].sort()
    .map(([m, v]) => ({ ym: m, amt: v.amt, docs: v.docs }));

  // ---- revenue and expenses by account, month by month --------------------
  const glFold = (test, sign) => foldMonthly(
    gl.filter((p) => test(p.acc)).map((p) => ({
      acc: p.acc, ym: p.ym, amt: sign === 1 ? p.cr - p.dr : p.dr - p.cr })),
    (r) => r.acc,
    (r) => ({ acc: r.acc, name: nameOf(r.acc), type: typeOf(r.acc) }));
  out.revenueAccounts = glFold(isRevenue, 1);
  out.expenses        = glFold(isCost, -1);

  // ---- service lines: invoice lines by the account they were coded to ------
  out.serviceLines = foldMonthly(
    invoices.flatMap((d) => (d.details || []).map((l) => ({
      acc: l.accNo, ym: ym(d.master.docDate), amt: num(l.localSubTotal) }))),
    (r) => r.acc,
    (r) => ({
      acc: r.acc, name: nameOf(r.acc), type: typeOf(r.acc) || "?",
      deferred: typeOf(r.acc) === "CL",                          // billed into a liability
      recharge: ["EP", "CO"].includes(typeOf(r.acc)),            // a cost passed on
    }));

  // Billings and revenue will not tie whenever invoice lines are coded to
  // liability accounts. That is a real feature of these books, not an error, so
  // it is measured and reported rather than hidden.
  const billedToLiability = out.serviceLines.filter((s) => s.deferred)
    .reduce((s, x) => num(s + x.total), 0);
  if (billedToLiability !== 0) {
    limitations.push(
      "Billings exceed revenue by " + billedToLiability.toLocaleString() +
      " over the period: invoice lines coded to liability accounts (" +
      out.serviceLines.filter((s) => s.deferred).map((s) => s.acc + " " + s.name).join(", ") +
      "). These are not revenue and are excluded from the P&L.");
  }

  // ---- customer billings, month by month ----------------------------------
  out.customers = foldMonthly(
    invoices.map((d) => ({
      cust: debtorName.get(d.master.debtorCode) || d.master.debtorName || d.master.debtorCode,
      ym: ym(d.master.docDate), amt: num(d.master.localNetTotal) })),
    (r) => r.cust,
    (r) => ({ name: r.cust || "(未命名)",
              group: GROUP_HINTS.some((h) => String(r.cust || "").toUpperCase().includes(h)) }));

  // ---- CASH FLOW -----------------------------------------------------------
  // Every movement on a bank or cash account, by month and by what it faced.
  // Stored as dictionaries plus index rows: repeating account names on every
  // row makes the page too heavy to open on a phone.
  const cfMap = new Map();
  for (const p of gl) {
    if (!isBankAcc(p.acc)) continue;
    const k = p.acc + "|" + p.ym + "|" + p.contra;
    const e = cfMap.get(k) || { bank: p.acc, ym: p.ym, contra: p.contra, in: 0, out: 0, n: 0 };
    e.in = num(e.in + p.dr); e.out = num(e.out + p.cr); e.n++;
    cfMap.set(k, e);
  }
  const bankIx = new Map(), contraIx = new Map();
  out.cfBanks = []; out.cfContra = []; out.cashFlow = [];
  for (const r of cfMap.values()) {
    if (r.in === 0 && r.out === 0) continue;
    if (!bankIx.has(r.bank)) {
      bankIx.set(r.bank, out.cfBanks.length);
      out.cfBanks.push({ a: r.bank, n: nameOf(r.bank) });
    }
    if (!contraIx.has(r.contra)) {
      contraIx.set(r.contra, out.cfContra.length);
      out.cfContra.push({
        a: r.contra, n: r.contra ? nameOf(r.contra) : "(无对方科目)",
        t: r.contra ? typeOf(r.contra) : "?",
        // The other side is itself bank or cash, so this is money shuffled
        // between the company's own accounts, not cash flow.
        x: isBankAcc(r.contra) ? 1 : 0,
      });
    }
    out.cashFlow.push([bankIx.get(r.bank), r.ym, contraIx.get(r.contra), r.in, r.out, r.n]);
  }

  // ---- bank and cash balances ---------------------------------------------
  // The API exposes no account balance - the only balance endpoint in the whole
  // spec is product/balancequantity, which is stock, not money. So a balance can
  // only be accumulated from postings, and that is valid ONLY if the fetch
  // window starts before the book's very first transaction. Otherwise the total
  // is short by whatever was carried into START, and a figure that is wrong by
  // an unknown amount is worse than no figure, because it looks like a balance.
  //
  // So the window is checked rather than assumed. On the reference book the
  // first document of any kind is JV-000001 (Paid Up Capital, 2025-01-25) and
  // the fetch starts well before it, so the opening balance is genuinely zero
  // and the accumulation is a real position rather than a movement.
  const firstDocDate = [...invoices, ...purchases, ...cnotes, ...payments, ...journals]
    .map((d) => day(d.master.docDate)).filter(Boolean).sort()[0];
  const windowCoversInception = Boolean(firstDocDate) && firstDocDate > START;
  const bankMovement = out.cashFlow.reduce((s, r) => num(s + r[3] - r[4]), 0);

  if (windowCoversInception) {
    const balances = new Map();
    for (const p of gl) {
      if (!isBankAcc(p.acc)) continue;
      balances.set(p.acc, num((balances.get(p.acc) || 0) + p.dr - p.cr));
    }
    out.cashAccounts = [...balances.entries()]
      .filter(([, bal]) => bal !== 0)
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([acc, bal]) => ({ acc, name: nameOf(acc), kind: specialOf(acc), bal }));
    out.cash = num(out.cashAccounts.reduce((s, r) => s + r.bal, 0));
    limitations.push(
      "Cash balances are accumulated from every posting since the book opened " +
      "(first document " + firstDocDate + ", fetch starts " + START + ", so there " +
      "is no brought-forward balance to miss). They are NOT read from the API - it " +
      "exposes no account balance - so check them against AutoCount's own trial " +
      "balance before relying on them.");
  } else {
    // Documents exist at the very edge of the window, so something was carried in
    // from before it and the accumulation would be short by an unknown amount.
    out.cashAccounts = [];
    out.cash = 0;
    limitations.push(
      "Cash balances unavailable: the fetch window starts " + START + " but the book " +
      "already had documents by then, so an unknown balance was carried in. Net bank " +
      "movement over the period is " + bankMovement.toLocaleString() + ", which is a " +
      "change, not a position. Widen MONTHS to cover the book's opening date.");
  }

  // ---- positions as at today ----------------------------------------------
  // Aged from DUE DATE. Ageing from document date is a standard way to produce
  // a confidently wrong ageing - it shifts everything by one credit term.
  // An invoice due today is not yet overdue, so bucket 0 is `daysLate <= 0`.
  const bucket = (late) => late <= 0 ? "notDue" : late <= 30 ? "d30"
                 : late <= 60 ? "d60" : late <= 90 ? "d90" : "over90";
  const ageDocs = (docs, dueOf, outOf) => {
    const b = { notDue: 0, d30: 0, d60: 0, d90: 0, over90: 0 };
    for (const d of docs) {
      const o = num(outOf(d));
      if (o <= 0) continue;
      b[bucket(daysBetween(dueOf(d), TODAY))] = num(b[bucket(daysBetween(dueOf(d), TODAY))] + o);
    }
    b.total = num(["notDue", "d30", "d60", "d90", "over90"].reduce((s, k) => s + b[k], 0));
    b.overdue = num(b.d30 + b.d60 + b.d90 + b.over90);
    return b;
  };
  const invM = invoices.map((d) => d.master);
  const pinvM = purchases.map((d) => d.master);
  out.ar = ageDocs(invM, (m) => m.dueDate, (m) => m.outstandingAmount);
  out.ap = ageDocs(pinvM, (m) => m.dueDate, (m) => m.outstandingAmount);
  if (!pinvM.length) {
    limitations.push(
      "No purchase invoices in the period - costs appear to be recorded directly " +
      "on payments. AP ageing is therefore empty, which reflects the bookkeeping, " +
      "not a missing figure.");
  }
  // Open invoices dated before START are outside the window and cannot be seen.
  limitations.push(
    "Ageing covers invoices dated " + START + " onward. Anything still open from " +
    "before that date is not counted.");

  const owingBy = new Map();
  for (const m of invM) {
    const o = num(m.outstandingAmount);
    if (o <= 0) continue;
    const key = m.debtorCode;
    const e = owingBy.get(key) || { acc: key, docs: 0, owing: 0, oldestLate: -1e9 };
    e.docs++; e.owing = num(e.owing + o);
    e.oldestLate = Math.max(e.oldestLate, daysBetween(m.dueDate, TODAY));
    owingBy.set(key, e);
  }
  out.topDebtors = [...owingBy.values()]
    .sort((a, b) => b.owing - a.owing).slice(0, 10)
    .map((e) => {
      const name = debtorName.get(e.acc) || e.acc;
      return { name, acc: e.acc, docs: e.docs, owing: e.owing,
               oldestLate: e.oldestLate, limit: 0, overLimit: false,
               group: GROUP_HINTS.some((h) => name.toUpperCase().includes(h)) };
    });

  const owingTo = new Map();
  for (const m of pinvM) {
    const o = num(m.outstandingAmount);
    if (o <= 0) continue;
    const name = creditorName.get(m.creditorCode) || m.creditorCode || "(未命名)";
    const e = owingTo.get(name) || { name, docs: 0, owing: 0, late: -1e9 };
    e.docs++; e.owing = num(e.owing + o);
    e.late = Math.max(e.late, daysBetween(m.dueDate, TODAY));
    owingTo.set(name, e);
  }
  out.topCreditors = [...owingTo.values()].sort((a, b) => b.owing - a.owing).slice(0, 15);

  out.openInvoices = invM
    .filter((m) => num(m.outstandingAmount) > 0)
    .sort((a, b) => num(b.outstandingAmount) - num(a.outstandingAmount)).slice(0, 60)
    .map((m) => ({
      doc: m.docNo, cust: debtorName.get(m.debtorCode) || m.debtorCode || "",
      date: day(m.docDate), due: day(m.dueDate),
      total: num(m.localNetTotal), amt: num(m.outstandingAmount),
      late: daysBetween(m.dueDate, TODAY),
    }));

  // Liability balances, same caveat as cash: movement over the window, not a
  // balance. Reported as movement and labelled in `limitations`.
  const liab = new Map();
  for (const p of gl) {
    if (typeOf(p.acc) !== "CL") continue;
    liab.set(p.acc, num((liab.get(p.acc) || 0) + p.cr - p.dr));
  }
  out.liabilities = [...liab.entries()]
    .filter(([, v]) => v !== 0)
    .sort((a, b) => b[1] - a[1])
    .map(([acc, bal]) => ({
      acc, name: nameOf(acc), special: specialOf(acc), bal,
      isControl: specialOf(acc) === "SCR",
      isDeferred: /UNRECOGNISED|UNEARNED|DEFERRED|DEPOSIT|ADVANCE/i.test(nameOf(acc)),
    }));
  limitations.push(windowCoversInception
    ? "Liability figures are accumulated from the book's opening, so they are "
      + "balances - but check them against AutoCount's trial balance, same as cash."
    : "Liability figures are movement since " + START + ", not balances.");

  // ---- TRANSACTION DETAIL --------------------------------------------------
  const accIx = new Map(); out.accs = [];
  const acc = (a) => {
    if (!a) return -1;
    if (!accIx.has(a)) { accIx.set(a, out.accs.length); out.accs.push({ a, n: nameOf(a), t: typeOf(a) }); }
    return accIx.get(a);
  };
  const partyIx = new Map(); out.parties = [];
  const party = (n) => {
    const k = n || "(未命名)";
    if (!partyIx.has(k)) { partyIx.set(k, out.parties.length); out.parties.push(k); }
    return partyIx.get(k);
  };

  // Kinds are mutually exclusive: revenue, expense, liability or cash.
  out.txns = gl
    .filter((p) => isRevenue(p.acc) || isCost(p.acc) || typeOf(p.acc) === "CL" || isBankAcc(p.acc))
    .sort((a, b) => (a.dt < b.dt ? 1 : a.dt > b.dt ? -1 : 0))
    .map((p) => {
      let kind, amt;
      if (isBankAcc(p.acc))        { kind = "C"; amt = num(p.dr - p.cr); }
      else if (isRevenue(p.acc))   { kind = "R"; amt = num(p.cr - p.dr); }
      else if (typeOf(p.acc) === "CL") { kind = "L"; amt = num(p.cr - p.dr); }
      else                         { kind = "E"; amt = num(p.dr - p.cr); }
      // [date, ref, description, account, contra, amount, kind, journal type]
      return [p.dt, p.ref, p.ds, acc(p.acc), acc(p.contra), amt, kind, p.jt];
    })
    .filter((t) => t[5] !== 0);

  out.arDocs = invM
    .sort((a, b) => (a.docDate < b.docDate ? 1 : -1))
    .map((m) => [day(m.docDate), m.docNo, party(debtorName.get(m.debtorCode) || m.debtorCode),
                 day(m.dueDate), num(m.localNetTotal), num(m.outstandingAmount),
                 daysBetween(m.dueDate, TODAY), String(m.description || "").slice(0, 70)]);

  out.apDocs = pinvM
    .sort((a, b) => (a.docDate < b.docDate ? 1 : -1))
    .map((m) => [day(m.docDate), m.docNo, party(creditorName.get(m.creditorCode) || m.creditorCode),
                 day(m.dueDate), num(m.localNetTotal), num(m.outstandingAmount),
                 daysBetween(m.dueDate, TODAY), String(m.supplierInvoiceNo || "").slice(0, 70)]);

  out.slDocs = invoices.flatMap((d) =>
    (d.details || []).map((l) => [
      day(d.master.docDate), d.master.docNo, acc(l.accNo),
      party(debtorName.get(d.master.debtorCode) || d.master.debtorCode),
      String(l.description || "").slice(0, 70), lineAmount(l)]))
    .sort((a, b) => (a[0] < b[0] ? 1 : -1));

  out.limitations = limitations;
  return out;
}

// ------------------------------------------------------------------- assemble

if (!COMPANIES.length) {
  console.error("No account books. Set ACCT_CLOUD_BOOKS in assets/mcp-server/.env");
  process.exit(2);
}

const companies = [];
for (const c of COMPANIES) {
  process.stdout.write("  " + String(c.book).padEnd(12));
  try {
    const r = await collect(c);
    companies.push(r);
    console.log("分录 " + String(r.glPostings).padStart(6) +
                " | 月数 " + String(r.pnlByMonth.length).padStart(3) +
                " | 现金流列 " + String(r.cashFlow.length).padStart(5) +
                " | AR " + String(r.arDocs.length).padStart(5) +
                " | 未清 " + Math.round(r.ar.total).toLocaleString().padStart(10));
  } catch (e) {
    const msg = redact(String(e && e.message || e));
    console.log("FAILED - " + msg.slice(0, 110));
    companies.push({ db: c.book, name: c.name, short: c.short, tier: c.tier,
                     failed: msg.slice(0, 200) });
  }
}

const ok = companies.filter((c) => !c.failed);
const allMonths = [...new Set(ok.flatMap((c) => c.pnlByMonth.map((m) => m.ym)))].sort();

writeFileSync("dashboard-data.json", JSON.stringify({
  generatedAt: new Date().toISOString(),
  monthsCovered: MONTHS,
  months: allMonths,
  companies,
  source: "autocount-cloud-api",
}), "utf8");

console.log("\nWrote dashboard-data.json  (" + ok.length + "/" + companies.length +
  " companies, " + allMonths.length + " months: " + allMonths[0] + " → " +
  allMonths[allMonths.length - 1] + ")");
for (const c of ok) {
  if (!c.limitations?.length) continue;
  console.log("\n" + c.short + " 的口径说明:");
  for (const l of c.limitations) console.log("  · " + l);
}
