# Traps that produce wrong-but-plausible numbers

Every item here was found in real books. None of them raises an error — each one
returns a number that looks reasonable and is wrong. That is what makes them
dangerous: the dashboard still draws a chart, someone still makes a decision.

Check each one against the specific install before computing anything. The
answers differ between companies, even inside one group.

## Contents

1. [Cancelled documents keep their balance](#1-cancelled-documents-keep-their-balance)
2. [Revenue billed into a liability](#2-revenue-billed-into-a-liability)
3. [Ageing from the wrong date](#3-ageing-from-the-wrong-date)
4. [Own-account transfers inflating cash flow](#4-own-account-transfers-inflating-cash-flow)
5. [Non-operating income counted as revenue](#5-non-operating-income-counted-as-revenue)
6. [Cost recharges booked as sales](#6-cost-recharges-booked-as-sales)
7. [Profit by product when nothing is tagged](#7-profit-by-product-when-nothing-is-tagged)
8. [Intercompany double counting](#8-intercompany-double-counting)
9. [The current month is incomplete](#9-the-current-month-is-incomplete)
10. [Dormant books](#10-dormant-books)
11. [Sign conventions](#11-sign-conventions)
12. [Questions to ask the user](#12-questions-to-ask-the-user)

---

## 1. Cancelled documents keep their balance

Accounting packages commonly mark a document cancelled with a flag while leaving
its amounts untouched. Sum the outstanding column without filtering and the
receivables figure is inflated by every cancelled invoice ever raised.

Observed: of 906 sales invoices in one book, 81 were cancelled — **and all 81
still carried a non-zero outstanding balance.**

```sql
WHERE Cancelled = 'F' AND Outstanding > 0
```

Check the flag's name and values for the system in hand (`'F'`/`'T'`, `0`/`1`).
Apply it to every query touching documents, not just the ageing one.

## 2. Revenue billed into a liability

Deferred or unearned revenue — course fees, deposits, subscriptions, retainers —
is invoiced into a **liability** account and only later recognised as income.

Consequences to expect:

- Billings and recognised revenue are different numbers, and both are correct.
  Showing only one hides half the business.
- A product line can bill heavily and recognise nothing in the same period, so
  it vanishes from a revenue-based analysis while its costs remain.
- Deferred revenue on the balance sheet is money already collected against work
  still owed — relevant to cash safety and to future revenue alike.

Observed: one book held RM 1.4m of deferred revenue while its recognised revenue
for the year was RM 1.7m. Ignoring it would have described the business wrongly
in both directions.

Identify these accounts by type (current liability) plus name — `UNRECOGNISED`,
`UNEARNED`, `DEFERRED`, `DEPOSIT`, `ADVANCE`. Keyword matching is a guess: show
the user the matched list and ask them to confirm it.

## 3. Ageing from the wrong date

Ageing must run from the **due date**, not the document date. Customers sit on
different payment terms, so document-date ageing reports invoices as overdue
that are not yet due.

```sql
DATEDIFF(day, DueDate, GETDATE())
```

## 4. Own-account transfers inflating cash flow

Cash flow is normally derived from bank-account entries and their contra
account. When the contra account is *itself* a bank or cash account, the entry
is money moved between the company's own accounts — no cash entered or left the
business, but it appears in both the inflow and the outflow totals.

Observed: RM 790k of a RM 5.37m gross inflow was internal movement — about 15%.

Detect it by checking whether the contra account is also flagged as a bank/cash
account, and exclude it by default. Keep the option to include it, because
reconciling against a bank statement needs the gross figure.

## 5. Non-operating income counted as revenue

Foreign-exchange gains, interest, fair-value adjustments, disposal gains and
sundry income usually sit in an income account type, so a naive "sum all income
accounts" treats them as sales.

Observed: a company appeared to have RM 495k revenue at a 35% gross margin. Once
FX gains and valuation adjustments were separated out, **operating revenue was
RM 291k and the operating gross margin was negative** — its sales commission
alone exceeded what it sold. The two readings lead to opposite decisions.

Separate these into their own line. Do not delete them — they are real income,
just not from operations.

## 6. Cost recharges booked as sales

Advertising, utilities or shared costs rebilled to a customer are sometimes
invoiced against the *expense* account, so the invoice line carries an expense
account type. Counting it as revenue overstates both revenue and margin.

Flag invoice lines coded to expense or cost accounts and show them separately.

## 7. Profit by product when nothing is tagged

This is the most common request and the most common impossibility.

Revenue usually splits fine — invoice lines carry the account they were coded
to, which typically maps to a product or service line. Costs usually do not,
because the project/department fields exist but nobody fills them.

**Check before promising anything:**

```sql
SELECT COUNT(DISTINCT ProjNo) FROM <ledger detail>
WHERE ISNULL(ProjNo,'') <> ''
```

If that returns zero — the normal case — per-product profit cannot be computed
from the data, and no amount of processing changes that.

**Allocating shared costs by revenue share does not solve it.** It is
arithmetically guaranteed to give every product the same margin as the company
overall. The table looks precise and carries no information. If you build it
anyway, display how much of the cost base is directly attributed, and warn when
that is under half.

Observed contrast, same group, same period:

- Book with 15% of costs directly attributed: every line showed ~54% margin —
  the company's own margin, repeated.
- Book with 50% directly attributed: video production 12% margin, marketing
  services 96%. That difference is the entire point of the exercise.

Real fixes, in order of quality: populate the project field going forward; or
split shared cost accounts per product; or have the user supply explicit split
ratios per account. Ask rather than assume ratios.

## 8. Intercompany double counting

In a group, companies invoice each other. Consolidated totals then count the
same money twice.

Detect candidates by matching customer names against the group's own company
names, present them as **suspected**, and let the user confirm. Never assert a
relationship from a name match alone.

## 9. The current month is incomplete

A partial month at the end of a series drags every trend line down and makes the
latest period look like a collapse. Exclude it from trend calculations and mark
it in tables.

## 10. Dormant books

Groups accumulate test, closed and superseded books. Check the latest
transaction date per book before including it — otherwise a book that stopped
three years ago dilutes every group total.

Observed: of 21 books, 5 were empty, 7 dormant since 2020–2024, and 9 active.

## 11. Sign conventions

Double-entry ledgers usually store debit and credit as separate columns rather
than a signed amount. Revenue is a credit, cost a debit:

```sql
revenue = SUM(CreditAmount - DebitAmount)   -- for income accounts
cost    = SUM(DebitAmount - CreditAmount)   -- for expense accounts
```

Confirm against a document whose value is known before building on it. Getting
this backwards produces a mirror-image P&L that still balances.

## 12. Questions to ask the user

Ask these rather than inferring. Each changes the numbers materially, and the
answers differ between companies in the same group:

1. Which books are live? Which are archives or tests?
2. Is revenue recognised on invoice, or deferred and released over time?
3. For deferred revenue: which accounts, and how is it released?
4. Which costs vary with volume, and which are fixed? (Advertising and rent are
   the usual arguments.)
5. Should non-operating income appear in operating analysis?
6. Which counterparties are related parties?
7. Are project/department fields used? If not, is starting to use them an option?

Record the answers somewhere the pipeline reads — a small JSON config beats
burying judgement calls in code, because the person who needs to change them
later is an accountant, not a programmer.
