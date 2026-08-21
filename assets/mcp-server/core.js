/**
 * Accounting → Claude : READ-ONLY MCP server
 *
 * Exposes an accounting system's database to Claude as four read-only tools.
 * Every statement is inspected before it runs; anything that is not a plain
 * SELECT is refused, so this server cannot modify the books.
 *
 * Two database engines are supported. The guard, the tools and the result
 * handling are shared; only the "how do I actually run a query" part differs.
 *
 *   ACCT_ENGINE=mssql      SQL Server via sqlcmd   (AutoCount Desktop) — verified
 *   ACCT_ENGINE=firebird   Firebird via isql       (SQL Accounting)    — UNVERIFIED
 *
 * If you are the first person to point this at Firebird: run selftest.mjs before
 * trusting a single number. The driver is written from the documented behaviour
 * of isql, not from a live system.
 *
 * This module holds everything except the transport, so the stdio entry point
 * (index.js) and the remote HTTP entry point (remote.js) share one guard and one
 * engine layer. A second copy of the guard would drift, and the copy that drifts
 * is the one nobody re-tests.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { execFile } from "node:child_process";
import { readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const env = (...names) => {
  for (const n of names) if (process.env[n]) return process.env[n];
  return undefined;
};

const ENGINE = (env("ACCT_ENGINE") || "mssql").toLowerCase();
const QUERY_TIMEOUT_SECONDS = Number(env("ACCT_TIMEOUT")) || 60;

// Default cap, so a careless query cannot pull a whole ledger by accident.
const MAX_ROWS = 5000;
// Ceiling for callers that ask for more on purpose (max_rows).
const HARD_MAX_ROWS = 60000;

function findExe(explicit, candidates, what) {
  if (explicit && existsSync(explicit)) return explicit;
  for (const p of candidates) if (existsSync(p)) return p;
  throw new Error(
    what + " not found. Set its full path in the environment and restart Claude."
  );
}

function execFileAsync(file, args, opts) {
  return new Promise((resolve) => {
    execFile(file, args, opts, (error, stdout, stderr) =>
      resolve({ error, stdout, stderr })
    );
  });
}

// ---------------------------------------------------------------------------
// Read-only guard  (engine independent - this is the safety boundary)
// ---------------------------------------------------------------------------

const FORBIDDEN = [
  "INSERT", "UPDATE", "DELETE", "MERGE", "TRUNCATE",
  "DROP", "ALTER", "CREATE", "RENAME",
  "EXEC", "EXECUTE", "SP_", "XP_",
  "GRANT", "REVOKE", "DENY",
  "BACKUP", "RESTORE", "SHUTDOWN", "RECONFIGURE",
  "OPENROWSET", "OPENDATASOURCE", "OPENQUERY", "BULK",
  "WAITFOR", "KILL", "COMMIT", "ROLLBACK",
];

function stripComments(sql) {
  // Comments are removed first so a keyword cannot hide inside one.
  return sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n\r]*/g, " ");
}

