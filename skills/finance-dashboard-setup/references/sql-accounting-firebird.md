# SQL Accounting / SQL Account (eStream) — Firebird

> **Status: UNVERIFIED.** Written from vendor documentation and Firebird's
> documented behaviour, not from a working install. Treat every specific below
> as a starting point to confirm, and let `selftest.mjs` decide whether it works
> rather than assuming. Tell the user this is the first run on their system.

Despite the name, **SQL Accounting does not use Microsoft SQL Server.** It runs
on **Firebird**, an open-source engine with a different client, different system
catalogue and different SQL dialect. Nothing from the AutoCount path transfers
except the read-only guard and the general approach.

eStream document Firebird ODBC access on their own wiki, which is a useful sign
that direct read access is an expected thing to do rather than a workaround.

## Key differences from SQL Server

| | SQL Server | Firebird |
|---|---|---|
| Client | `sqlcmd.exe` | `isql.exe` |
| Database identity | name on a server | **a file path** (`.fdb`) |
| Companies | one database each | one `.fdb` file each |
| Auth | Windows auth | user + password (`SYSDBA`) |
| Catalogue | `sys.tables`, `sys.columns` | `rdb$relations`, `rdb$relation_fields` |
| Row limit | `SELECT TOP n` | `SELECT FIRST n` or `ROWS n` |
| String concat | `+` | `||` |
| Current date | `GETDATE()` | `CURRENT_DATE` |
| Date difference | `DATEDIFF(day, a, b)` | `DATEDIFF(DAY FROM a TO b)` |

Anything written for AutoCount will need its SQL rewritten, not just its
connection string.

## 1. Locate the database files

Company books are `.fdb` files, commonly under a shared folder such as:

```
C:\eStream\SQLAccounting\Share\
```

Ask the user — the location is set at install time and is often on a server
share. Each `.fdb` is one company.

## 2. Locate isql.exe

Ships with Firebird:

```
C:\Program Files\Firebird\Firebird_5_0\isql.exe
C:\Program Files\Firebird\Firebird_3_0\isql.exe
```

SQL Accounting installs Firebird 3.0 or 5.0 depending on version.

## 3. Confirm access by hand first

Do this before configuring anything, so a failure is unambiguous:

```
isql.exe "C:\eStream\SQLAccounting\Share\COMPANY.fdb" -user SYSDBA -password masterkey
SQL> SET LIST ON;
SQL> SELECT COUNT(*) AS N FROM rdb$relations;
SQL> QUIT;
```

If that fails, everything downstream will too. Common causes: the Firebird
service is not running, the file is locked by SQL Accounting, the password was
changed from the default, or the path is wrong.

**Credentials.** `masterkey` is the Firebird default and is often left as-is,
but do not assume. Better: ask their SQL Accounting dealer for a **read-only
Firebird user**. That is a genuine second lock, independent of this server's
guard, and worth having on live books.

## 4. Configure

```json
"env": {
  "ACCT_ENGINE": "firebird",
  "ACCT_FB_DIR": "C:\\eStream\\SQLAccounting\\Share",
  "ACCT_FB_USER": "SYSDBA",
  "ACCT_FB_PASSWORD": "masterkey"
}
```

Optional `ACCT_ISQL` for a non-standard `isql.exe` path.

Company names passed to the tools are **file names** (`ACME.FDB`), not bare
names. `list_companies` lists the directory rather than querying a catalogue,
because Firebird has no server-side list of other databases.

## 5. Verify

```
node selftest.mjs ACME.FDB
```

Expect this to be where problems surface. Work through failures before trusting
any number.

## How the driver reads results

`isql` prints column-aligned output by default and truncates wide values — the
same corrupting behaviour `sqlcmd` has. The driver uses `SET LIST ON`, which
prints one field per line as `FIELDNAME    value` with a blank line between
records. No column widths, so nothing is cut off.

**Known limit:** a value containing a newline splits across lines and will be
misread. If the books contain multi-line descriptions or addresses in a field
you select, switch to encoding server-side — Firebird 3+ has `BASE64_ENCODE()`,
so the same approach the SQL Server driver uses is available. The self-test's
integrity checks are what will tell you whether this matters here.

## Schema — what to confirm

The table names below are **not verified**. Map the real schema with
`list_tables` and `describe_table` before writing analysis, exactly as Step 3 of
the skill says.

Useful catalogue queries:

```sql
-- user tables
SELECT TRIM(rdb$relation_name) AS TableName FROM rdb$relations
 WHERE rdb$view_blr IS NULL AND (rdb$system_flag IS NULL OR rdb$system_flag = 0)
 ORDER BY 1;

-- columns of one table
SELECT TRIM(rf.rdb$field_name) AS ColumnName, rf.rdb$field_position AS Pos
  FROM rdb$relation_fields rf
 WHERE UPPER(rf.rdb$relation_name) = UPPER('AR_INVOICE')
 ORDER BY rf.rdb$field_position;
```

Look for the same shapes the pitfalls reference describes: a chart of accounts
with an account-type column, a ledger detail table with debit/credit columns and
a date, sales and purchase document tables with an outstanding balance and a
cancelled flag, and customer/supplier masters.

Once mapped, **write the map down** in the project so the next person does not
rediscover it — and consider contributing it back into this reference, changing
its status from unverified to verified.

## If direct access is refused

Some dealers lock the Firebird password or the books sit on a machine you cannot
reach. Then this becomes an export-based job: see `cloud-systems.md`, which
covers the same ground for hosted systems.
