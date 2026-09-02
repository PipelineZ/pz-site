---
title: "Tutorial: your first pipeline"
description: "Build on the quickstart's demo project by joining two sources, adding a check, making a read incremental, fixing a broken ref(), and reading the compiled execution plan."
sidebar:
  order: 4
---

This tutorial builds on the `demo` project from the [quickstart](/quickstart/). You add a
pipeline that joins two sources, attach a check and run it by itself, make a read incremental,
break a `ref()` on purpose to read the error, and preview the execution plan `pz` would use.
Each step is something you'll do again in a real project: add a transform, guard it with a
check, bound a growing source, and read a compile error instead of guessing at it. Read it once
you've run the quickstart and want to start authoring your own pipelines.

## Prerequisites

- The `demo` project from the [quickstart](/quickstart/), scaffolded with
  `pz init demo --template sample` and run once with `pz run --all`.
- Every command below runs from inside `demo/`.
- `pz validate` after each edit is cheap and catches most mistakes before a run starts. Run it
  as often as you like; the tutorial calls it out explicitly only where the output matters.

## 1. Join two sources into a new pipeline

Add a fourth entity to the `raw` connection: a CSV mapping each customer to a region. Create
`data/regions.csv`:

```text title="data/regions.csv"
customer_id,region
1,north
2,south
3,north
```

Declare it in `connections.yml`, alongside `customers` and `orders`:

```yaml title="connections.yml"
    regions:
      read:
        path: data/regions.csv
        format: csv
        columns:
          customer_id: bigint
          region: varchar
```

Now write a pipeline that joins it to the staged orders:

```sql title="pipelines/customer_regions.sql"
INSERT INTO {{ sink('lake', 'customer_regions', strategy: 'replace', format: 'csv') }}
select
    o.id as order_id,
    o.customer_id,
    o.amount,
    r.region
from {{ ref('stg_orders') }} as o
join {{ source('raw', 'regions') }} as r
  on r.customer_id = o.customer_id
```

This reads `stg_orders`'s result through [`ref()`](/concepts/pipelines/) rather than reading
`raw.orders` a second time with `source()`. A source entity can be read by exactly one pipeline,
so any other pipeline that wants order data goes through the pipeline that already reads it.
`regions` is new, so `customer_regions` is its only reader and `source()` is fine there.
`strategy: 'replace'` on the `sink()` call means this write overwrites `customer_regions`
wholesale each run, the same choice every other sink in this template already makes.

Run just this pipeline:

```console
$ pz run customer_regions
ok src_raw__regions 3 rows 10ms
ok src_raw__orders 5 rows 19ms
ok stg_orders 3 rows 2ms
ok customer_regions 3 rows 1ms
ok lake.customer_regions 3 rows 21ms
run 20260902T152705767Z-122a: 5 succeeded, 0 failed, 0 skipped (.pz/runs/20260902T152705767Z-122a/run_results.json)
```