function assertReadOnly(rawSql) {
  const sql = stripComments(rawSql).trim();
  if (!sql) throw new Error("Empty query.");

  if (!/^\s*(SELECT|WITH)\b/i.test(sql)) {
    throw new Error(
      "Read-only server: only SELECT (or WITH ... SELECT) queries are allowed."
    );
  }

  const body = sql.replace(/;\s*$/, "");
  if (body.includes(";")) {
    throw new Error("Read-only server: multiple statements are not allowed.");
  }
  if (/^\s*GO\s*$/im.test(sql)) {
    throw new Error("Read-only server: batch separators (GO) are not allowed.");
  }
  // SELECT ... INTO creates a table on both engines.
  if (/\bINTO\s+[#[\w"]/i.test(body)) {
    throw new Error("Read-only server: SELECT ... INTO is not allowed.");
  }
  for (const word of FORBIDDEN) {
    const re = word.endsWith("_")
      ? new RegExp("\\b" + word + "\\w*", "i")
      : new RegExp("\\b" + word + "\\b", "i");
    if (re.test(body)) {
      throw new Error("Read-only server: the keyword " + word + " is not allowed.");
    }
  }
  return body;
}

// ---------------------------------------------------------------------------
// Engine: SQL Server via sqlcmd   (AutoCount Desktop) - VERIFIED
// ---------------------------------------------------------------------------

const mssql = {
  label: "SQL Server (sqlcmd)",

  instance: env("ACCT_SQL_INSTANCE", "AUTOCOUNT_SQL_INSTANCE") || ".\\A2006",

  systemDatabases: new Set(["master", "model", "msdb", "tempdb", "distribution"]),

  exe: () => findExe(
    env("ACCT_SQLCMD", "AUTOCOUNT_SQLCMD"),
    [
      "C:\\Program Files\\Microsoft SQL Server\\Client SDK\\ODBC\\170\\Tools\\Binn\\sqlcmd.exe",
      "C:\\Program Files\\Microsoft SQL Server\\Client SDK\\ODBC\\130\\Tools\\Binn\\sqlcmd.exe",
      "C:\\Program Files\\Microsoft SQL Server\\Client SDK\\ODBC\\110\\Tools\\Binn\\sqlcmd.exe",
      "C:\\Program Files (x86)\\Microsoft SQL Server\\Client SDK\\ODBC\\110\\Tools\\Binn\\sqlcmd.exe",
    ],
    "sqlcmd.exe"
  ),

  listDatabasesSql:
    "SELECT name AS DatabaseName FROM sys.databases " +
    "WHERE name NOT IN ('master','model','msdb','tempdb') ORDER BY name",

  listTablesSql: (filter) =>
    "SELECT t.name AS TableName, p.rows AS RowCountApprox " +
    "FROM sys.tables t JOIN sys.partitions p " +
    "ON p.object_id = t.object_id AND p.index_id IN (0,1) " +
    (filter ? "WHERE t.name LIKE '%" + filter + "%' " : "") +
    "ORDER BY t.name",

  describeTableSql: (table) =>
    "SELECT c.name AS ColumnName, ty.name AS DataType, " +
    "c.max_length AS MaxLength, c.is_nullable AS IsNullable " +
    "FROM sys.columns c JOIN sys.types ty ON ty.user_type_id = c.user_type_id " +
    "WHERE c.object_id = OBJECT_ID('" + table + "') ORDER BY c.column_id",

  /**
   * sqlcmd formats output for a terminal: it breaks long lines at the display
   * width, which silently corrupts raw XML (a break can land inside a tag).
   * So SQL Server is asked to base64-encode the result first - base64 has no
   * significant whitespace, so any breaks sqlcmd inserts can be stripped.
   */
  async run(database, selectSql, maxRows) {
    const batch = [
      // The XML .value() method needs these; sqlcmd defaults them OFF.
      "SET QUOTED_IDENTIFIER ON;",
      "SET ANSI_NULLS ON;",
      "SET NOCOUNT ON;",
      // Do not block colleagues who are posting entries right now.
      "SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;",
      "SET ROWCOUNT " + maxRows + ";",
      "DECLARE @xml NVARCHAR(MAX);",
      "SET @xml = (",
      selectSql,
      "FOR XML PATH('row'), ROOT('rows'));",
      "SET ROWCOUNT 0;",
      "SET @xml = ISNULL(@xml, N'');",
      "DECLARE @bin VARBINARY(MAX) = CAST(@xml AS VARBINARY(MAX));",
      "SELECT CAST(N'' AS XML).value('xs:base64Binary(sql:variable(\"@bin\"))', 'VARCHAR(MAX)') AS B64;",
    ].join("\n");

    const out = await runViaFile(this.exe(), (inFile, outFile) => [
      "-S", this.instance,
      "-E",                        // Windows authentication
      "-d", database,
      "-i", inFile,
      "-o", outFile,
      "-u",                        // Unicode output file
      "-y", "0",                   // do not truncate wide values
      "-b",
      "-t", String(QUERY_TIMEOUT_SECONDS),
    ], batch, "utf16le");

    const b64 = extractBase64Payload(out);
    if (!b64) return [];
    // NVARCHAR is UTF-16LE on the wire.
    const xml = Buffer.from(b64, "base64").toString("utf16le");
    if (!xml.includes("<rows>")) return [];
    return parseXmlRows(xml);
  },
};

// ---------------------------------------------------------------------------
// Engine: Firebird via isql   (SQL Accounting) - UNVERIFIED, validate first
// ---------------------------------------------------------------------------

const firebird = {
  label: "Firebird (isql)",

  // Firebird addresses a database by file path, not by name.
  // ACCT_FB_DIR is the folder holding the .fdb files, one per company.
  dir: env("ACCT_FB_DIR") || "C:\\eStream\\SQLAccounting\\Share",
  user: env("ACCT_FB_USER") || "SYSDBA",
  password: env("ACCT_FB_PASSWORD") || "masterkey",

  systemDatabases: new Set(["security3.fdb", "security5.fdb"]),

  exe: () => findExe(
    env("ACCT_ISQL"),
    [
      "C:\\Program Files\\Firebird\\Firebird_5_0\\isql.exe",
      "C:\\Program Files\\Firebird\\Firebird_4_0\\isql.exe",
      "C:\\Program Files\\Firebird\\Firebird_3_0\\isql.exe",
      "C:\\Program Files (x86)\\Firebird\\Firebird_3_0\\isql.exe",
    ],
    "isql.exe (Firebird)"
  ),

  // Firebird has no server-side catalogue of "other databases" - each company
  // is a separate file - so the file listing is done in Node, not SQL.
  listDatabasesSql: null,

  listTablesSql: (filter) =>
    "SELECT TRIM(rdb$relation_name) AS TableName FROM rdb$relations " +
    "WHERE rdb$view_blr IS NULL AND (rdb$system_flag IS NULL OR rdb$system_flag = 0) " +
    (filter ? "AND UPPER(rdb$relation_name) LIKE UPPER('%" + filter + "%') " : "") +
    "ORDER BY rdb$relation_name",

  describeTableSql: (table) =>
    "SELECT TRIM(rf.rdb$field_name) AS ColumnName, " +
    "TRIM(t.rdb$type_name) AS DataType, f.rdb$field_length AS MaxLength, " +
    "COALESCE(rf.rdb$null_flag, 0) AS NotNullFlag " +
    "FROM rdb$relation_fields rf " +
    "JOIN rdb$fields f ON f.rdb$field_name = rf.rdb$field_source " +
    "JOIN rdb$types t ON t.rdb$type = f.rdb$field_type AND t.rdb$field_name = 'RDB$FIELD_TYPE' " +
    "WHERE UPPER(rf.rdb$relation_name) = UPPER('" + table + "') " +
    "ORDER BY rf.rdb$field_position",

  /**
   * isql's default output is column-aligned and truncates wide values, which
   * would corrupt data the same way sqlcmd's line wrapping does. SET LIST ON
   * switches it to one field per line ("NAME   value"), with a blank line
   * between records - no width limit, so nothing is cut off.
   *
   * Known limit: a value containing a newline would split across lines and be
   * misread. Firebird 3+ has BASE64_ENCODE, so the sturdier fix is to encode
   * server-side the way the SQL Server driver does. Do that if you hit it.
   */
  async run(database, selectSql, maxRows) {
    const dbPath = join(this.dir, database);
    const capped = /^\s*SELECT\b/i.test(selectSql)
      ? selectSql.replace(/^(\s*SELECT)\b/i, "$1 FIRST " + maxRows)
      : selectSql;

    const batch = "SET LIST ON;\nSET HEADING OFF;\n" + capped + ";\n";

    const out = await runViaFile(this.exe(), (inFile, outFile) => [
      dbPath,
      "-user", this.user,
      "-password", this.password,
      "-i", inFile,
      "-o", outFile,
      "-charset", "UTF8",
      "-q",
    ], batch, "utf8");

    if (/^(Statement failed|SQL error|Unsuccessful)/im.test(out)) {
      throw new Error("SQL error:\n" + out.trim());
    }
    return parseListOutput(out);
  },
};

const ENGINES = { mssql, firebird };
const db = ENGINES[ENGINE];
if (!db) {
  throw new Error(
    "Unknown ACCT_ENGINE '" + ENGINE + "'. Use one of: " + Object.keys(ENGINES).join(", ")
  );
}

// ---------------------------------------------------------------------------
// Shared execution plumbing
// ---------------------------------------------------------------------------

/**
 * Both CLI tools take a script file and write to an output file. Going through
 * files rather than stdin/stdout keeps Unicode intact on Windows.
 */
async function runViaFile(exe, buildArgs, script, encoding) {
  const id = randomUUID();
  const inFile = join(tmpdir(), "acct-mcp-" + id + ".sql");
  const outFile = join(tmpdir(), "acct-mcp-" + id + ".out");

  // A BOM makes the tool read the script as Unicode rather than the code page.
  writeFileSync(inFile, (encoding === "utf16le" ? "\uFEFF" : "") + script, encoding);

  try {
    const { error, stderr } = await execFileAsync(exe, buildArgs(inFile, outFile), {
      windowsHide: true,
      timeout: (QUERY_TIMEOUT_SECONDS + 15) * 1000,
    });

    let output = "";
    try {
      output = await readFile(outFile, encoding);
    } catch {
      output = "";
    }
    output = output.replace(/^\uFEFF/, "").trim();

    // An empty result set legitimately produces no output, so silence only
    // counts as failure when the process itself also failed. Neither the exit
    // code nor the message severity can decide this alone: sqlcmd exits
    // non-zero for warnings too, and SQL Server reports some warnings at
    // severity 16 (Msg 8153, "Null value is eliminated by an aggregate").
    if (!output && error) {
      throw new Error("SQL error:\n" + (stderr || String(error.message)));
    }
    return output;
  } finally {
    unlink(inFile).catch(() => {});
    unlink(outFile).catch(() => {});
  }
}

function extractBase64Payload(out) {
  let lines = out.split(/\r?\n/).map((l) => l.trim());

  // A column header comes with a dashed separator; drop everything up to it so
  // the header text is not mistaken for payload.
  const sep = lines.findIndex((l) => /^-+$/.test(l));
  if (sep !== -1) lines = lines.slice(sep + 1);

  // Message lines always contain spaces or punctuation; base64 never does.
  const b64 = lines.filter((l) => /^[A-Za-z0-9+/=]+$/.test(l)).join("");
  if (b64 !== "" && b64.toUpperCase() !== "NULL") return b64;

  if (/^(Msg \d+, Level|Warning:)/m.test(out)) {
    throw new Error("SQL error:\n" + out.trim());
  }
  return "";
}

function unescapeXml(s) {
  return s
    .replace(/&#x([0-9A-Fa-f]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"").replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

// FOR XML encodes characters illegal in element names, e.g. a space becomes
// _x0020_. Turn those back into readable column names.
function decodeColumnName(name) {
  return name.replace(/_x([0-9A-Fa-f]{4})_/g, (_, h) =>
    String.fromCodePoint(parseInt(h, 16)));
}

function parseXmlRows(xml) {
  const rows = [];
  const rowRe = /<row>([\s\S]*?)<\/row>/g;
  let rowMatch;
  while ((rowMatch = rowRe.exec(xml)) !== null) {
    const obj = {};
    const colRe = /<([^\s/>]+)(?:\s[^>]*)?>([\s\S]*?)<\/\1>|<([^\s/>]+)\s*\/>/g;
    let m;
    while ((m = colRe.exec(rowMatch[1])) !== null) {
      if (m[3] !== undefined) obj[decodeColumnName(m[3])] = null;
      else obj[decodeColumnName(m[1])] = unescapeXml(m[2]);
    }
    rows.push(obj);
  }
  return rows;
}

// isql with SET LIST ON prints "FIELDNAME   value", one per line, records
// separated by a blank line.
function parseListOutput(out) {
  const rows = [];
  let cur = null;
  for (const line of out.split(/\r?\n/)) {
    if (!line.trim()) {
      if (cur && Object.keys(cur).length) { rows.push(cur); cur = null; }
      continue;
    }
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_$]*)\s{2,}(.*)$/);
    if (!m) continue;
    cur = cur || {};
    const v = m[2].trim();
    cur[m[1]] = v === "<null>" ? null : v;
  }
  if (cur && Object.keys(cur).length) rows.push(cur);
  return rows;
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

// A query may not reach out of the book it was pointed at.
//
// assertSafeDatabase guards the `database` ARGUMENT, and the self-test covers
// that path - but the database name can also arrive inside the SQL itself, as
// master.sys.tables or otherbook..SomeTable, and that route was unguarded.
//
// On a local stdio server that was a small thing: the user already had the
// machine. Serving these tools over HTTP changes the stakes - a SQL Server
// holding the accounting books usually holds payroll, or another company's
// books, right beside them, and a token holder could walk from one to the other
// without ever naming the other database in the parameter.
function assertNoCrossDatabase(sql) {
  const bare = stripComments(String(sql));
  for (const sysdb of db.systemDatabases) {
    const name = sysdb.replace(/\.fdb$/i, "");
    if (new RegExp("(^|[^A-Za-z0-9_])" + name + "\\s*\\.", "i").test(bare)) {
      throw new Error("Access to the system database " + sysdb + " is not allowed.");
    }
  }
  // db..table - the shorthand that skips the schema and hops databases.
  if (/[A-Za-z0-9_\]]\s*\.\s*\./.test(bare)) {
    throw new Error("Cross-database references are not allowed. Query one book at a time.");
  }
  return sql;
}

