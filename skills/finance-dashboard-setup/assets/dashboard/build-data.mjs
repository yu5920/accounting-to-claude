// Collects the boss dashboard data from every active AutoCount company and
// writes dashboard-data.json.
//
// Everything that varies over time is stored MONTH BY MONTH, so the dashboard
// can total any date range and compare periods without going back to SQL.
// Positions (ageing, balances, open invoices) are as-at-today by nature and are
// labelled as such in the UI.
//
// Conventions verified against a live AutoCount 2.x book:
//   GLDTL is double-entry: HomeDR / HomeCR. Revenue is a credit, cost a debit.
//   GLDTL.DEAccNo holds the contra account, and is always populated.
//   Bank and cash accounts are GLMast.SpecialAccType 'SBK' / 'SCH'.
//   Cancelled invoices keep their Outstanding value, so must be filtered out.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// The MCP server sits next door in the skill layout. Override with ACCT_SERVER
// if you copied the two folders somewhere else.
const SERVER = process.env.ACCT_SERVER ||
  resolve(dirname(fileURLToPath(import.meta.url)), "..", "mcp-server", "index.js");

const MONTHS = 37;   // 3 years + current, enough for a year-on-year comparison

// EDIT THIS. One entry per live company book. "db" is what list_companies
// returned, "short" is the label the dashboard shows and the key project-map.json
// uses. Set tier to "active" or "quiet" - quiet books still appear but are not
// counted in group headline figures.
//
// Check the latest transaction date per book before listing it. Dormant and test
// books are common and they dilute every group total.
const COMPANIES = [
  { db: "AED_COMPANY1", name: "Company One", short: "CO1", tier: "active" },
  { db: "AED_COMPANY2", name: "Company Two", short: "CO2", tier: "quiet"  },
];

// Names that suggest a counterparty inside the group. Flagged, never asserted.
const GROUP_HINTS = [
  "COMPANY", "GROUP",
];

const client = new Client({ name: "build", version: "1.0.0" }, { capabilities: {} });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [SERVER] }));

async function q(db, sql, maxRows) {
  const args = { database: db, sql };
  if (maxRows) args.max_rows = maxRows;
  const r = await client.callTool({ name: "query", arguments: args });
  const text = r.content.map((c) => c.text).join("\n");
  if (r.isError) throw new Error(db + ": " + text.split("\n").slice(0, 3).join(" "));
  const i = text.indexOf("[");
  return i === -1 ? [] : JSON.parse(text.slice(i));
}

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
};
const SINCE = `DATEADD(month, -${MONTHS}, GETDATE())`;

// Folds [{Acc,Ym,Amt}] into [{acc, name, m:{ym:amt}, total}].
function foldMonthly(rows, keyField, extra) {
  const byKey = new Map();
  for (const r of rows) {
    const k = r[keyField];
    let e = byKey.get(k);
    if (!e) {
      e = { m: {}, total: 0, ...extra(r) };
      byKey.set(k, e);
    }
    const v = num(r.Amt);
    if (v !== 0) { e.m[r.Ym] = v; e.total += v; }
  }
  return [...byKey.values()]
    .filter((e) => Object.keys(e.m).length > 0)
    .sort((a, b) => Math.abs(b.total) - Math.abs(a.total));
}

// ---------------------------------------------------------------- per company

