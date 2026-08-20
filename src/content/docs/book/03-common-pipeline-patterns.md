---
title: "3. Common pipeline patterns"
sidebar:
  order: 3
---
Every pipeline answers the same four questions: *when* does data move, *how much* moves each
time, *where* does the reshaping happen, and *how do we notice changes* in the source? The
recurring answers to those questions are the patterns in this article. Learn these names and
most pipeline documentation - for any tool - starts making sense.

## Batch vs streaming: when does data move?

**Batch** means data moves on a schedule, in chunks: every night at 06:00, take everything
new and process it. Dana's Monday spreadsheet was a weekly batch. Sunrise Bakery's dashboard
needs numbers that are fresh *as of this morning* - a nightly batch is a perfect fit.

**Streaming** means data moves continuously, record by record, seconds after it's produced.
Think of fraud detection: a stolen card should be blocked *during* the transaction, not in
tomorrow's batch.

The analogy: batch is the postal service (letters accumulate, a truck comes once a day);
streaming is a phone call (every word arrives as it's spoken). Phone calls are more
immediate - and much more expensive to keep open, staff, and debug.

```mermaid
flowchart TB
    subgraph Batch["Batch - runs at 06:00"]
        B1[All of yesterday's orders] --> B2[One processing run] --> B3[Updated tables]
    end
    subgraph Streaming["Streaming - runs always"]
        S1[order #8231] --> S2[process] --> S3[update]
        S4[order #8232] --> S2
    end
```

The honest guidance: **most analytical needs are batch needs.** "Real-time" in a stakeholder
request usually means "not a week old." Ask what decision would change if the number were
five minutes fresh instead of five hours - if the answer is "none," batch wins, because
batch systems are dramatically simpler to build, test, rerun, and reason about. This series -
and `pz` in Part II - lives in the batch world.

(There's a middle ground, **micro-batching**: run a small batch every few minutes. It buys
near-freshness while keeping batch simplicity.)

## Full refresh vs incremental: how much moves?

**Full refresh** re-extracts and rebuilds everything from scratch every run. Yesterday's
result is thrown away; today's is complete.

**Incremental** moves only what changed since last time, and folds it into the existing
result.

Full refresh is the pattern you should love more than you expect to:

- It's *self-healing* - any past mistake is overwritten by the next run.
- It's *simple* - no memory of previous runs, nothing to get out of sync.
- Its only cost is size. Re-copying 50,000 orders nightly is nothing. Re-copying 500 million
  is a problem.

Incremental is the pattern you graduate to when size forces you. It needs a **cursor** (or
*watermark*): a column that tells you what's new - typically `updated_at` or an
ever-increasing ID. Each run remembers the highest value it has seen and asks the source only
for rows beyond it:

```sql
SELECT * FROM orders WHERE updated_at > '2026-07-30 06:00:00'  -- last watermark
```

```mermaid
flowchart LR
    W[Stored watermark:<br/>2026-07-30 06:00] --> Q[Extract rows<br/>updated after it]
    Q --> M[Fold into<br/>existing table]
    M --> W2[New watermark:<br/>2026-07-31 06:00]
```

Incremental's price is state. The watermark is a little piece of memory between runs, and
everything that can go wrong with pipelines-with-memory - missed rows when a clock skews,
double-counting when a run is retried, "how do I rebuild from scratch?" - becomes your
problem. articles 4 and 9 deal with exactly these. Rule of thumb: **stay full-refresh until
the runtime or the source's pain forces incremental**, and even then, keep the ability to
fall back to a full rebuild.

## ETL vs ELT: where does the reshaping happen?

Both acronyms contain the same three words - extract, transform, load - the difference is
the order of the last two:

- **ETL**: transform the data *in flight*, between source and destination, and load only the
  finished result.
- **ELT**: load the *raw* data into the warehouse first, then transform it there, with SQL,
  as a separate step.

```mermaid
flowchart LR
    subgraph ETL
        A1[Extract] --> A2[Transform<br/>in the pipeline tool] --> A3[Load results]
    end
    subgraph ELT
        B1[Extract] --> B2[Load raw] --> B3[Transform<br/>inside the warehouse]
    end
```

ELT won the last decade, for two reasons. First, warehouses became cheap and fast, and SQL is
the most widely shared data skill - transforming *in* the warehouse means analysts can read
and fix the logic. Second, keeping the raw data (article 2's landing zone) means you can
re-run transformations without re-extracting: when the revenue definition changes, you replay
the T, not the E.

In practice modern batch tools blur the line: extract, land raw data into an engine,
transform with SQL there, write results onward. That's ELT mechanics delivering an ETL-shaped
outcome, and it's exactly the shape `pz` uses in Part II.

## Change data capture: how do we notice changes?

Incremental extraction with a cursor has a blind spot: **deletes**. A cancelled order that's
deleted from the source simply stops appearing in queries - no `updated_at` value will ever
tell you it vanished. Cursor-based extraction also misses updates if the table has no
reliable `updated_at`.

**Change data capture (CDC)** solves this by reading the database's own change log - the
internal journal where the database records every insert, update, and delete (Postgres calls
its mechanism logical replication; SQL Server has change tables). Instead of asking "what's
new?", the pipeline subscribes to "what happened?":

```
insert  order 8231  (amount: 24.00)
update  order 8231  (amount: 19.00)   -- discount applied
delete  order 8102                    -- cancelled and purged
```

CDC gives you a complete, ordered story - at the cost of setup on the source database and a
consumer that must keep up with the log. It's the right tool when deletes matter, when
there's no usable cursor column, or when hammering the source with big queries is off the
table. Article 4 covers the mechanics; `pz` supports a batch-shaped version of it.

## Layered transformation: raw → staging → marts

Inside the transform step, one pattern dominates: **process data in layers**, each layer one
step more refined - like a kitchen that separates delivery, prep, and plating stations. You
may hear it as "bronze/silver/gold" or "medallion"; the names vary, the idea doesn't:

- **Raw**: exactly what the source sent, untouched. Evidence.
- **Staging**: cleaned and standardized, one table per source table - types fixed, names
  unified, duplicates removed. No business logic yet.
- **Marts**: the business-facing answers - joined, aggregated tables like
  `revenue_by_store_by_day`, shaped for dashboards.

This is the backbone of article 5, so we'll leave the details there. The pattern to register
now: each layer reads only the layer before it, which turns one tangled query into a chain of
small, testable steps.

## Backfills: running the past again

A **backfill** re-runs a pipeline over historical data: you fixed a bug in the revenue
logic, or added a new column, and now three years of history must be rebuilt. Backfills are
routine - plan for them from day one, because two properties decide whether they're an
afternoon or a disaster:

- **Idempotency**: running the same period twice must not double the numbers (article 4's
  load strategies are what make this true).
- **Bounded windows**: rebuild three years as many small slices - a month at a time - not
  one heroic query, so a failure loses minutes of progress rather than hours, and the source
  is never asked for more than it can comfortably serve.

## Choosing for Sunrise Bakery

Applying the article to our bakery: the dashboard needs morning-fresh numbers → **nightly
batch**. Orders and customers are small → **full refresh**, moving orders to
**incremental** with an `updated_at` cursor when the table grows. Analysts know SQL and raw
extracts are worth keeping → **ELT-style, layered transformation**. Cancelled orders are
deleted in the shop database and must disappear from revenue → **CDC on the orders table**,
eventually. Every choice is the boring one, on purpose.

## The takeaway

- Batch unless a real decision needs sub-minute data; freshness has a price.
- Full refresh until size hurts; incremental needs a cursor and a memory, and both can lie.
- ELT - land raw, transform with SQL - is the default modern shape.
- CDC is how you learn about deletes.
- Transform in layers; design every pipeline to be safely re-runnable, because backfills
  are a *when*, not an *if*.

---

*Next: [4. Data ingestion: extracting and loading](../04-data-ingestion-extracting-and-loading/)*