function assertSafeDatabase(name) {
  if (!name || typeof name !== "string") throw new Error("A database name is required.");
  if (!/^[A-Za-z0-9_ .\-]+$/.test(name)) throw new Error("Invalid database name: " + name);
  if (db.systemDatabases.has(name.toLowerCase())) {
    throw new Error("Access to the system database " + name + " is not allowed.");
  }
  return name;
}

const asText = (t) => ({ content: [{ type: "text", text: t }] });
const rowsToText = (rows, note) =>
  rows.length === 0
    ? asText(note ? "No rows.\n(" + note + ")" : "No rows.")
    : asText((note ? note + "\n\n" : "") + JSON.stringify(rows, null, 2));

async function listCompanies() {
  if (db.listDatabasesSql) {
    // SQL Server keeps a catalogue of databases; read it from master.
    return db.run("master", db.listDatabasesSql, MAX_ROWS);
  }
  // Firebird: each company is a file, so list the directory instead.
  const { readdir } = await import("node:fs/promises");
  const files = await readdir(db.dir);
  return files
    .filter((f) => /\.fdb$/i.test(f) && !db.systemDatabases.has(f.toLowerCase()))
    .sort()
    .map((f) => ({ DatabaseName: f }));
}

const TOOLS = [
  {
    name: "list_companies",
    description:
      "List every company account book on this accounting system. Call this " +
      "first to find out which company to query.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "list_tables",
    description:
      "List tables in one company book. Use the optional filter to search by " +
      "partial name, for example invoice or debtor.",
    inputSchema: {
      type: "object",
      properties: {
        database: { type: "string", description: "Company book, from list_companies" },
        filter: { type: "string", description: "Optional partial table name" },
      },
      required: ["database"],
      additionalProperties: false,
    },
  },
  {
    name: "describe_table",
    description:
      "Show the columns, data types and nullability of one table, so queries " +
      "use the correct column names.",
    inputSchema: {
      type: "object",
      properties: {
        database: { type: "string" },
        table: { type: "string" },
      },
      required: ["database", "table"],
      additionalProperties: false,
    },
  },
  {
    name: "query",
    description:
      "Run a READ-ONLY SELECT against one company book and return the rows. " +
      "Only SELECT (or WITH ... SELECT) is permitted; anything that would change " +
      "data is refused. Every selected column needs a name or alias, for example " +
      "SUM(Total) AS TotalAmount. Returns at most " + MAX_ROWS +
      " rows unless max_rows asks for more, up to " + HARD_MAX_ROWS + ".",
    inputSchema: {
      type: "object",
      properties: {
        database: { type: "string" },
        sql: { type: "string", description: "A single SELECT statement" },
        max_rows: { type: "integer" },
      },
      required: ["database", "sql"],
      additionalProperties: false,
    },
  },
];