async function collect(c) {
  const db = c.db;
  const out = { ...c };

  // ---- monthly profit and loss
  out.pnlByMonth = (await q(db, `
    SELECT CONVERT(char(7), d.TransDate, 120) AS Ym,
           SUM(CASE WHEN g.AccType IN ('SL','OI') THEN d.HomeCR - d.HomeDR ELSE 0 END) AS Rev,
           SUM(CASE WHEN g.AccType IN ('EP','CO') THEN d.HomeDR - d.HomeCR ELSE 0 END) AS Cost
      FROM GLDTL d JOIN GLMast g ON g.AccNo = d.AccNo
     WHERE d.TransDate >= ${SINCE} AND g.AccType IN ('SL','OI','EP','CO')
     GROUP BY CONVERT(char(7), d.TransDate, 120)
     ORDER BY CONVERT(char(7), d.TransDate, 120)`))
    .map((r) => ({ ym: r.Ym, rev: num(r.Rev), cost: num(r.Cost),
                   profit: num(num(r.Rev) - num(r.Cost)) }));

  // ---- monthly billings
  out.billingsByMonth = (await q(db, `
    SELECT CONVERT(char(7), DocDate, 120) AS Ym,
           SUM(LocalNetTotal) AS Amt, COUNT(*) AS Docs
      FROM ARInvoice
     WHERE Cancelled = 'F' AND DocDate >= ${SINCE}
     GROUP BY CONVERT(char(7), DocDate, 120)
     ORDER BY CONVERT(char(7), DocDate, 120)`))
    .map((r) => ({ ym: r.Ym, amt: num(r.Amt), docs: num(r.Docs) }));

  // ---- revenue by account, month by month
  out.revenueAccounts = foldMonthly(await q(db, `
    SELECT g.AccNo AS Acc, g.Description AS Nm, g.AccType AS Typ,
           CONVERT(char(7), d.TransDate, 120) AS Ym,
           SUM(d.HomeCR - d.HomeDR) AS Amt
      FROM GLDTL d JOIN GLMast g ON g.AccNo = d.AccNo
     WHERE g.AccType IN ('SL','OI') AND d.TransDate >= ${SINCE}
     GROUP BY g.AccNo, g.Description, g.AccType, CONVERT(char(7), d.TransDate, 120)`),
    "Acc", (r) => ({ acc: r.Acc, name: r.Nm || r.Acc, type: r.Typ }));

  // ---- expenses by account, month by month
  out.expenses = foldMonthly(await q(db, `
    SELECT g.AccNo AS Acc, g.Description AS Nm, g.AccType AS Typ,
           CONVERT(char(7), d.TransDate, 120) AS Ym,
           SUM(d.HomeDR - d.HomeCR) AS Amt
      FROM GLDTL d JOIN GLMast g ON g.AccNo = d.AccNo
     WHERE g.AccType IN ('EP','CO') AND d.TransDate >= ${SINCE}
     GROUP BY g.AccNo, g.Description, g.AccType, CONVERT(char(7), d.TransDate, 120)`),
    "Acc", (r) => ({ acc: r.Acc, name: r.Nm || r.Acc, type: r.Typ }));

  // ---- service lines: invoice lines by the account they were coded to
  out.serviceLines = foldMonthly(await q(db, `
    SELECT d.AccNo AS Acc, g.Description AS Nm, g.AccType AS Typ,
           CONVERT(char(7), i.DocDate, 120) AS Ym,
           SUM(d.LocalNetAmount) AS Amt
      FROM ARInvoiceDTL d
      JOIN ARInvoice i ON i.DocKey = d.DocKey
      LEFT JOIN GLMast g ON g.AccNo = d.AccNo
     WHERE i.Cancelled = 'F' AND i.DocDate >= ${SINCE}
     GROUP BY d.AccNo, g.Description, g.AccType, CONVERT(char(7), i.DocDate, 120)`),
    "Acc", (r) => ({
      acc: r.Acc, name: r.Nm || r.Acc, type: r.Typ || "?",
      deferred: r.Typ === "CL",                       // billed into a liability
      recharge: r.Typ === "EP" || r.Typ === "CO",     // a cost passed to the customer
    }));

  // ---- customer billings, month by month
  out.customers = foldMonthly(await q(db, `
    SELECT dr.CompanyName AS Cust, CONVERT(char(7), i.DocDate, 120) AS Ym,
           SUM(i.LocalNetTotal) AS Amt
      FROM ARInvoice i JOIN Debtor dr ON dr.AccNo = i.DebtorCode
     WHERE i.Cancelled = 'F' AND i.DocDate >= ${SINCE}
     GROUP BY dr.CompanyName, CONVERT(char(7), i.DocDate, 120)`),
    "Cust", (r) => ({
      name: r.Cust || "(未命名)",
      group: GROUP_HINTS.some((h) => String(r.Cust || "").toUpperCase().includes(h)),
    }));

  // ---- CASH FLOW: every bank movement, by month and by what it faced.
  //      DEAccNo is the contra account, so it says where the money came from
  //      or went to. Debit into the bank is an inflow, credit is an outflow.
  const cf = await q(db, `
    SELECT d.AccNo AS Bank, bk.Description AS BankNm,
           CONVERT(char(7), d.TransDate, 120) AS Ym,
           d.DEAccNo AS Contra, ce.Description AS ContraNm,
           ISNULL(ce.AccType, '?') AS ContraTyp,
           ISNULL(ce.SpecialAccType, '') AS ContraSp,
           SUM(d.HomeDR) AS Inflow, SUM(d.HomeCR) AS Outflow, COUNT(*) AS Lines
      FROM GLDTL d
      JOIN GLMast bk ON bk.AccNo = d.AccNo
      LEFT JOIN GLMast ce ON ce.AccNo = d.DEAccNo
     WHERE bk.SpecialAccType IN ('SBK','SCH') AND d.TransDate >= ${SINCE}
     GROUP BY d.AccNo, bk.Description, CONVERT(char(7), d.TransDate, 120),
              d.DEAccNo, ce.Description, ce.AccType, ce.SpecialAccType`);
  // Stored as dictionaries plus index rows. Repeating the account names on
  // every row roughly quadrupled the file, which made the page too heavy to
  // open on a phone.
  const bankIx = new Map();
  const contraIx = new Map();
  out.cfBanks = [];
  out.cfContra = [];
  out.cashFlow = [];
  for (const r of cf) {
    const inAmt = num(r.Inflow), outAmt = num(r.Outflow);
    if (inAmt === 0 && outAmt === 0) continue;

    if (!bankIx.has(r.Bank)) {
      bankIx.set(r.Bank, out.cfBanks.length);
      out.cfBanks.push({ a: r.Bank, n: r.BankNm || r.Bank });
    }
    const ck = r.Contra || "";
    if (!contraIx.has(ck)) {
      contraIx.set(ck, out.cfContra.length);
      out.cfContra.push({
        a: ck, n: r.ContraNm || ck || "(无对方科目)", t: r.ContraTyp,
        // The other side is itself a bank or cash account, so this movement is
        // money shuffled between the group's own accounts, not real cash flow.
        x: ["SBK", "SCH"].includes(r.ContraSp) ? 1 : 0,
      });
    }
    // [bank, month, contra, inflow, outflow, line count]
    out.cashFlow.push([bankIx.get(r.Bank), r.Ym, contraIx.get(ck), inAmt, outAmt, num(r.Lines)]);
  }

  // ---- bank and cash balances as at today
  out.cashAccounts = (await q(db, `
    SELECT g.AccNo AS Acc, g.Description AS Nm, g.SpecialAccType AS Kind,
           SUM(ISNULL(d.HomeDR,0) - ISNULL(d.HomeCR,0)) AS Bal
      FROM GLMast g LEFT JOIN GLDTL d ON d.AccNo = g.AccNo
     WHERE g.SpecialAccType IN ('SBK','SCH')
     GROUP BY g.AccNo, g.Description, g.SpecialAccType
     ORDER BY g.AccNo`))
    .map((r) => ({ acc: r.Acc, name: r.Nm, kind: r.Kind, bal: num(r.Bal) }))
    .filter((r) => r.bal !== 0);
  out.cash = num(out.cashAccounts.reduce((s, r) => s + r.bal, 0));

  // ---- positions as at today (a date filter cannot move these)
  const agingSql = (table) => `
    SELECT CASE WHEN DATEDIFF(day, DueDate, GETDATE()) <= 0  THEN '0'
                WHEN DATEDIFF(day, DueDate, GETDATE()) <= 30 THEN '1'
                WHEN DATEDIFF(day, DueDate, GETDATE()) <= 60 THEN '2'
                WHEN DATEDIFF(day, DueDate, GETDATE()) <= 90 THEN '3'
                ELSE '4' END AS Bucket,
           COUNT(*) AS Docs, SUM(Outstanding) AS Amt
      FROM ${table}
     WHERE Cancelled = 'F' AND Outstanding > 0
     GROUP BY CASE WHEN DATEDIFF(day, DueDate, GETDATE()) <= 0  THEN '0'
                   WHEN DATEDIFF(day, DueDate, GETDATE()) <= 30 THEN '1'
                   WHEN DATEDIFF(day, DueDate, GETDATE()) <= 60 THEN '2'
                   WHEN DATEDIFF(day, DueDate, GETDATE()) <= 90 THEN '3'
                   ELSE '4' END`;
  const mapAging = (rows) => {
    const keys = ["notDue", "d30", "d60", "d90", "over90"];
    const b = { notDue: 0, d30: 0, d60: 0, d90: 0, over90: 0 };
    rows.forEach((r) => { b[keys[Number(r.Bucket)]] = num(r.Amt); });
    b.total = num(keys.reduce((s, k) => s + b[k], 0));
    b.overdue = num(b.d30 + b.d60 + b.d90 + b.over90);
    return b;
  };
  out.ar = mapAging(await q(db, agingSql("ARInvoice")));
  out.ap = mapAging(await q(db, agingSql("APInvoice")));

  out.topDebtors = (await q(db, `
    SELECT TOP 10 dr.CompanyName AS Nm, dr.AccNo AS Acc, COUNT(*) AS Docs,
           SUM(i.Outstanding) AS Owing,
           MAX(DATEDIFF(day, i.DueDate, GETDATE())) AS OldestLate,
           MAX(dr.CreditLimit) AS Lim
      FROM ARInvoice i JOIN Debtor dr ON dr.AccNo = i.DebtorCode
     WHERE i.Cancelled = 'F' AND i.Outstanding > 0
     GROUP BY dr.CompanyName, dr.AccNo
     ORDER BY SUM(i.Outstanding) DESC`))
    .map((r) => {
      const name = r.Nm || r.Acc, owing = num(r.Owing), lim = num(r.Lim);
      return { name, acc: r.Acc, docs: num(r.Docs), owing,
               oldestLate: num(r.OldestLate), limit: lim,
               overLimit: lim > 0 && owing > lim,
               group: GROUP_HINTS.some((h) => name.toUpperCase().includes(h)) };
    });

  out.topCreditors = (await q(db, `
    SELECT TOP 15 cr.CompanyName AS Sup, COUNT(*) AS Docs,
           SUM(i.Outstanding) AS Owing, MAX(DATEDIFF(day, i.DueDate, GETDATE())) AS Late
      FROM APInvoice i JOIN Creditor cr ON cr.AccNo = i.CreditorCode
     WHERE i.Cancelled = 'F' AND i.Outstanding > 0
     GROUP BY cr.CompanyName
     ORDER BY SUM(i.Outstanding) DESC`))
    .map((r) => ({ name: r.Sup || "(未命名)", docs: num(r.Docs),
                   owing: num(r.Owing), late: num(r.Late) }));

  out.openInvoices = (await q(db, `
    SELECT TOP 60 i.DocNo AS Doc, dr.CompanyName AS Cust,
           CONVERT(char(10), i.DocDate, 120) AS Dt, CONVERT(char(10), i.DueDate, 120) AS Due,
           i.LocalNetTotal AS Total, i.Outstanding AS Amt,
           DATEDIFF(day, i.DueDate, GETDATE()) AS Late
      FROM ARInvoice i JOIN Debtor dr ON dr.AccNo = i.DebtorCode
     WHERE i.Cancelled = 'F' AND i.Outstanding > 0
     ORDER BY i.Outstanding DESC`))
    .map((r) => ({ doc: r.Doc, cust: r.Cust || "", date: r.Dt, due: r.Due,
                   total: num(r.Total), amt: num(r.Amt), late: num(r.Late) }));

  out.liabilities = (await q(db, `
    SELECT g.AccNo AS Acc, g.Description AS Nm, g.SpecialAccType AS Sp,
           SUM(d.HomeCR - d.HomeDR) AS Bal
      FROM GLMast g JOIN GLDTL d ON d.AccNo = g.AccNo
     WHERE g.AccType = 'CL'
     GROUP BY g.AccNo, g.Description, g.SpecialAccType
     HAVING SUM(d.HomeCR - d.HomeDR) <> 0
     ORDER BY SUM(d.HomeCR - d.HomeDR) DESC`))
    .map((r) => ({
      acc: r.Acc, name: r.Nm || r.Acc, special: r.Sp || "", bal: num(r.Bal),
      isControl: (r.Sp || "") === "SCR",
      isDeferred: /UNRECOGNISED|UNEARNED|DEFERRED|DEPOSIT|ADVANCE/i.test(r.Nm || ""),
    }));

  // ---- TRANSACTION DETAIL ------------------------------------------------
  // Every ledger line behind the topics, so each screen can be drilled to the
  // document. Stored as dictionaries plus index rows to keep the page small.
  const accIx = new Map();
  out.accs = [];
  const acc = (a, n, t) => {
    if (!a) return -1;
    if (!accIx.has(a)) { accIx.set(a, out.accs.length); out.accs.push({ a, n: n || a, t: t || "?" }); }
    return accIx.get(a);
  };
  const partyIx = new Map();
  out.parties = [];
  const party = (n) => {
    const k = n || "(未命名)";
    if (!partyIx.has(k)) { partyIx.set(k, out.parties.length); out.parties.push(k); }
    return partyIx.get(k);
  };

  // Kinds are mutually exclusive: an account is revenue, cost, liability or bank.
  //   R revenue · E expense · L liability · C cash
  const gl = await q(db, `
    SELECT CONVERT(char(10), d.TransDate, 120) AS Dt,
           ISNULL(d.RefNo1, '') AS Ref,
           LEFT(ISNULL(d.Description, ''), 70) AS Ds,
           d.AccNo AS Acc, g.Description AS AccNm, g.AccType AS Typ,
           ISNULL(g.SpecialAccType, '') AS Sp,
           ISNULL(d.DEAccNo, '') AS Ctr, ISNULL(ce.Description, '') AS CtrNm,
           ISNULL(ce.AccType, '?') AS CtrTyp,
           d.HomeDR AS DR, d.HomeCR AS CR, ISNULL(d.JournalType, '') AS JT
      FROM GLDTL d
      JOIN GLMast g ON g.AccNo = d.AccNo
      LEFT JOIN GLMast ce ON ce.AccNo = d.DEAccNo
     WHERE d.TransDate >= ${SINCE}
       AND (g.AccType IN ('SL','OI','EP','CO','CL')
            OR g.SpecialAccType IN ('SBK','SCH'))
     ORDER BY d.TransDate DESC`, 60000);

  out.txns = gl.map((r) => {
    const dr = num(r.DR), cr = num(r.CR);
    const isBank = r.Sp === "SBK" || r.Sp === "SCH";
    let kind, amt;
    if (isBank) { kind = "C"; amt = num(dr - cr); }
    else if (r.Typ === "SL" || r.Typ === "OI") { kind = "R"; amt = num(cr - dr); }
    else if (r.Typ === "CL") { kind = "L"; amt = num(cr - dr); }
    else { kind = "E"; amt = num(dr - cr); }
    // [date, ref, description, account, contra, amount, kind, journal type]
    return [r.Dt, r.Ref, r.Ds, acc(r.Acc, r.AccNm, r.Typ),
            acc(r.Ctr, r.CtrNm, r.CtrTyp), amt, kind, r.JT];
  }).filter((t) => t[5] !== 0);

  // ---- sales invoices, whether settled or not
  out.arDocs = (await q(db, `
    SELECT CONVERT(char(10), i.DocDate, 120) AS Dt, i.DocNo AS Doc,
           dr.CompanyName AS Party, CONVERT(char(10), i.DueDate, 120) AS Due,
           i.LocalNetTotal AS Tot, i.Outstanding AS Outs,
           DATEDIFF(day, i.DueDate, GETDATE()) AS Late,
           LEFT(ISNULL(i.Description, ''), 70) AS Ds
      FROM ARInvoice i JOIN Debtor dr ON dr.AccNo = i.DebtorCode
     WHERE i.Cancelled = 'F' AND i.DocDate >= ${SINCE}
     ORDER BY i.DocDate DESC`, 20000))
    // [date, docNo, party, due, total, outstanding, daysLate, description]
    .map((r) => [r.Dt, r.Doc, party(r.Party), r.Due, num(r.Tot), num(r.Outs),
                 num(r.Late), r.Ds]);

  // ---- purchase invoices
  out.apDocs = (await q(db, `
    SELECT CONVERT(char(10), i.DocDate, 120) AS Dt, i.DocNo AS Doc,
           cr.CompanyName AS Party, CONVERT(char(10), i.DueDate, 120) AS Due,
           i.LocalNetTotal AS Tot, i.Outstanding AS Outs,
           DATEDIFF(day, i.DueDate, GETDATE()) AS Late,
           ISNULL(i.SupplierInvoiceNo, '') AS Ds
      FROM APInvoice i JOIN Creditor cr ON cr.AccNo = i.CreditorCode
     WHERE i.Cancelled = 'F' AND i.DocDate >= ${SINCE}
     ORDER BY i.DocDate DESC`, 20000))
    .map((r) => [r.Dt, r.Doc, party(r.Party), r.Due, num(r.Tot), num(r.Outs),
                 num(r.Late), r.Ds]);

  // ---- invoice lines, for the service-line screen
  out.slDocs = (await q(db, `
    SELECT CONVERT(char(10), i.DocDate, 120) AS Dt, i.DocNo AS Doc,
           d.AccNo AS Acc, g.Description AS AccNm, ISNULL(g.AccType, '?') AS Typ,
           dr.CompanyName AS Party, LEFT(ISNULL(d.Description, ''), 70) AS Ds,
           d.LocalNetAmount AS Amt
      FROM ARInvoiceDTL d
      JOIN ARInvoice i ON i.DocKey = d.DocKey
      JOIN Debtor dr ON dr.AccNo = i.DebtorCode
      LEFT JOIN GLMast g ON g.AccNo = d.AccNo
     WHERE i.Cancelled = 'F' AND i.DocDate >= ${SINCE}
     ORDER BY i.DocDate DESC`, 20000))
    .map((r) => [r.Dt, r.Doc, acc(r.Acc, r.AccNm, r.Typ), party(r.Party),
                 r.Ds, num(r.Amt)]);

  return out;
}

