# AutoCount Accounting 2.x (desktop / server) — SQL Server

**Status: verified.** Every step here was executed against a live installation
with 21 company books and ~32,000 ledger entries.

## What you are connecting to

AutoCount desktop stores each company book as its own **SQL Server** database,
named `AED_<COMPANY>`. Windows authentication normally works without a password
because the person running Claude is already the machine's user.

## 1. Find the SQL Server instance

Open `services.msc` and look for `SQL Server (XXX)` — the name in brackets is
the instance. AutoCount 2.x commonly uses `A2006`.

Confirm it answers, and that the books are visible:

```
sqlcmd -S ".\A2006" -E -Q "SELECT name FROM sys.databases ORDER BY name"
```

AutoCount books all start with `AED_`. If `sqlcmd` is not on PATH:

```
"C:\Program Files\Microsoft SQL Server\Client SDK\ODBC\110\Tools\Binn\sqlcmd.exe"
```

## 2. Configure the server

```json
"env": {
  "ACCT_ENGINE": "mssql",
  "ACCT_SQL_INSTANCE": ".\\A2006"
}
```

Optional: `ACCT_SQLCMD` for a non-standard `sqlcmd.exe`, `ACCT_TIMEOUT` for slow
queries (default 60s).

## 3. Verify

```
node selftest.mjs AED_YOURCOMPANY
```

## Schema map

Naming pattern: **master table + `DTL` detail table**. Figures below are one
real book, for a sense of scale.

### Customers and suppliers

| Table | Notes |
|---|---|
| `Debtor` (398) | `AccNo`, `CompanyName`, `CreditLimit` |
| `Creditor` | suppliers |

### Receivables and payables

| Table | Notes |
|---|---|
| `ARInvoice` (906) / `ARInvoiceDTL` (1343) | sales invoices. **Detail lines carry `AccNo`, not an item code** |
| `ARPayment` / `ARPaymentDTL` | receipts |
| `ARPaymentKnockOff` (999) | which receipt settled which invoice |
| `APInvoice` (1087) / `APInvoiceDTL` | purchase invoices, `CreditorCode` |

Key money columns on both invoice tables: `Total`, `LocalTotal`, `NetTotal`,
`LocalNetTotal`, `Outstanding`, plus `DocDate`, `DueDate`, `Cancelled`.

### General ledger

| Table | Notes |
|---|---|
| `GLMast` (937) | chart of accounts |
| `GLDTL` (27904) | the ledger itself — the largest table |
| `JE` / `JEDTL` | journals |
| `PBalance` | period balances |

There is **no** `GL` header table. `GLDTL` is the ledger, and its date column is
`TransDate` (not `DocDate`).

`GLDTL` is double-entry with separate columns: `HomeDR` / `HomeCR` (and
`OrgDR`/`OrgCR`, `DR`/`CR` for other currencies). `DEAccNo` holds the **contra
account** and in the observed install was populated on 100% of rows — this is
what makes cash-flow-by-counterparty possible.

### Account classification

`GLMast.AccType`:

| Code | Meaning |
|---|---|
| `SL` | Sales |
| `OI` | Other income |
| `EP` | Expense |
| `CO` | Cost of sales |
| `CA` / `CL` | Current asset / liability |
| `FA` / `OA` | Fixed / other asset |
| `CP`, `RE`, `SA`, `TX` | Capital, retained earnings, other |

`GLMast.SpecialAccType` marks special roles — the useful ones:

| Code | Meaning |
|---|---|
| `SBK` | Bank account |
| `SCH` | Cash in hand |
| `SDR` / `SCR` | AR / AP control account |
| `SFA` / `SAD` | Fixed asset / accumulated depreciation |

Bank and cash balances are therefore:

```sql
SELECT g.AccNo, g.Description, SUM(d.HomeDR - d.HomeCR) AS Balance
  FROM GLMast g LEFT JOIN GLDTL d ON d.AccNo = g.AccNo
 WHERE g.SpecialAccType IN ('SBK','SCH')
 GROUP BY g.AccNo, g.Description
```

### Stock

`Item` (master), `IV` / `IVDTL` (stock invoices). Note there are **two sales
paths**: `ARInvoice` (coded to GL accounts, no items) and `IV` (item-based).
Service businesses often use only the first, which is why the item and item-group
master tables are frequently empty.

### Also present

`EInvoice*` for Malaysian e-Invoice. `EventLog`, `AccessRight`, `ChangeLog`,
`Session` are system tables — skip them when analysing.

## Writing SQL for this path

1. **Alias every column.** Results come back through `FOR XML`, and an unnamed
   column is dropped. `SUM(Total) AS TotalAmount`, never bare `SUM(Total)`.
2. **Prefix non-ASCII string literals with `N`.** `N'逾期'`, not `'逾期'` —
   without it the literal is not Unicode and the characters become `?`.
3. `ORDER BY` is fine; it attaches to the outer SELECT.
4. One statement per call — the guard rejects a second one.

## Things that bite on this path

**Empty result vs failure.** `sqlcmd` produces *no output at all* for an empty
result set and exits 0. Treating "no output" as an error turns every empty table
into a false alarm.

**Warnings look like errors.** `sqlcmd -b` exits non-zero for warnings too, and
SQL Server reports some warnings at severity 16 — `Msg 8153, "Null value is
eliminated by an aggregate"` is the common one. Neither exit code nor severity
separates warning from error. Decide on whether a usable payload came back.

**XML methods need session settings.** `SET QUOTED_IDENTIFIER ON` and
`SET ANSI_NULLS ON` before any `.value()` call; `sqlcmd` defaults them off.

**Two invoice money columns were being lost** to CLI line-wrapping before the
base64 transport was introduced — `LocalNetTotal` among them. If you replace the
transport, keep the integrity test.

## Per-company differences to expect

Books inside one group are not kept the same way. Observed in a single group of
ten active books:

- one recognised course fees on invoice, another deferred them
- one had 100% of revenue from a single customer, another had 398 customers
- `ProjNo` and `DeptNo` were unused in **every** book, so per-project profit was
  impossible without changing how entries are posted

Ask per company rather than applying one rule across the group.
