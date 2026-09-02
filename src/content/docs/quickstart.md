---
title: "Quickstart"
description: "Install pz, scaffold a runnable project from the sample template, and run it end to end in about ten minutes."
sidebar:
  order: 3
---

This quickstart takes you from an empty machine to a running pipeline in about ten minutes.
Everything happens offline against local CSV files: no Docker, no database, no network calls
after the install. Read this if you have never run `pz` before.

## Prerequisites

- The .NET 10 SDK, and `pz` installed as a global tool. See [Install pz](/install/) if you
  haven't done this yet.

Check it's on your `PATH`:

```console
$ pz --version
0.3.0
```

## 1. Create a project

```console
$ pz init demo --template sample
scaffolded a new pz project 'demo' at /home/you/demo
next steps:
  cd demo && pz run orders_enriched
  (this template ships two independent flows; `pz run --all` runs both)
```

`--template sample` scaffolds a runnable worked example instead of the empty `minimal` default:

```text
demo/
├── project.yml
├── connections.yml
├── pipelines/
│   ├── stg_orders.sql
│   ├── orders_enriched.sql
│   ├── configs/orders_enriched.yml
│   ├── order_totals.sql
│   └── product_catalog.sql
├── data/customers.csv
├── data/orders.csv
├── data/products.csv
├── .gitignore
└── README.md
```

`project.yml` holds the project's name, its declared connectors, and engine settings.
`connections.yml` declares every place the project talks to. `pipelines/*.sql` are the
transformations, one file per pipeline, named after its own file: `stg_orders.sql` is the
pipeline `stg_orders`. `data/` is the sample CSV data those pipelines read, and
`pipelines/configs/orders_enriched.yml` is a sidecar attaching two checks to one pipeline.
`pz init --list-templates` shows every starting point; see the [CLI reference](/reference/cli/#pz-init).

## 2. Look at a connection and a pipeline

`connections.yml` declares two [connections](/concepts/key-concepts/#connection): `raw`, a
folder of CSVs, and `lake`, where results land. Each [entity](/concepts/key-concepts/#entity)
under `raw` names a CSV and its column types, since CSV doesn't describe its own schema:

```yaml title="connections.yml"
raw:
  connector: localfiles
  entities:
    customers:
      read:
        path: data/customers.csv
        format: csv
        columns:
          id: bigint
          email: varchar
    orders:
      read:
        path: data/orders.csv
        format: csv
        columns:
          id: bigint
          customer_id: bigint
          amount: double
          status: varchar

lake:
  connector: localfiles
  root: out
```

`pipelines/orders_enriched.sql` uses all three template calls a pipeline needs:

```sql title="pipelines/orders_enriched.sql"
INSERT INTO {{ sink('lake', 'orders_curated', strategy: 'replace', format: 'parquet') }}
select
    o.id,
    o.amount,
    c.email
from {{ ref('stg_orders') }} as o
join {{ source('raw', 'customers') }} as c
  on c.id = o.customer_id
```

`source('raw', 'customers')` reads the `customers` entity from the `raw` connection. It resolves
to a staging table name and declares one read edge of the dependency graph.

`ref('stg_orders')` names another pipeline's result, here the `stg_orders` pipeline's filtered
orders. `pz` runs `stg_orders` first and wires the edge automatically, no separate registration.

`sink('lake', 'orders_curated', strategy: 'replace', format: 'parquet')` writes the query's
result to the `orders_curated` entity in `lake`. `strategy: 'replace'` overwrites the
destination on each run instead of appending to it.

A read or write option lives in `connections.yml` under `entities:`, exactly like `customers`
and `orders` above, or as keyword arguments on the `source()`/`sink()` call that uses it, like
`orders_curated` here. Never both: `pipelines/product_catalog.sql` shows the call-site form,
declaring its `products` read inline because it's the only pipeline that reads it. See
[Connections and entities](/concepts/connections-and-entities/) for the full rule.

## 3. Validate before running anything

```console
$ pz validate
validation passed (4 pipelines, 2 connections checked)
```

`pz validate` checks config shape, semantics, and SQL without touching any data. Run it after
every edit; it catches most mistakes before a run ever starts.

## 4. Run it

This template ships two independent flows, the orders chain and the products chain, so bare
`pz run` refuses and asks you to name one or pass `--all`:

```console
$ cd demo
$ pz run --all
ok src_raw__customers 3 rows 28ms
ok src_raw__orders 5 rows 20ms
ok src_raw__products 3 rows 7ms
ok stg_orders 3 rows 20ms
ok product_catalog 3 rows 12ms
ok orders_enriched 3 rows 14ms
ok order_totals 2 rows 14ms
ok check_orders_enriched_not_null_id_email 0 rows 3ms
ok check_orders_enriched_unique_id 0 rows 4ms
ok lake.orders_curated 3 rows 18ms
ok lake.product_catalog 3 rows 27ms
ok lake.order_totals 2 rows 1ms
run 20260819T193054712Z-04a1: 12 succeeded, 0 failed, 0 skipped
```

Every source loaded, every pipeline ran in dependency order, both data-quality
[checks](/concepts/checks/) ran inline, and all three sinks wrote.

:::tip
A failing check fails the run but does not stop its pipeline's sink write: checks observe, they
don't gate. See [Run checks and retry](/how-to/run-checks-and-retry/) if you want a check
failure to block a load.
:::

## 5. Look at the result

```console
$ cat out/order_totals/*.csv
customer_id,total
1,67.5
2,15.75
```

Each write lands under `out/`, in a directory named after its entity, because `lake` declares
`root: out` and neither sink call overrides the path. `orders_curated` is Parquet under
`out/orders_curated/`, `product_catalog` is CSV under `out/product_catalog/`, and the totals
you just read are CSV under `out/order_totals/`. A `path:` keyword on a `sink()` call would
override this for one entity, and an absolute path would ignore `root:` entirely.

## 6. See every node

```console
$ pz ls
kind       name                                     tags
source_load src_raw__customers                       -
source_load src_raw__orders                          -
source_load src_raw__products                        -
pipeline   product_catalog                          -
pipeline   stg_orders                               -
pipeline   order_totals                             -
pipeline   orders_enriched                          daily
check      check_orders_enriched_not_null_id_email  -
check      check_orders_enriched_unique_id          -
sink_write lake.order_totals                        -
sink_write lake.orders_curated                      -
sink_write lake.product_catalog                     -
```

`pz ls` prints the compiled graph in topological order. It's the lookup table for a node name
before you run `pz run <name>` or write a `--select` expression.

## Related

- [Install pz](/install/): the install step this quickstart assumes you've done.
- [Tutorial](/tutorial/): a longer walkthrough that adds a join, a check, and an incremental
  read, and fixes a broken `ref()`.
- [Key concepts](/concepts/key-concepts/): the vocabulary behind connection, entity, pipeline,
  and node.
- [Checks](/concepts/checks/): the six check types and why they don't block a sink write.
- [CLI reference](/reference/cli/): every flag and the exit code table for the commands above.
