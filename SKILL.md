---
name: accounting-to-claude
description: Connect a company's accounting software to Claude read-only, then build a finance dashboard from the real ledger. Use this whenever someone wants Claude to see their accounts, asks about AutoCount, SQL Accounting, MYOB, Xero, QuickBooks or any accounting/ERP system, wants to query their books in plain language, wants a management or board dashboard from accounting data, asks about AR ageing, cash flow, gross profit or profitability by product or project from their own ledger, or wants to automate a recurring finance report. Also use when they say the connection or the numbers look wrong and the source is an accounting database.
---

# Accounting → Claude

Take a company from "our accounts live in an accounting package" to "Claude reads
the ledger and there is a dashboard the boss opens every morning" — without ever
being able to change a number.

## What this produces

1. A **read-only MCP server** on the machine that can reach the accounting data.
2. **Plain-language questions** over the real books: ageing, margins, cash flow.
3. A **self-contained dashboard** — one HTML file, no server needed to view.
4. **Scheduled refresh** so it is current every morning.
5. **Controlled sharing** — a local URL, or an encrypted page on a static host.

Work through the steps in order. Step 2 is not optional: a query tool that
silently corrupts numbers is worse than no tool, because the charts still draw.

## Step 0 — Identify the system, then pick the route

Ask what they run, and where the data physically sits. That second part decides
everything: **if you can reach the database, do that; if you cannot, you are
working with exports or an API.**

| System | Data store | Route | Status |
|---|---|---|---|
| AutoCount Accounting 2.x (desktop/server) | SQL Server | Direct DB | **Verified** — `references/autocount-desktop.md` |
| SQL Accounting / SQL Account (eStream) | Firebird | Direct DB | Unverified — `references/sql-accounting-firebird.md` |
| AutoCount Cloud, SQL Cloud, Xero, QuickBooks Online | Vendor-hosted | API or export | Unverified — `references/cloud-systems.md` |
| Anything else on-premise | Usually SQL Server, Firebird, or MySQL | Direct DB | Try the closest driver |

Read the matching reference before touching anything. Do not guess at the
database engine — AutoCount and SQL Accounting sound similar and are completely
different underneath (SQL Server vs Firebird, `sqlcmd` vs `isql`).

**Marked "Unverified" means exactly that.** The instructions are written from
vendor documentation, not from a working install. Say so to the user, and let
Step 2 be the thing that decides whether it works — not your confidence.

## Step 1 — Connect

Everything needed is in `assets/mcp-server/`. Copy that folder to the machine
with the data, then:

```
npm install @modelcontextprotocol/sdk
```

Set the engine and its connection details as environment variables in the Claude
config (the reference for each system lists exactly which ones). Register it:

```json
{
  "mcpServers": {
    "accounting": {
      "command": "C:\\Program Files\\nodejs\\node.exe",
      "args": ["C:\\path\\to\\mcp-server\\index.js"],
      "env": { "ACCT_ENGINE": "mssql", "ACCT_SQL_INSTANCE": ".\\A2006" }
    }
  }
}
```

Then **fully quit and reopen Claude** — closing the window is not enough on
Windows, the process keeps running in the tray and the config is only read at
startup. A config change with no restart is the single most common reason
someone reports "the tools never appeared".

## Step 2 — Prove it before trusting it

```
node selftest.mjs
```

Fourteen checks in two groups, and they fail for different reasons:

- **Guard** — seven ways of smuggling a write past a SELECT, plus system
  databases. If any shows ALLOWED, stop. Do not connect it to live books.
- **Integrity** — column names intact, wide payloads clean, empty results
  distinguished from errors, non-ASCII round-tripping.

The integrity half exists because command-line SQL tools format output *for a
terminal*. They wrap long lines and truncate wide columns, which quietly
mangles results and raises no error. On a real system this ate two columns and
split a third (`RefNo2` became `R\r\nefNo2`) and nothing complained. The fix
already in `index.js` is to have the database base64-encode the payload before
it reaches the CLI, because base64 has no meaningful whitespace to destroy.

**If you write your own extraction path, keep an integrity test.** And when a
test starts passing after a change, check *why* — a test that quietly translates
one side's format to match the other's proves nothing. That happened here: a
verifier "helpfully" converted an escape sequence and made a genuinely broken
build look fine.

## Step 3 — Learn this company's books before computing anything

**Read `references/accounting-pitfalls.md` now.** It is the difference between a
dashboard and a wrong dashboard. Every trap in it was found in real data, and
each one produces a plausible-looking number rather than an error:

- cancelled invoices that keep their outstanding balance
- revenue billed into a *liability* account, so "sales" never appear as income
- transfers between the company's own bank accounts inflating both cash in
  and cash out
- foreign-exchange gains counted as operating revenue
- ageing computed from invoice date instead of due date

Then map the schema for this particular install. Use `list_tables` and
`describe_table` and confirm with small queries. Two questions decide whether
the later analysis is meaningful:

1. **Which company books are actually live?** Dormant and test books are common.
   Check the latest transaction date per book rather than assuming.
2. **Are `ProjNo` / `DeptNo` (or the local equivalent) populated?** Usually not.
   That single fact decides whether profit-by-project is possible at all — see
   Step 4.

**Ask the user how their books are kept; do not infer it.** Companies in one
group frequently differ: one recognises course fees on invoice, another parks
them in deferred revenue. Getting this wrong produces confident, wrong margins.

## Step 4 — Build the dashboard

