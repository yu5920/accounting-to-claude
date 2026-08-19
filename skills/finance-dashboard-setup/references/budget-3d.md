# The R−V=G, G−F=P cost model (optional)

A way of reading a P&L that separates cost by **behaviour** rather than by
department. Optional — skip it if the user has not asked for break-even or
variable/fixed analysis. Where it earns its place is the question
"how much do we need to sell to make X", which a conventional P&L cannot answer.

## The model

```
R  Revenue
−  V   variable cost      changes with volume
=  G   gross profit
−  F   fixed cost         does not change with volume
=  P   profit
```

Two sub-buckets each, because the management action differs:

| | Bucket | Contains | The lever |
|---|---|---|---|
| **V** | Acquisition | advertising, sales commission, affiliate/KOL, outsourced marketing | cost per customer acquired |
| **V** | Delivery | lecturers, materials, production, student/job costs | cost per unit delivered |
| **F** | Operating | salaries, rent, utilities, professional fees | the monthly floor |
| **F** | Asset | depreciation, amortisation | past investment, not this month's decision |

From those four numbers:

```
GP margin      = G / R
Break-even R   = F / GP margin
Target R       = (profit target + F) / GP margin
```

Break-even is the number people actually want. It says: below this revenue the
company loses money no matter how the month is managed.

## Why the split is by behaviour, not by department

A conventional P&L groups cost by what it is called. This one groups by what it
*does when sales change*. Salaries and advertising sit in the same "expenses"
block on a normal P&L, but cutting advertising when sales fall is arithmetic,
while cutting salaries is a different kind of decision. The V/F line is where
that difference lives.

## Configuring it

`cost-rules.json` next to the dashboard scripts. Keyword rules match account
names case-insensitively, top down, first hit wins:

```json
{
  "buckets": {
    "V_acquire": "Acquisition — happens only when you win the sale",
    "V_deliver": "Delivery — happens only when you fulfil",
    "F_operate": "Operating — the monthly floor",
    "F_asset":   "Asset — depreciation and amortisation"
  },
  "rules": [
    { "bucket": "F_asset",   "keyword": "DEPRECIATION" },
    { "bucket": "V_acquire", "keyword": "ADVERTISEMENT" },
    { "bucket": "V_deliver", "keyword": "LECTURER" },
    { "bucket": "F_operate", "acc": "700-1000" }
  ],
  "nonOperating": ["GAIN ON FOREIGN EXCHANGE", "INTEREST INCOME"]
}
```

Order matters. Put the specific rules above the general ones — `SALES COMMISSION`
before `COMMISSION`, `DEPRECIATION` before anything matching the account range it
sits in. Match by `acc` when the account name is unhelpful.

Anything unmatched falls to `F_operate`, which is the safe default: it makes
break-even look worse rather than better.

## Arguments you will have to settle

These are judgement calls, and the user has to make them. Ask; do not infer.

**Advertising.** Variable if the budget scales with sales targets. Fixed if it
is a set monthly spend regardless. Both happen, often in the same group.

**Salaries.** Usually fixed. But a delivery team hired per project is variable
in substance even though payroll pays it. Same for commission-heavy sales pay.

**Rent.** Fixed — until the business adds a location per volume tier, and then
it steps rather than sliding. Note the step; do not average it away.

**Depreciation.** Separated into its own bucket because it is not a cash cost
and not this month's decision. Break-even including it and excluding it are both
useful and answer different questions.

## Where the model quietly breaks

**Mixed accounts.** One account holding both a fixed retainer and variable
piecework cannot be classified correctly by any rule. Splitting the account in
the accounting system is the only real fix; until then, note which accounts are
mixed and how large they are.

**Semi-variable costs.** Utilities have a base charge plus usage. If the account
is material, split it; if not, put it in fixed and move on.

**Break-even on a company with deferred revenue.** Revenue recognised this month
may relate to costs incurred months ago. Break-even computed from a single month
is then meaningless. Use a period long enough to cover the delivery cycle.

**Break-even at group level.** Only meaningful if the companies share a cost
base. Usually they do not, and the group figure is an average of unlike things.
Compute it per company.

## Extending to project or product level

The same R−V=G split, one column per project, using `project-map.json`.

This is where honesty matters more than completeness. Read
[the profit-by-product trap](accounting-pitfalls.md#7-profit-by-product-when-nothing-is-tagged)
before building it — allocating shared cost by revenue share is arithmetically
guaranteed to hand every project the company's own margin, producing a table
that looks precise and contains nothing.

The dashboard therefore shows **what share of cost is directly attributed** next
to the per-project table, and warns below 50%. Keep that. It is the difference
between a real finding and a decorated average.

Observed, same group, same period:

- 15% directly attributed → every line came out near 54%, the company margin.
- 50% directly attributed → video production 12%, marketing services 96%.

The second one is a business decision. The first one is arithmetic wearing a
table.

## What to say when presenting it

Give the break-even figure with its assumption attached: *"break-even is
RM X per month, if advertising is treated as variable and depreciation is
included."* Change either assumption and the number moves a long way. A
break-even quoted without its assumptions gets used as if it were a fact.
