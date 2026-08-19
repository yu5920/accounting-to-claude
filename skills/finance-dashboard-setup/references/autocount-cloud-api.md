# AutoCount Cloud Accounting — the Integration API path

> **Status: API surface verified from the vendor's own OpenAPI document
> (`/swagger/v1/swagger.json`, 58 paths, 165 schemas, retrieved 2026-08-19).
> No live tenant has been exercised yet.** What a particular tenant returns is
> settled by `cloud-probe.mjs`, not by this file.

`references/cloud-systems.md` treats every hosted system generically and lists
AutoCount Cloud as "ask the dealer whether an API exists". It does. This file
replaces the guesswork for this one vendor.

## What changes versus the desktop path

| | Desktop (`index.js`) | Cloud (`cloud-index.js`) |
|---|---|---|
| Transport | `sqlcmd.exe` on Windows | HTTPS, any OS |
| Read-only | By construction — a write is not expressible | By allowlist **and** API-key permissions |
| Ledger | `GLDTL`, every posting, one table | Reassembled from document details |
| Account balances | `GLMast` | Not exposed — must be accumulated |
| Where refresh runs | The machine holding the database | Anywhere |

The last row is the one advantage: a Mac can run the whole pipeline.

## Connection

Base URL `https://accounting-api.autocountcloud.com`. Two headers on every
request, no OAuth and no token refresh:

```
Key-ID:  <the Key ID>
API-Key: <the API Key string>
```

Requests carrying a body need `Content-Type: application/json`, and an empty
body must be `{}` rather than absent.

The key is created in the Cloud Accounting web app under
**Settings → API Keys → Create API Key**. Both values are shown there; the API
key string can be regenerated if it leaks.

## The permission list is the boundary — read this before creating the key

The same base URL serves `POST /{book}/invoice/void`,
`DELETE /{book}/journalentry` and `PUT /{book}/payment`. There are **30 POST,
14 PUT and 12 DELETE paths**. Nothing about the transport prevents a write; the
only thing that does is the per-method permission list on the key, and
**AutoCount creates keys with All Permissions enabled by default.**

So, when creating the key: **turn everything off, then enable only the Get and
Listing methods** for Company Profile, Account, Department, Debtor, Creditor,
Invoice, Purchase Invoice, Credit Note, Journal Entry, Payment (Cash Book
Entry) and Knock Off Entry. Leave every Create, Update, Delete and Void
disabled.

**"Enable only GET" is the wrong instruction, and will lock out the chart of
accounts.** `account/listing` and `product/listing` are POST-only *reads* — they
take a filter object in the body because the filter does not fit in a query
string. They create nothing. That is why the guard in `cloud-api.js` is an
allowlist of `(method, path)` pairs rather than a method check: a method check
would either block the chart of accounts or let every void through.

## The read surface

`cloud-api.js` holds the authoritative list in `READS`. In summary:

| Object | Endpoint | Notes |
|---|---|---|
| Company | `GET /{book}/companyprofile` | |
| Chart of accounts | `POST /{book}/account/listing` | `leafOnly`, `searchText`; filters by account type and special account type |
| Departments | `GET /{book}/department/listing` | |
| Customers / suppliers | `GET /{book}/debtor|creditor/listing` | |
| Sales invoices | `GET /{book}/invoice/listing` | `startDate`, `endDate`, `page` |
| Purchase invoices | `GET /{book}/purchaseinvoice/listing` | |
| Credit notes | `GET /{book}/creditnote/listing` | |
| Cash book entries | `GET /{book}/payment/listing` | payments and receipts |
| Journal entries | `GET /{book}/journalentry/listing` | see the warning below |
| Outstanding items | `GET /{book}/knockoffentry/outstandingtransactions` | `accNo`, `docDate` — the ageing basis |

Listings return `{ data: [...], totalCount }` and page from 1. No rate limit is
documented, which is not the same as there being none — `pageAll` spaces
requests by `ACCT_CLOUD_PAGE_DELAY_MS` (250ms).

## Fields that matter

**`AccountViewModel`** — `accNo`, `description`, `accType`, `specialAccType`.
Same classification the desktop schema carries in `GLMast`: `accType`
separates revenue from cost, `specialAccType` identifies bank and cash
accounts. There is **no balance field**, so a cash position has to be
accumulated from transactions rather than read off.

**`InvoiceMasterViewModel`** — carries `dueDate`, `cancelled`,
`outstandingAmount`, `debtorCode`, `localNetTotal`, `creditTerm`.
`dueDate` matters: ageing from document date instead of due date is trap 5 in
`accounting-pitfalls.md`, and this field is what avoids it. `cancelled`
addresses trap 1 — cancelled invoices keep their amounts here exactly as they
do in the database.

**Detail lines** — `InvoiceDetailViewModel`, `PurchaseInvoiceDetailViewModel`,
`CreditNoteDetailViewModel` and `CashBookEntryDetailViewModel` all carry
`accNo`, a local-currency amount and `deptNo`. `JournalEntryDetailViewModel`
carries `accNo`, `localDR`, `localCR`, `deptNo` — effectively a `GLDTL` row.

## The question that decides the whole dashboard

There is **no ledger endpoint**. AutoCount posts every document type to the GL,
but the API exposes documents, not postings. So the ledger must be rebuilt —
and the open question is whether `/journalentry` returns only hand-written
journals, or also the postings generated by invoices and payments.

- If it returns **only hand-written journals**, the ledger is
  `invoice + purchaseinvoice + creditnote + payment + journalentry` details,
  combined.
- If it **also carries document postings**, using it *and* the documents counts
  every sale twice.

Both mistakes produce a dashboard that draws perfectly well. `cloud-probe.mjs`
settles it by checking whether invoice document numbers appear among journal
document numbers in the same month, and prints a verdict either way. Do not
skip it, and do not assume the answer generalises to another tenant.

## Order of work

```
node cloud-selftest.mjs     # guard half needs no credentials - run it first
node cloud-probe.mjs        # what this tenant actually returns
node ../dashboard/build-data-cloud.mjs
node ../dashboard/render-dashboard.mjs
node ../dashboard/headless-check.mjs
```

Then cross-check one or two months against the P&L that AutoCount Cloud itself
prints. That is the only test that proves the reassembled ledger agrees with
the vendor's own view of the same books, and it is not optional.