`assets/dashboard/` holds a working pipeline. Two scripts, run in order:

```
node build-data.mjs        # query every company book, write dashboard-data.json
node render-dashboard.mjs  # turn that into a single self-contained dashboard.html
```

Open `build-data.mjs` and edit the `COMPANIES` list and the queries to match the
schema found in Step 3. That file is the only place that talks to the database;
everything downstream works off its JSON.

Two JSON files next to it hold the judgement calls, so an accountant can change
them without touching code: `cost-rules.json` (which expense accounts are
variable vs fixed, and what counts as non-operating income) and
`project-map.json` (which accounts belong to which project). Both ship with
sensible defaults and `project-map.json` ships empty — the GP-by-project topic
stays quiet until it is filled, which is the honest default.

Set `BRAND` in the environment for the company name in the header. Drop a
`review.html` beside the scripts for written commentary, and a `questions.json`
for the starter questions in the Ask panel; both are optional.

Then confirm the page still behaves:

```
node headless-check.mjs
```

It runs the page's own script against a DOM stub and asserts that filters change
what they should, drill-downs resolve, and totals tie to their own tables. It
exists to catch the failure that matters here — a page that still draws, with a
number that is now wrong.

Design decisions already made in the pipeline, and why:

- **Monthly granularity for anything that flows** (revenue, costs, billings,
  cash movements), so the page can total any date range and compare periods
  without going back to SQL. Balances and ageing stay as-at-today and are
  labelled that way, because they are positions, not flows.
- **Transactions embedded**, so every figure can be opened to the documents
  behind it. A dashboard whose numbers cannot be traced does not survive its
  first disagreement in a meeting.
- **Self-contained output** — one HTML file, viewable from a file, a local
  server, or a static host.

For layout, drill-downs and how to extend it, read `references/dashboard.md`.

**Profit by product or project.** Ask for it early, because the answer is
usually "not from this data". Revenue can normally be split by the account each
invoice line was coded to. Costs usually cannot, because nothing tags them.
Allocating shared costs by revenue share is mathematically guaranteed to give
every product the *same* margin as the company — a table that looks precise and
says nothing. Say that plainly, show what direct attribution does exist, and
offer the real fix: tag costs going forward, or split the cost accounts.

`references/budget-3d.md` covers the optional R−V=G, G−F=P cost model (variable
vs fixed cost, break-even revenue) for users who work that way.

## Step 5 — Keep it current

The refresh has to run where the database is, so use the operating system's
scheduler, not a cloud job. `assets/dashboard/daily-refresh.bat` runs the whole
pipeline and logs the result; register it for whatever times they want:

```powershell
$action  = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c `"C:\path\daily-refresh.bat`""
$trigger = New-ScheduledTaskTrigger -Daily -At "08:00"
Register-ScheduledTask -TaskName "Finance dashboard refresh" -Action $action -Trigger $trigger `
  -Settings (New-ScheduledTaskSettingsSet -StartWhenAvailable)
```

`-StartWhenAvailable` matters: it catches up after the machine was off.

`serve.mjs` serves the dashboard locally with a working refresh button, so
someone can pull fresh numbers on demand without the command line.

**Batch files must be ASCII only.** `cmd` reads them in the system code page, so
non-ASCII characters corrupt the parse in ways that look nothing like the cause
— on a real machine this silently turned `build-data.mjs` into `d-data.mjs`.
Put the local-language text in the log messages the scripts print, not in `.bat`.

## Step 6 — Share it, deliberately

Order of preference, most to least controlled:

1. **Local only** — `node serve.mjs`, viewed on the network. Nothing leaves.
2. **Static host with the payload encrypted** —
   `node build-site.mjs --lock --id <user> --pw <password>` produces `site/`
   for Netlify or similar. The data and code are AES-GCM encrypted under that
   password; without it the file is ciphertext. Verify with
   `node verify-lock.mjs <user> <password>` — it confirms the right credentials
   open it, wrong ones do not, and no plaintext leaked. There are no default
   credentials on purpose. Be straight about the limit: the ciphertext is
   public, so it can be attacked offline, and strength rests entirely on the
   password.
3. **Unprotected link** — only for genuinely non-sensitive summaries.

This is a real company's finances. Raise the exposure question yourself rather
than waiting to be asked, and let them choose.

## When something looks wrong

- **A number changed a lot between refreshes** — check the source before
  explaining it. A reclassified account or one large journal moves totals more
  than people expect.
- **A figure looks impossible** — trace it to its documents, do not reason about
  it. The pipeline embeds transactions precisely so this is a click.
- **Everything is suddenly zero** — an empty result and a failed query are
  different things. `index.js` distinguishes them; a hand-written query path
  often does not.
- **A ratio is identical across every row** — that is the signature of
  allocation, not a finding. Say so.

Report what the data shows, including when it undercuts something said earlier.
A finance dashboard that flatters is worse than none.

## Reference files

| File | Read when |
|---|---|
| `references/autocount-desktop.md` | AutoCount 2.x on SQL Server — verified, full walkthrough |
| `references/sql-accounting-firebird.md` | SQL Accounting on Firebird — unverified |
| `references/cloud-systems.md` | Cloud/hosted systems with no direct database |
| `references/accounting-pitfalls.md` | **Before computing anything.** The traps that produce wrong-but-plausible numbers |
| `references/dashboard.md` | Building, extending, and laying out the dashboard |
| `references/budget-3d.md` | Optional R−V=G cost model and break-even analysis |
