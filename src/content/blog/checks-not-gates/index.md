---
title: "Checks, not gates"
description: "A check is a data-quality assertion that runs inside the same dependency graph as your pipeline, close enough to free to run. It observes, it doesn't block, unless you tell it to."
date: 2026-09-14
heroImage:
  dark: ./hero-dark.svg
  light: ./hero-light.svg
  alt: "The words Checks, not gates, next to a large translucent PipelineZ Z-mark watermark."
---

The instinct with data quality is to bolt on a separate test suite: a different tool, a
different schedule, a different place to look when something's wrong. pz takes a smaller step:
a check is a data-quality assertion attached to a pipeline, declared right next to it, that
compiles into its own node in the same dependency graph the pipeline already runs in.

## Six check types, one place to declare them

Checks live under the `checks:` key in a pipeline's sidecar config:

```yaml title="pipelines/configs/orders_current.yml"
pipeline: orders_current
checks:
  - not_null: [order_id, status]
  - unique: [order_id]
  - row_count: { min: 1 }
  - freshness: { column: updated_at, max_age: 24h }
  - accepted_values: { column: status, values: [pending, shipped, delivered] }
  - custom_sql:
      name: no_negative_amounts
      sql: select * from staging.orders_current where amount < 0
```

`not_null`, `unique`, `row_count`, `freshness`, and `accepted_values` cover most of what a table
needs asserted about it. `custom_sql` is the escape hatch: it runs verbatim against the staging
database, so anything expressible as "this query returns zero rows" is a check.

A check runs inside the staging database, right where its pipeline's data already sits. There's
no export step, no separate connection, no second copy of the row to keep in sync. That's what
makes it close to free to run.

## Checks observe, they don't gate

Here's the part that surprises people coming from a test suite: a check node depends only on
the pipeline it checks. It has no edge to that pipeline's sink writes. A failing check fails the
run, but it does not stop the flagged rows from landing at their destination. The check and the
write are siblings, not a gate in front of a door.

Treat a red check as an alarm on data that already shipped, not as a precondition for shipping
it. That's a deliberate choice: checks that are always siblings, never gates, means a check can
never accidentally deadlock a pipeline on a query that used to work and now returns one
unexpected row.

When you actually want a gate, ask for one explicitly:

```console
$ pz test && pz run
```

`pz test` runs the checks and their required ancestors, the owning pipeline and its sources,
without touching any sink. Chained with `pz run`, the load only happens behind a fully green
check pass.

## What a failure looks like

By default, a failing check's report includes a sample of the offending rows, so you're not
left re-deriving what tripped it from a boolean. The project-wide default lives at
`engine.check_samples` in `project.yml`, and any check can turn it off on its own:

```yaml
checks:
  - not_null: { columns: [id], sample_values: false }
```

`pz run` and `pz test` both exit `1` when any node fails, a failing check included, right
alongside a failing pipeline or sink write. The exit code tells you something went wrong; the
console output and the sample rows tell you what.

## Try it

[Checks](/concepts/checks/) covers the full sidecar config shape and the exit code table. The
`sqlserver` [quickstart](/quickstart/) template uses all six check kinds on one pipeline, so you
can see a real one fail and read the sample it prints.
