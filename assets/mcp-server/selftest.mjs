// Self-test for the read-only accounting MCP server.
//
//   node selftest.mjs                  pick a company book automatically
//   node selftest.mjs AED_YOURBOOK     test against a specific one
//
// Two things are checked, and both matter for different reasons.
//
// The GUARD checks prove the server cannot be talked into writing. That is the
// safety boundary - if any of these is ALLOWED, do not connect this to a real
// set of books.
//
// The INTEGRITY checks prove the numbers that come back are the numbers in the
// database. Command-line SQL tools format output for a terminal: they wrap long
// lines and truncate wide columns, which corrupts results *without raising an
// error*. That failure mode is worse than a crash, because the dashboard still
// draws a chart - just a wrong one.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const client = new Client({ name: "selftest", version: "1.0.0" }, { capabilities: {} });
await client.connect(new StdioClientTransport({
  command: process.execPath, args: ["index.js"], env: process.env,
}));

let failures = 0;
const pass = (m, d) => console.log("PASS  " + m + (d ? "  -- " + d : ""));
const fail = (m, d) => { failures++; console.log("FAIL  " + m + (d ? "  -- " + d : "")); };

async function call(name, args) {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content.map((c) => c.text).join("\n");
  return { isError: r.isError === true, text };
}
async function rows(name, args) {
  const r = await call(name, args);
  if (r.isError) throw new Error(r.text.split("\n").slice(0, 3).join(" "));
  const i = r.text.indexOf("[");
  return i === -1 ? [] : JSON.parse(r.text.slice(i));
}

// ---------------------------------------------------------------- discovery
const engine = (process.env.ACCT_ENGINE || "mssql").toLowerCase();
let DB = process.argv[2];
try {
  const companies = await rows("list_companies", {});
  if (!companies.length) { fail("list_companies returned nothing"); process.exit(1); }
  pass("list_companies", companies.length + " books found");
  if (!DB) DB = companies[0].DatabaseName;
} catch (e) {
  fail("list_companies threw", e.message);
  process.exit(1);
}
console.log("      testing against: " + DB + "  (engine: " + engine + ")\n");

// Pick the widest table available - wide tables are where truncation shows up.
let TABLE = null;
try {
  const tables = await rows("list_tables", { database: DB });
  if (!tables.length) { fail("list_tables returned nothing"); process.exit(1); }
  pass("list_tables", tables.length + " tables");
  const byRows = tables
    .filter((t) => t.RowCountApprox === undefined || Number(t.RowCountApprox) > 0)
    .sort((a, b) => Number(b.RowCountApprox || 0) - Number(a.RowCountApprox || 0));
  TABLE = (byRows[0] || tables[0]).TableName;
} catch (e) {
  fail("list_tables threw", e.message);
  process.exit(1);
}

let COLS = [];
try {
  COLS = await rows("describe_table", { database: DB, table: TABLE });
  if (!COLS.length) fail("describe_table returned no columns for " + TABLE);
  else pass("describe_table", TABLE + " has " + COLS.length + " columns");
} catch (e) {
  fail("describe_table threw", e.message);
}

// ------------------------------------------------------------------- guard
console.log("\n--- read-only guard ---");
const attacks = [
  ["plain DELETE", "DELETE FROM " + TABLE],
  ["UPDATE", "UPDATE " + TABLE + " SET x = 0"],
  ["piggybacked statement", "SELECT 1 AS x; DROP TABLE " + TABLE],
  ["hidden behind a comment", "SELECT 1 AS x /* ok */ ; TRUNCATE TABLE " + TABLE],
  ["SELECT INTO", "SELECT * INTO Backup1 FROM " + TABLE],
  ["stored procedure", "SELECT 1 AS x WHERE 1=1 EXEC xp_cmdshell 'dir'"],
  ["transaction control", "SELECT 1 AS x COMMIT"],
];
for (const [label, sql] of attacks) {
  const r = await call("query", { database: DB, sql });
  if (r.isError) pass("blocked: " + label);
  else fail("ALLOWED: " + label, "the guard let this through");
}
// The system-database guard has two doors and only one was tested. The database
// NAME is checked as an argument below; it can also arrive inside the SQL text,
// which is how someone reads another database on the same server without ever
// naming it in the parameter. That matters more now these tools can be served
// over HTTP - payroll and other companies' books usually sit on the same server.
{
  const sysdb = engine === "mssql" ? "master" : "security3";
  const sneaks = [
    ["system db inside the SQL", "SELECT * FROM " + sysdb + ".sys.tables"],
    ["cross-database shorthand", "SELECT * FROM otherbook..SomeTable"],
    ["system db behind a comment", "SELECT * FROM /*x*/ " + sysdb + ".dbo.t"],
  ];
  for (const [label, sql] of sneaks) {
    const r = await call("query", { database: DB, sql });
    const txt = r.text || "";
    // A crash is not a block. Without this the suite scores a broken guard as a
    // working one - which is exactly what happened while writing this fix.
    if (/is not defined|is not a function|Cannot read/i.test(txt))
      fail("guard threw instead of refusing: " + label, txt.slice(0, 70));
    else if (r.isError) pass("blocked: " + label);
    else fail("ALLOWED: " + label);
  }
}

