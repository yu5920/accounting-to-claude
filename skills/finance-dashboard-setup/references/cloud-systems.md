# Cloud and hosted systems — no direct database

> **Status: UNVERIFIED.** Approach and trade-offs; no vendor API here has been
> exercised against a live tenant. Confirm the current API surface with the
> vendor's own documentation before committing to a plan.

Covers AutoCount Cloud, SQL Cloud, Xero, QuickBooks Online, MYOB, Zoho Books and
anything else where the books live on the vendor's servers.

## The constraint that shapes everything

There is no database to point a query tool at. The vendor exposes a REST API, a
report export, or both. That changes three things:

1. **You fetch, you do not query.** Pulling records and filtering locally
   replaces `WHERE`. Detail that a direct connection gives free — ledger lines,
   contra accounts — may not be exposed at all.
2. **Rate limits and pagination are real.** Thousands of transactions become
   many requests. Cache; do not re-fetch on every dashboard build.
3. **Credentials leave the machine.** OAuth tokens or API keys grant access to
   live books, often with write scope bundled in. Handle accordingly.

## Three routes, in order of preference

### A. Vendor API — best when it exists

Fetch once into the same `dashboard-data.json` the rest of the pipeline consumes,
then everything downstream is unchanged.

Steps that apply to essentially all of them:

1. Register an app in the vendor's developer portal; obtain client id/secret.
2. Complete the OAuth flow once; store the refresh token **outside the project
   folder**, in the OS credential store or a file excluded from any sync or
   version control.
3. **Request read-only scopes.** Most vendors offer them. Do not accept write
   scope for a reporting job — the guard in the direct-database path has no
   equivalent here, so scope is the only real boundary.
4. Fetch: chart of accounts, journals or ledger lines, invoices (AR and AP),
   contacts, bank transactions.
5. Write the same JSON shape `build-data.mjs` produces, and reuse
   `render-dashboard.mjs` unchanged.

Watch for: reports endpoints returning presentation-formatted figures rather
than raw records; pagination cursors that expire; sandbox tenants whose data
looks nothing like production.

### B. Scheduled export — reliable, cruder

Every accounting package can export. Many can schedule it to a folder.

1. Have the finance user export the needed reports to CSV/Excel on a schedule,
   into one folder.
2. Parse those files into the same JSON shape.
3. Everything downstream is unchanged.

Trade-offs: freshness is however often someone exports; exports are usually
summarised, so transaction-level drill-down is lost; column headings change
between versions and silently break parsing — validate structure on every run
and fail loudly rather than producing a half-empty dashboard.

### C. Hosted-desktop hybrid

Some "cloud" offerings are the desktop product on a hosted Windows machine. If
so, the database is right there and the direct path applies — install the MCP
server on that machine and follow the relevant desktop reference.

**Ask before assuming.** "Cloud" in accounting marketing covers both true
multi-tenant SaaS and hosted desktop, and they need opposite approaches.

## Vendor notes

Verify each against current documentation — API surfaces change.

| System | What to check |
|---|---|
| **AutoCount Cloud** | Whether an API exists for the tenant's plan. AutoCount's desktop line has a .NET SDK; the cloud line may differ. Ask the dealer — dealers configure most Malaysian installs and know what access is available. |
| **SQL Cloud (eStream)** | Often hosted desktop rather than SaaS. If so, route C. |
| **Xero** | Mature REST API, OAuth 2.0, read-only scopes available. Rate limited per tenant per minute and per day. |
| **QuickBooks Online** | REST API with OAuth 2.0; `Reports` and entity endpoints differ in shape — entity endpoints for drill-down. |
| **MYOB** | AccountRight has both cloud and local file APIs; which one applies depends on where the file lives. |

## Security, stated plainly

A direct read-only database connection cannot alter the books. An API token
usually can, if its scope allows.

- Request the narrowest read scope offered.
- Store tokens outside the project folder; never in the dashboard output.
- The generated `dashboard.html` embeds **data**, never credentials. Check this
  holds if you write a custom fetch step.
- Rotate anything that was pasted into a chat, a ticket or a shared document.

## What the user should expect

Set expectations early — a cloud path is usually a smaller dashboard:

| | Direct database | Cloud API | Export files |
|---|---|---|---|
| Transaction drill-down | Full | Usually | Rarely |
| Freshness | On demand | On demand, rate limited | Export cadence |
| Effort to set up | Low once reachable | Moderate — OAuth, pagination | Low but ongoing manual work |
| Can it write? | No, by construction | Only if scope allows | No |

If a cloud tenant turns out to expose only summary reports, say so before
building. A dashboard that cannot answer "which invoices make up this number"
loses its first argument in a meeting, and it is better to know that at the
start than after a week of work.