`pz run customer_regions` runs that node plus everything upstream: the two source loads and
`stg_orders`, but not `orders_enriched` or `order_totals`, since neither feeds or depends on
this new pipeline. A [flow](/concepts/key-concepts/#flow) is exactly this: the named node plus
everything it needs and everything that needs it. Naming one node is enough to run a correct
slice of a larger project. Check the result:

```console
$ cat out/customer_regions/*.csv
order_id,customer_id,amount,region
3,1,42.0,north
5,2,15.75,south
1,1,25.5,north
```

## 2. Attach a check and run it alone

Add a sidecar config for the new pipeline with two [checks](/concepts/checks/):

```yaml title="pipelines/configs/customer_regions.yml"
pipeline: customer_regions
checks:
  - not_null: [order_id, region]
  - unique: [order_id]
```

`pz test` runs checks and their required ancestors, never a sink. It takes `--select` but no
positional flow name, so name the pipeline through a selector. A bare pipeline name selects only
that node, and a check is its descendant, so pull descendants in with a trailing `+`:

```console
$ pz test --select customer_regions+
ok src_raw__orders 5 rows 17ms
ok src_raw__regions 3 rows 9ms
ok stg_orders 3 rows 3ms
ok customer_regions 3 rows 1ms
ok check_customer_regions_not_null_order_id_region 0 rows 2ms
ok check_customer_regions_unique_order_id 0 rows 1ms
run 20260902T152716871Z-5402: 6 succeeded, 0 failed, 0 skipped (.pz/runs/20260902T152716871Z-5402/run_results.json)
```

Without the `+`, `pz test --select customer_regions` matches only the pipeline node itself, which
carries no check, so it prints `no checks defined` and does nothing. The trailing `+` pulls in
every descendant of the match, both check nodes included, plus the ancestors those checks need
to run at all: the source loads and `stg_orders` again. `pz test` writes to no sink either way,
so running it as often as you like never touches `out/`. See [Selecting
nodes](/concepts/selecting-nodes/) for the rest of the `--select` grammar, including `tag:` and
wildcard matching.

## 3. Make a read incremental

Add a fifth entity, `order_events`, with a timestamp column to serve as its cursor:

```text title="data/order_events.csv"
order_id,customer_id,amount,status,updated_at
1,1,25.50,shipped,2026-01-04T09:15:00
2,2,8.00,shipped,2026-01-05T11:02:00
3,1,42.00,returned,2026-01-06T16:40:00
4,3,5.00,pending,2026-01-07T08:00:00
5,2,15.75,shipped,2026-01-08T13:30:00
```

```yaml title="connections.yml"
    order_events:
      read:
        path: data/order_events.csv
        format: csv
        columns:
          order_id: bigint
          customer_id: bigint
          amount: double
          status: varchar
          updated_at: timestamp
```

[Incremental reads](/concepts/incremental-loads/) have two equivalent declarations: a `sync:`
block under `read:`, or a `watermark()` comparison in the pipeline's `WHERE` clause. `localfiles`
has no predicate pushdown, so a `sync:` block alone tracks the watermark without narrowing what
lands. Use the SQL form instead, which filters the rows the pipeline actually inserts:

```sql title="pipelines/orders_log.sql"
INSERT INTO {{ sink('lake', 'orders_log', strategy: 'append', format: 'csv', duplicates: 'accept') }}
select order_id, customer_id, amount, status, updated_at
from {{ source('raw', 'order_events') }}
where updated_at > {{ watermark('raw', 'order_events') }}
```

`strategy: 'append'` paired with an incremental read is at-least-once, so `pz` requires the
explicit `duplicates: 'accept'` consent. Before the first run, there's no [watermark](/concepts/key-concepts/#watermark) yet:

```console
$ pz state show
state backend: local (default)

no watermark state (.pz/state/watermarks.json is absent)
```

Run it:

```console
$ pz run orders_log
ok src_raw__order_events 5 rows 23ms
ok orders_log 5 rows 2ms
ok lake.orders_log 5 rows 24ms
run 20260902T152717469Z-06f8: 3 succeeded, 0 failed, 0 skipped (.pz/runs/20260902T152717469Z-06f8/run_results.json)
```

All five rows land, and the watermark now holds the highest `updated_at` seen:

```console
$ pz state show raw.order_events
state backend: local (default)

raw.order_events — cursor updated_at (timestamp)
  current  2026-01-08T13:30:00.000000     run 20260902T152717469Z-06f8

history (.pz/runs/*/run_results.json, newest first)
  run                          value                          run status
  20260902T152717469Z-06f8     2026-01-08T13:30:00.000000     success
```

Run it again without changing the data:

```console
$ pz run orders_log
ok src_raw__order_events 5 rows 31ms
ok orders_log 0 rows 2ms
ok lake.orders_log 0 rows 20ms
run 20260902T152718127Z-9df1: 3 succeeded, 0 failed, 0 skipped (.pz/runs/20260902T152718127Z-9df1/run_results.json)
```

The source load still scans all five rows, since `localfiles` reads the whole file either way,
but `orders_log` lands zero: every `updated_at` is now at or before the stored watermark. Add a
row with a later `updated_at` and run again to see just that row land.

The watermark only advances after every downstream write for that run commits, never before. A
run that fails partway through re-reads the same slice on its next attempt instead of skipping
it. `pz run --full-refresh` ignores the stored watermark for one run and re-establishes it from
a full extract, which is the escape hatch if `.pz/state` is ever lost or wrong. A large,
ever-growing source can also bound each run to a fixed-size slice with `max_window`; see
[Incremental loads](/concepts/incremental-loads/) for that and the full delivery-guarantee
contract behind `duplicates: 'accept'`.

## 4. Break a ref() on purpose

Introduce a typo in `customer_regions.sql`, renaming its `ref()` target so it no longer matches
any pipeline:

```sql title="pipelines/customer_regions.sql"
from {{ ref('stg_order') }} as o
```

Validate:

```console
$ pz validate
error PZ0201: pipeline 'customer_regions' calls ref('stg_order') but no pipeline named 'stg_order' exists (pipelines/customer_regions.sql)
```

`pz` never guesses which pipeline you meant. The message names the pipeline with the broken
call, the name it looked for, and the file to fix. `PZ0201` covers every unresolved `ref()` or
`source()`, so the same shape of error appears for a misspelled connection or entity name too.
This is a compile-time check: `pz validate` catches it by rendering every pipeline's template
calls and confirming each one resolves, well before any connector opens or any byte moves. See
the [error code reference](/reference/error-codes/) for the full registry, and [Validation and
errors](/concepts/validation-and-errors/) for where this check sits among the others `pz
validate` runs.

Fix the typo back to `ref('stg_orders')` and validate again:

```console
$ pz validate
validation passed (6 pipelines, 2 connections checked)
```

## 5. Preview the execution plan

`pz plan` compiles the project and shows, node by node, how `pz` would move each byte, without
running anything:

```console
$ pz plan
strategy      node                     reason
native_scan   src_raw__customers       native scan: connector 'localfiles' provides read_csv over data/customers.csv (read=full)
native_scan   src_raw__order_events    native scan: connector 'localfiles' provides read_csv over data/order_events.csv (read=incremental cursor=updated_at)
native_scan   src_raw__orders          native scan: connector 'localfiles' provides read_csv over data/orders.csv (read=full)
native_scan   src_raw__products        native scan: connector 'localfiles' provides read_csv over data/products.csv (read=full)
native_scan   src_raw__regions         native scan: connector 'localfiles' provides read_csv over data/regions.csv (read=full)
duck_sql      orders_log               duckdb sql: executes in-engine
duck_sql      product_catalog          duckdb sql: executes in-engine
duck_sql      stg_orders               duckdb sql: executes in-engine
duck_sql      customer_regions         duckdb sql: executes in-engine
duck_sql      order_totals             duckdb sql: executes in-engine
duck_sql      orders_enriched          duckdb sql: executes in-engine
native_copy   lake.customer_regions    native copy: connector 'localfiles' provides COPY TO csv
native_copy   lake.order_totals        native copy: connector 'localfiles' provides COPY TO csv
native_copy   lake.orders_curated      native copy: connector 'localfiles' provides COPY TO parquet
native_copy   lake.orders_log          native copy: connector 'localfiles' provides COPY TO csv
native_copy   lake.product_catalog     native copy: connector 'localfiles' provides COPY TO csv
memory budget: ~1.63 GB (duckdb 1.00 GB + channels 0.38 GB + overhead 256MB)
note: engine.duckdb.threads is not set (it is a different key from engine.threads, which sizes
the channel term above and does not reach DuckDB); DuckDB therefore uses the machine's core
count.
```

Three strategies appear here. `native_scan` and `native_copy` mean `localfiles` reads or writes
the file directly, no detour through the engine. `duck_sql` means the node is a pipeline or
check, executing as SQL inside the staging database. A connector without a native path for a
given format falls back to `arrow_stream`, streaming Arrow batches through the engine instead.
Notice `src_raw__order_events` reports `read=incremental cursor=updated_at`: the planner already
knows this source is bounded, even though `localfiles` can't push that bound into the file scan
itself.

The memory budget line is a ceiling on what `pz` and DuckDB may together hold in memory for this
project, not a promise the workload fits: `engine.duckdb.memory_limit` in `project.yml` sizes
the `duckdb` term, and `engine.threads` sizes the `channels` term. `pz plan` always compiles the
whole project and writes `.pz/target/plan.json`. A name, `--select`, or `--all` passed to it
only filters which rows this table prints; the written artifact always covers everything.

## Where each piece is documented

You touched five ideas in this tutorial, each with a page that goes deeper than a worked
example can:

- [Pipelines](/concepts/pipelines/): the full rules behind `source()`, `ref()`, `sink()`, and
  the one-reader-per-source-entity rule from step 1.
- [Checks](/concepts/checks/) and the [pipeline config reference](/reference/pipeline-config/):
  every check type and sidecar key, including the `row_count`, `freshness`, `accepted_values`,
  and `custom_sql` kinds this tutorial didn't use.
- [Incremental loads](/concepts/incremental-loads/): watermarks, both declaration forms, bounded
  windows, and the merge strategy that pairs with them for an effectively-once load.
- [Validation and errors](/concepts/validation-and-errors/): the tiers `pz validate` runs, and
  how to read an error like `PZ0201`.
- [How a run works](/concepts/how-a-run-works/): the phases behind `pz run` and what `pz plan`
  previews, plus the state directory `pz state show` reads from.

## Related

- [Quickstart](/quickstart/): scaffolds the `demo` project this tutorial builds on.
- [Selecting nodes](/concepts/selecting-nodes/): the full `--select` grammar behind `pz test
  --select customer_regions+`.
- [Run checks and retry](/how-to/run-checks-and-retry/): gate a run behind `pz test`, and resume
  a failed run with `pz retry`.
- [Error codes](/reference/error-codes/): every `PZ####` code, including `PZ0201` from step 4.
- [CLI reference](/reference/cli/): every flag on `pz run`, `pz test`, `pz plan`, and
  `pz state show`.