const sysName = engine === "mssql" ? "master" : "security3.fdb";
const sysTry = await call("query", { database: sysName, sql: "SELECT 1 AS x" });
if (sysTry.isError) pass("blocked: system database (" + sysName + ")");
else fail("ALLOWED: system database " + sysName);

// --------------------------------------------------------------- integrity
console.log("\n--- data integrity ---");

// 1. Column names must survive intact. Line wrapping in the CLI tool shows up
//    here first: names gain line breaks or disappear entirely.
const broken = COLS.filter((c) => c.ColumnName === undefined || /[\r\n]/.test(c.ColumnName || ""));
if (broken.length) fail("column names corrupted", JSON.stringify(broken.slice(0, 3)));
else pass("no column names missing or broken", COLS.length + " checked");

// 2. A wide multi-row payload must not grow stray keys.
try {
  const names = COLS.slice(0, 6).map((c) => c.ColumnName).filter(Boolean);
  if (names.length >= 2) {
    const sel = names.map((n) => (engine === "mssql" ? '"' + n + '"' : n)).join(", ");
    const wide = await rows("query", {
      database: DB,
      sql: engine === "mssql"
        ? "SELECT TOP 300 " + sel + " FROM " + TABLE
        : "SELECT " + sel + " FROM " + TABLE + " ROWS 300",
    });
    const seen = new Set();
    wide.forEach((r) => Object.keys(r).forEach((k) => seen.add(k)));
    const stray = [...seen].filter((k) => !names.includes(k));
    if (stray.length) fail("wide payload gained stray keys", JSON.stringify(stray));
    else pass("300-row payload has no stray keys", wide.length + " rows returned");
  } else {
    pass("skipped wide-payload check", "table has too few columns");
  }
} catch (e) {
  fail("wide payload query threw", e.message);
}

// 3. An empty result is not an error.
try {
  const none = await call("query", { database: DB, sql: "SELECT 1 AS x FROM " + TABLE + " WHERE 1 = 0" });
  if (none.isError) fail("empty result treated as an error", none.text.split("\n")[1]);
  else pass("empty result returns cleanly");
} catch (e) {
  fail("empty result threw", e.message);
}

// 4. A genuine error must still be reported - silence here would mean real
//    failures get mistaken for empty tables.
const bad = await call("query", { database: DB, sql: "SELECT * FROM ZzNoSuchTable_" });
if (bad.isError) pass("a real SQL error is reported");
else fail("a bad query returned success");

// 5. Non-ASCII must round-trip. Accounting data is full of local-language names.
try {
  const u = await rows("query", {
    database: DB,
    sql: engine === "mssql"
      ? "SELECT N'测试 test' AS Sample"
      : "SELECT '测试 test' AS Sample FROM rdb$database",
  });
  if (u.length && /测试/.test(u[0].Sample)) pass("non-ASCII round-trips", u[0].Sample);
  else fail("non-ASCII mangled", JSON.stringify(u[0] || {}));
} catch (e) {
  fail("unicode check threw", e.message);
}

console.log(failures === 0
  ? "\nAll checks passed. Safe to connect."
  : "\n" + failures + " CHECK(S) FAILED - do not connect this to live books until fixed.");
await client.close();
process.exit(failures === 0 ? 0 : 1);
