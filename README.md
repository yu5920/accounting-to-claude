# accounting-to-claude

A Claude Skill that takes a company from *"our accounts live in an accounting
package"* to *"Claude reads the ledger and there is a dashboard the boss opens
every morning"* — **without ever being able to change a number.**

## What it does

1. Sets up a **read-only MCP server** on the machine that can reach the accounts.
2. Lets you ask questions of the real books in plain language.
3. Builds a **self-contained dashboard** — one HTML file, no server needed.
4. Schedules a daily refresh.
5. Deploys it, optionally password-encrypted, to a static host.

## Supported systems

| System | Data store | Status |
|---|---|---|
| AutoCount Accounting 2.x (desktop/server) | SQL Server | **Verified** against 21 books / ~32,000 ledger entries |
| SQL Accounting (eStream) | Firebird | Unverified — written from vendor docs |
| AutoCount Cloud, SQL Cloud, Xero, QuickBooks | Vendor-hosted | Unverified — API/export routes |

"Unverified" means exactly that: the instructions come from documentation, not
from a working install. The self-test in Step 2 is what decides whether it
works.

## Install

Download the packaged `.skill` file (or zip this folder) and upload it in Claude
under **Settings → Capabilities → Skills**.

Then just ask Claude something like *"connect my AutoCount to Claude"* and it
picks up from Step 0.

## Layout

```
SKILL.md                              the workflow, Step 0 → 6
assets/mcp-server/index.js            read-only MCP server (SQL Server + Firebird)
assets/mcp-server/selftest.mjs        14 checks: 8 guard, 6 data integrity
assets/dashboard/                     build-data → render → deploy pipeline
references/autocount-desktop.md       verified walkthrough + full schema map
references/sql-accounting-firebird.md Firebird path
references/cloud-systems.md           API / export routes
references/accounting-pitfalls.md     12 traps that produce wrong-but-plausible numbers
references/dashboard.md               building and extending the dashboard
references/budget-3d.md               R−V=G, G−F=P cost model (optional)
```

## Two things worth reading even if you never install it

**[references/accounting-pitfalls.md](references/accounting-pitfalls.md)** — a
dozen ways an accounting database returns a number that looks reasonable and is
wrong. Cancelled invoices that keep their outstanding balance. Revenue billed
into a liability account. Transfers between a company's own bank accounts
inflating both cash in and cash out. FX gains counted as sales. None of them
raise an error; the chart still draws.

**The read-only guard** in `assets/mcp-server/index.js` — comments stripped,
SELECT/WITH required, second statements rejected, `SELECT … INTO` blocked,
whole-word forbidden list, system databases refused. `selftest.mjs` tries eight
ways past it and reports ALLOWED if any gets through.

## A note on the data-corruption bug

Command-line SQL clients format output *for a terminal*: they wrap long lines
and truncate wide columns. On the reference install this ate two money columns
and split a third (`RefNo2` became `R\r\nefNo2`) and **raised no error**.

The fix is to have the database base64-encode the payload before it reaches the
CLI, since base64 has no meaningful whitespace to destroy. If you replace the
extraction path, keep the integrity test — this is the failure mode that
matters, because the dashboard still renders.

## Security

- Read-only by construction: the guard rejects anything that is not a single
  `SELECT`/`WITH`.
- No credentials ship in this repo, and `build-site.mjs` refuses to run `--lock`
  without an explicit `--id`/`--pw`. A password baked into a shared script gets
  published by whoever forgets to override it.
- `.gitignore` excludes every pipeline output. Those files hold live ledger
  entries, bank balances and customer names — they are outputs, not source.
- The encrypted static build (AES-GCM, PBKDF2-SHA256 at 310,000 iterations) puts
  ciphertext on a public host. It can be attacked offline for as long as anyone
  likes, so it is only as strong as the password.