export function createServer() {
const server = new Server(
  { name: "accounting", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  try {
    switch (name) {
      case "list_companies": {
        const rows = await listCompanies();
        return rowsToText(rows, "Company books on " + db.label + ".");
      }
      case "list_tables": {
        const d = assertSafeDatabase(args.database);
        const filter = String(args.filter || "").replace(/'/g, "''");
        return rowsToText(await db.run(d, db.listTablesSql(filter), MAX_ROWS),
                          "Tables in " + d);
      }
      case "describe_table": {
        const d = assertSafeDatabase(args.database);
        const t = String(args.table || "").replace(/'/g, "''");
        if (!t) throw new Error("A table name is required.");
        return rowsToText(await db.run(d, db.describeTableSql(t), MAX_ROWS),
                          "Columns of " + t + " in " + d);
      }
      case "query": {
        const d = assertSafeDatabase(args.database);
        const sql = assertNoCrossDatabase(assertReadOnly(String(args.sql || "")));
        const cap = Math.min(Number(args.max_rows) || MAX_ROWS, HARD_MAX_ROWS);
        const rows = await db.run(d, sql, cap);
        const note = rows.length >= cap
          ? rows.length + " rows from " + d + " (capped at " + cap + " - there may be more)."
          : rows.length + " rows from " + d + ".";
        return rowsToText(rows, note);
      }
      default:
        throw new Error("Unknown tool: " + name);
    }
  } catch (err) {
    return { content: [{ type: "text", text: "Error: " + err.message }], isError: true };
  }
});

return server;
}

export { TOOLS, assertReadOnly, assertSafeDatabase, db, MAX_ROWS, HARD_MAX_ROWS };
