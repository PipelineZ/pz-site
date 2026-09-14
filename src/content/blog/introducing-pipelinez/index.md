---
title: "Introducing PipelineZ"
description: "Why we built pz: a lightweight, SQL-based batch pipeline engine powered by DuckDB, for the pipelines that don't need a whole data platform."
date: 2026-09-14
heroImage:
  src: ./hero.png
  alt: "An 'Introducing PipelineZ' illustration: a source database flows into a chip labeled DuckDB, which flows out to a destination database."
---

Welcome to the pz blog. This is the first post, so it's the obvious one to write: what pz
actually is, why it exists, and how to try it.

## Most pipelines are just a few SQL queries

A lot of "we need a data pipeline" starts out modest: pull yesterday's orders, join them
against a customer table, load the result somewhere a dashboard can read it. That's three or
four SQL statements. But by the time it's running reliably, it's often grown a scheduler, a
container image, a warehouse account, and a service the team now has to keep patched — because
the tools built for that job assume you also want the platform underneath it.

Sometimes you do want that platform. If you're coordinating hundreds of pipelines across a
data org, [Airflow](https://airflow.apache.org/) or a managed warehouse's own orchestration
earns its keep. But plenty of teams — and plenty of solo projects — never get there. They just
need the three SQL statements to run on a schedule, fail loudly when the data looks wrong, and
not lose an afternoon to setup first.

pz is for that second case.

## What pz actually does

pz is a command-line engine that moves data in batches. You write your project as SQL files
plus one YAML file describing where data comes from and goes:

```sql title="pipelines/orders_enriched.sql"
INSERT INTO {{ sink('lake', 'orders_curated', strategy: 'replace', format: 'parquet') }}
SELECT
    o.id,
    o.amount,
    c.email
FROM {{ ref('stg_orders') }} AS o
JOIN {{ source('raw', 'customers') }} AS c
    ON c.id = o.customer_id
```

```yaml title="connections.yml"
raw:
  connector: localfiles
  entities:
    customers:
      read:
        path: data/customers.csv
        format: csv

lake:
  connector: localfiles
  root: out
```

`pz run` reads those files, compiles them into a dependency graph from the `source()`, `ref()`,
and `sink()` calls, and hands execution to [DuckDB](https://duckdb.org/). There's no separate
service to deploy and no warehouse to provision first — DuckDB runs in-process, so the whole
thing works on your laptop, in CI, or as a scheduled job wherever you can run a binary.

A few things follow from that shape:

- **The pipeline is the diff.** SQL and YAML are text your team already reviews like any other
  change. A join that goes wrong, or a load strategy that quietly switches from `merge` to
  `replace`, shows up in a pull request instead of in next week's numbers.
- **Correctness is part of the graph, not an afterthought.** [Checks](/concepts/checks/) are
  assertions that run inside the same dependency graph and can gate what gets written, so bad
  data fails the run instead of landing in the sink.
- **Incremental loads are a first-class case**, not a pattern you rebuild per pipeline —
  watermarks, bounded windows, and merge strategies are covered by
  [Incremental loads](/concepts/incremental-loads/).
- **Connectors are pluggable.** Local files today, and the [connector](/connectors/) list is
  where sources and sinks beyond `localfiles` live as they're added.

None of this requires believing pz is the right tool for every pipeline. It's the right tool
when the honest answer to "do we need a platform for this" is no.

## Try it

The fastest way to see this land is the [quickstart](/quickstart/) — a real project running in
about ten minutes. From there, the [tutorial](/tutorial/) builds one up step by step, and
[key concepts](/concepts/key-concepts/) covers the vocabulary this post used without
stopping to define.

If pipelines in general are newer territory for you, [Data Engineering Introduction](/book/)
is a ten-part series that starts from "what is a data pipeline" and ends by mapping every idea
it covers onto pz specifically.

We'll use this blog for the things that don't fit a docs page — design decisions, what we're
building next, and notes from actually running pz. More soon.
