---
title: "Pipelines"
description: "How a single SQL file becomes a pipeline: source(), ref(), and sink() calls, the sidecar config, materialization, and the template values available inside SQL."
sidebar:
  order: 4
---

This page explains what a pipeline is, how its SQL builds the dependency graph, and what the
optional sidecar config controls. Read it before writing your first `.sql` file, or when you
need to know what `ref()`, `source()`, or `sink()` actually do.

## What it is

A pipeline is one `.sql` file under `pipelines/`, named after its file. `stg_orders.sql` is the
pipeline named `stg_orders`. There is no YAML frontmatter and no separate registration: every
`.sql` file in that directory is a pipeline.

## Why it matters

A pipeline's SQL is the whole story: what feeds it, what it computes, and where it loads,
in one file. `pz` never parses your SQL to work out dependencies. It watches which template
calls fire while rendering the file, and that is the entire mechanism behind the dependency
graph.

## How it works

### `source()` and `ref()` build the graph

Inside the `FROM` clause, `source('conn', 'entity')` names a loaded entity and `ref('pipeline')`
names another pipeline's result. Each call resolves to a real staging table name and declares
one edge of the dependency graph. `pz` never guesses an edge by parsing SQL: if a call doesn't
name it, it isn't a dependency.

```sql title="pipelines/orders_enriched.sql"
select
    o.id,
    o.amount,
    c.email
from {{ ref('stg_orders') }} as o
join {{ source('raw', 'customers') }} as c
  on c.id = o.customer_id
```

### `INSERT INTO {{ sink(...) }}` is the load

A pipeline that writes its result somewhere leads with `INSERT INTO {{ sink('conn', 'entity',
...) }}`, carrying that write's options as keyword arguments. This must be the pipeline's
leading statement, on one line: `pz`'s template engine ends a statement at the newline, so a
`sink()` call split across lines is a parse error.

```sql title="pipelines/order_totals.sql"
INSERT INTO {{ sink('lake', 'order_totals', strategy: 'replace', format: 'csv') }}
select customer_id, sum(amount) as total
from {{ ref('stg_orders') }}
group by customer_id
```

`pz` strips that `INSERT INTO` prefix at compile time. Execution stages the query's result into
`staging.<pipeline>` first, then a separate step drains it to the destination, never direct DML
against the destination. One transform can feed several sinks by listing several `sink()`
markers in an array inside the same `INSERT INTO`.

### A pipeline with no sink is an intermediate

A pipeline that never calls `sink()` still materializes: it produces its own `staging.<name>`
table by default, and stays valid as long as another pipeline consumes it via `ref()`. This is
what most projects call an intermediate step, such as `stg_orders` staging a raw entity before
`orders_enriched` joins it.

Going further, a sidecar config can set `materialization: ephemeral` on a pipeline. An ephemeral
pipeline is inlined as a CTE into every pipeline that `ref()`s it, instead of getting its own
node in the graph. Because it never gets a node, an ephemeral pipeline cannot call `sink()`,
cannot declare checks, and cannot `ref()` another ephemeral pipeline.

### The sidecar config

An optional YAML file under `pipelines/configs/`, matched to its pipeline by the `pipeline:` key
inside it, sets materialization, tags, and data-quality checks:

```yaml title="pipelines/configs/orders_enriched.yml"
pipeline: orders_enriched
materialization: table
tags: [daily]
checks:
  - not_null: [id, email]
  - unique: [id]
```

`materialization` is `table` (the default), `view`, or `ephemeral`. `tags` are free-form labels
you can select on with `pz run --select`. See [Checks](/concepts/checks/) for the six check
types, and [Pipeline config reference](/reference/pipeline-config/) for every sidecar key.

### DuckDB runs the SQL

Every pipeline's `SELECT` executes against the run's staging database, an embedded DuckDB file
created fresh for each run. Reads have already landed their entities there; `ref()`'d pipelines
have already materialized there. A pipeline's SQL is plain DuckDB SQL once the template calls
resolve, so anything DuckDB's dialect supports is fair game.

### Values available inside SQL

Beyond `source()`, `ref()`, and `sink()`, a pipeline's SQL can call `watermark()` for
incremental reads, `var('name')` for a project variable, and `env('NAME')` for an environment
variable declared in `project.yml`. `this`, `run_id`, and `run_started_at` are injected
constants: `this` is the pipeline's own staging table name, and `run_started_at` is one
timestamp shared by every render in the run, so repeated renders stay stable. The full signature
of each function is in the [template function reference](/reference/template-functions/).

## Example

The `sample` template's three pipelines show the whole pattern: a staging pipeline with no sink,
a pipeline that `ref()`s it and joins a `source()`, and an aggregation that both `ref()`s and
sinks in one file.

```sql title="pipelines/stg_orders.sql"
select
    id,
    customer_id,
    amount,
    status
from {{ source('raw', 'orders') }}
where amount >= {{ var('min_amount') }}
```

```sql title="pipelines/product_catalog.sql"
INSERT INTO {{ sink('lake', 'product_catalog', strategy: 'replace', format: 'csv') }}
select id, name, price
from {{ source('raw', 'products', path: 'data/products.csv', format: 'csv',
    columns: { id: 'bigint', name: 'varchar', price: 'double' }) }}
```

## Related

- [Key concepts](/concepts/key-concepts/): pipeline, node, and run defined.
- [Connections and entities](/concepts/connections-and-entities/): the other half of `source()`/`sink()`.
- [Checks](/concepts/checks/): the sidecar `checks:` key in depth.
- [Incremental loads](/concepts/incremental-loads/): `watermark()` and bounded reads in SQL.
- [Template function reference](/reference/template-functions/): every function's full signature.