// ------------------------------------------------------------------- assemble

const companies = [];
for (const c of COMPANIES) {
  process.stdout.write("  " + c.db.padEnd(18));
  try {
    const r = await collect(c);
    companies.push(r);
    console.log("cash " + Math.round(r.cash).toLocaleString().padStart(10) +
                " | 月数 " + String(r.pnlByMonth.length).padStart(3) +
                " | 现金流列 " + String(r.cashFlow.length).padStart(5) +
                " | 分录 " + String(r.txns.length).padStart(6) +
                " | AR " + String(r.arDocs.length).padStart(5));
  } catch (e) {
    console.log("FAILED - " + e.message.slice(0, 90));
    companies.push({ ...c, failed: e.message.slice(0, 200) });
  }
}

const ok = companies.filter((c) => !c.failed);
const allMonths = [...new Set(ok.flatMap((c) => c.pnlByMonth.map((m) => m.ym)))].sort();

const data = {
  generatedAt: new Date().toISOString(),
  monthsCovered: MONTHS,
  months: allMonths,
  companies,
};

writeFileSync("dashboard-data.json", JSON.stringify(data), "utf8");
console.log("\nWrote dashboard-data.json  (" + ok.length + "/" + companies.length +
  " companies, " + allMonths.length + " months: " + allMonths[0] + " → " +
  allMonths[allMonths.length - 1] + ")");
await client.close();
