---
title: "5. Transforming data"
sidebar:
  order: 5
---
Extraction and loading move data; **transformation** is where the value is created. It's the
step that turns "487,312 rows of raw records" into "revenue was up 4% last week, driven by
the new sourdough line." This article is about doing that reliably - which turns out to be
less about clever SQL and more about *organizing* SQL.

## What transformation actually consists of

Underneath the fancy names, transformation is a small set of verbs applied over and over:

- **Cleaning** - fixing what's wrong: trimming stray whitespace, unifying `"SHIPPED"` /
  `"shipped"` / `"Shipped"`, handling missing values, removing the duplicate rows that
  ingestion's at-least-once world allows.
- **Typing** - turning strings into real types: `"2026-03-01"` into a date, `"24.00"` into
  a number. (CSV, remember, has no types.)
- **Standardizing** - one vocabulary across sources: the shop says `customer_id`, the CRM
  says `contact_ref`; pick one name and rename at the door.
- **Joining** - connecting datasets: orders to customers, payments to orders. This is where
  data starts becoming answers.
- **Aggregating** - summarizing: revenue *by store by day*, orders *per customer*.
- **Deriving** - new facts from old: `amount - discount` as `net_amount`, a customer's
  first order date, a "weekend/weekday" flag.

## Why SQL won

You can transform data in any language, and sometimes should (heavy text parsing, ML
features). But for tabular data, SQL has quietly won, for reasons worth spelling out:

- It's **declarative** - you state the result you want ("orders joined to customers,
  summed by day"), and a highly optimized engine figures out *how*. Less code, fewer bugs.
- It's the **most shared skill in data** - the analyst, the engineer, and often the
  stakeholder's finance person can all read it. Transformation logic in SQL is logic the
  whole team can audit.
- It runs **where the data is** - inside the warehouse or engine, instead of dragging
  millions of rows into an application to loop over them.

The modern transformation layer is therefore mostly *SQL files under version control*, run
by a tool that knows their order. (dbt made this shape famous; `pz` in Part II is the same
shape.)

## One big query, and why it fails

Here's the tempting way to build Sunrise Bakery's revenue report - everything in one query:

```sql
SELECT s.store_name, DATE(o.created_at) AS day, SUM(o.amount - o.discount) AS revenue
FROM (SELECT *, ROW_NUMBER() OVER (PARTITION BY id ORDER BY updated_at DESC) rn
      FROM raw_orders WHERE status NOT IN ('cancelled','CANCELLED','Cancelled')) o
JOIN raw_stores s ON s.id = o.store_id
JOIN (SELECT DISTINCT contact_ref AS customer_id, region FROM raw_crm_contacts) c
     ON c.customer_id = o.customer_id
WHERE o.rn = 1 AND o.amount IS NOT NULL
GROUP BY s.store_name, DATE(o.created_at);
```

It works - today. But deduplication, status-cleaning, CRM renaming, joining, and aggregating
are all tangled into one artifact. When "revenue" needs a second report (by *region* this
time), you copy-paste the query, and now the cancelled-order rule lives in two places.
Six months later someone fixes it in one. Congratulations: two dashboards now politely
disagree about revenue, and nobody knows which is right.

## The layered fix

Article 3 introduced the pattern; here it is doing its job. Break the one query into small
steps, each materialized as its own table, each reading only the layer before:

<figure class="dgm">
  <a href="/diagrams/book/05-layers.png">
    <img class="dgm-light" loading="lazy" decoding="async" src="/diagrams/book/05-layers.png" alt="Raw, staging and mart layers side by side with the real table names, showing one staging table per raw table and joins and aggregates confined to the mart layer.">
    <img class="dgm-dark" loading="lazy" decoding="async" src="/diagrams/book/05-layers-dark.png" alt="" aria-hidden="true">
  </a>
  <figcaption>Click the diagram to open it full size.</figcaption>
</figure>

Each staging file is short and boring - and boring is the compliment:

```sql
-- stg_orders.sql: one row per order, cleaned. No business logic.
SELECT DISTINCT ON (id)
    id            AS order_id,
    customer_id,
    store_id,
    CAST(amount AS DECIMAL(10,2))         AS amount,
    LOWER(status)                          AS status,
    CAST(created_at AS TIMESTAMP)          AS created_at
FROM raw_orders
ORDER BY id, updated_at DESC;
```

The payoffs compound:

- **One definition, one place.** The cancelled-order rule lives in `stg_orders`. Both
  revenue marts inherit it automatically. The two-dashboards-disagree failure becomes
  structurally impossible.
- **Testability.** You can check `stg_orders` for duplicate IDs *before* anything joins to
  it (article 7 lives at these seams).
- **Debuggability.** When a number looks off, you walk the chain - is it wrong in the mart?
  In `orders_enriched`? In staging? In raw? Each hop narrows the suspect list.
- **Cheap change.** The by-region mart was a new 10-line file, not a copy-paste.

The cost is real but modest: more files, more (usually cheap) intermediate tables, and the
discipline to put logic in the *right* layer - cleaning in staging, business rules in marts,
nothing reaching backward.

## Habits that keep transformations sane

- **Name things by convention.** `stg_` for staging, plain business names for marts; the
  same key gets the same name everywhere (`customer_id`, never `cust_ref` past staging). A
  stranger should be able to guess a table's layer from its name.
- **Make transforms deterministic.** The same inputs must produce the same outputs, every
  run. The classic sin is `WHERE created_at > NOW() - INTERVAL '7 days'` - its answer
  changes by the second, reruns can't reproduce yesterday, and backfills become guesswork.
  Compute "as of when?" *once*, outside the SQL, and pass it in.
- **Rebuild, don't patch.** Each run rebuilds tables from upstream data rather than editing
  them in place. Combined with article 4's idempotent loads, this is what makes rerunning a
  failed night a non-event instead of surgery.
- **Comment the *why*.** `status <> 'test'` deserves a note about the day the staff seeded
  fake orders; the next reader can't guess that from the code.

## Where transformation runs

A last practical note: layered SQL needs an engine to run in. In warehouse-centric stacks
that's the warehouse itself. In lighter setups a tool brings its own engine - DuckDB being
the notable one: a fast analytical engine that runs inside the tool's own process, no server
to install. Data lands in it, the SQL layers run there at columnar speed, and the results are
written onward. Same layered pattern, no infrastructure. Hold that thought for Part II.

## The takeaway

- Transformation is cleaning, typing, standardizing, joining, aggregating, deriving - and
  SQL is its shared language for good reasons.
- One big query rots; small layered steps (raw → staging → marts) keep every rule defined
  exactly once, testable at the seams, and traceable when questioned.
- Determinism and rebuild-don't-patch are what make transformations safely rerunnable.
- Metrics people trust come from definitions that exist in exactly one place.

---

*Next: [6. Orchestrating pipelines](../06-orchestrating-pipelines/)*
