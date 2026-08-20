# Building and extending the dashboard

**Status: verified.** This pipeline runs daily against 10 live company books.

## The pipeline

```
accounting DB  →  build-data.mjs  →  dashboard-data.json
                                        ↓
                  render-dashboard.mjs  →  dashboard.html      (open directly)
                                        ↓
                  build-site.mjs --lock →  site/index.html     (static host)
```

Each step reads a file and writes a file, so any of them can be re-run alone
while debugging. Only `build-data.mjs` talks to the database.

| File | Role |
|---|---|
| `build-data.mjs` | **Edit this first.** Company list + every SQL query |
| `render-dashboard.mjs` | Data → one self-contained HTML file |
| `cost-rules.json` | Which expense accounts are variable vs fixed |
| `project-map.json` | Which accounts belong to which project/product |
| `review.html` *(optional)* | Written commentary shown in the AI Review panel |
| `questions.json` *(optional)* | Starter questions in the Ask panel |
| `serve.mjs` | Local server on :8787 with a working refresh button |
| `build-site.mjs` | Static-host build, optionally password-encrypted |
| `verify-lock.mjs` | Proves the encrypted build actually locks |
| `headless-check.mjs` | Runs the page's own script in Node and asserts ~45 behaviours |
| `daily-refresh.bat` | The whole chain, for Task Scheduler |

## Step 1 — Point it at the right books

Edit `COMPANIES` in `build-data.mjs`. `db` is what `list_companies` returned;
`short` is the label everywhere else and the key `project-map.json` uses.

Then work through the queries. They are written for AutoCount's schema
(`GLDTL`, `ARInvoice`, `GLMast.SpecialAccType`) — on any other system these are
the lines that change. The shape they must return is what matters:

- **Flows** (revenue, expenses, cash movements, billings) come back **monthly**:
  `{acc, name, m: {"2026-01": 1234, ...}, total}`.
- **Positions** (bank balances, AR/AP ageing, liabilities) come back **as at
  today**, and the page labels them that way.

That split is deliberate. Because flows are stored per month, the page can total
any date range, compare against last year, and rebuild every chart **without
going back to SQL** — which is what makes the date controls instant and lets the
whole thing work as a static file.

## Step 2 — Set the accounting judgement calls

Two JSON files hold decisions that belong to an accountant, not to code. Both
are read at render time, so changing one and re-running `render-dashboard.mjs`
takes seconds — no database round trip.

**`cost-rules.json`** — keyword rules sorting expense accounts into variable
(`V_acquire`, `V_deliver`) and fixed (`F_operate`, `F_asset`), plus the
`nonOperating` list that keeps FX gains and interest out of operating revenue.
Rules match top-down, first hit wins. See `budget-3d.md`.

**`project-map.json`** — revenue account → project, and cost account → project
(or a weight object splitting one account across several). Ships empty; the
GP-by-project topic simply stays quiet until it is filled.

Show the user the matched lists and have them confirm. Keyword matching is a
guess, and a wrong guess here moves the margin.

## Step 3 — Build and check

```bash
node build-data.mjs && node render-dashboard.mjs && node headless-check.mjs
```

`headless-check.mjs` executes the page's real script against a DOM stub and
asserts that topics render, filters change the figures they should change, sort
and paging work, and drill-downs resolve. It catches the failure mode that
matters: a page that still draws, with a number that is now wrong.

## What the page contains

Twelve topics in a left rail, one visible at a time:

| Topic | What it answers |
|---|---|
| Overview | Are we making money, and is cash going up or down |
| P&L | Consolidated and per-project, L1 summary → L2 detail |
| Cash Flow | Monthly in and out, by counterparty account |
| Receivables / Payables | Ageing by due date, who and how overdue |
| Customers | Concentration — what happens if the biggest one leaves |
| Cost structure | R−V=G, G−F=P and break-even |
| GP by project | Margin per product line, with attribution honesty |
| Service lines | Revenue split by account |
| Liabilities | Including deferred revenue |
| Alerts | Cash, concentration, ageing, anomalies |
| Data source | Which book, which table, which query |

Above them: company selector, date range, and a comparison toggle
(off / last year / month-by-month).

### Every figure opens

Clicking a number opens the documents behind it. This is the feature that
decides whether the dashboard survives contact with a management meeting — the
first question is always "where does that come from", and a dashboard that
cannot answer it loses the argument regardless of whether it was right.

It is also why transactions are embedded in the HTML rather than fetched. A
static file with no server can still drill down.

Keep this property when adding anything. A new figure with no path to its
source is a regression.

### The Data Source topic

Names the database, table and query behind each block. Cheap to maintain and it
ends the "where did this come from" conversation permanently.

### The AI Review panel

Written commentary, from `review.html`, embedded at build time and stamped with
its date. Kept visually separate from the computed figures because it is dated
judgement — a published page cannot reach the database or call a model, so it
cannot refresh with the rest.

Regenerate it when the numbers move materially, not on every build.

## Extending it

To add a topic:

1. Add the data to `build-data.mjs` — monthly if it flows, as-at if it is a
   position.
2. Add an entry to `TOPICS` in `render-dashboard.mjs`.
3. Write a `viewX(list, months, cm)` function returning HTML. `list` is the
   selected companies, `months` the selected range, `cm` the comparison mode.
4. Give every figure a drill-down.
5. Add a check to `headless-check.mjs`.

## Things that bit, and now have tests

**Totals that disagree with their own table.** A table filtered to positive
amounts while its header summed net — a reversal existed, so the two differed
by exactly one entry. Filter the table and the header the same way, and label
reversals rather than hiding them.

**A test that measured the wrong thing.** A preset-range test scraped a number
by regex and matched verdict text instead of the figure. It passed while the
feature was broken. Read the named element, and assert the value actually
*differs* between the two states.

**A test that translated one side to match the other.** A verifier hand-decoded
an escape sequence, so a genuinely broken build passed. If a test transforms
data before comparing, ask what that transformation is hiding.

**Non-ASCII in a `.bat` file.** `cmd` reads batch files in the system code page;
one Chinese character corrupted the parse and turned `build-data.mjs` into
`d-data.mjs`. Keep `.bat` ASCII; put local-language text in what the scripts
print.

## Serving and sharing

```bash
node serve.mjs
```

Serves the dashboard on http://localhost:8787 with a working refresh button —
`serve.mjs` injects a flag the page checks. From a static host the same button
hides itself, because there is nothing to call.

For a static host:

```bash
node build-site.mjs --lock --id someone --pw "a long passphrase" --brand "COMPANY"
```

`--lock` lifts the data and the app out of the page and replaces them with
AES-GCM ciphertext, unlocked by PBKDF2-SHA256 (310,000 iterations) over the
password. Then confirm it actually locked:

```bash
node verify-lock.mjs someone "a long passphrase"
```

That checks the right credentials open it, wrong ones do not, and no plaintext
survived in the file.

Say the limit out loud when you hand it over: **the ciphertext is public, so it
can be attacked offline for as long as anyone likes.** Everything rests on
password strength. There are no default credentials in these scripts on purpose
— a password baked into a shared script gets published by whoever forgets to
override it.

`crypto.subtle` needs a secure context, so the locked page works over https or
localhost but **not** from `file://`. Test it where it will actually live.
