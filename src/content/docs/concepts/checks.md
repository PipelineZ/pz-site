---
title: "Checks"
description: "What a check is, the six check types, how they gate a run's exit code without blocking sink writes, and how to run just the checks with pz test."
sidebar:
  order: 5
---

This page explains what a check is, the six types you can declare, and what happens when one
fails. Read it when you're adding data-quality assertions to a pipeline, or when a run exits
nonzero and you need to know why.

## What it is

A check is a data-quality assertion attached to a pipeline: "this column is never null", "ids
are unique". Checks are declared in the pipeline's sidecar YAML, under `pipelines/configs/`, and
each one compiles into its own node in the dependency graph.

## Why it matters

A check runs inside the staging database, right where its pipeline's data already sits, so it is
close to free to run. Declaring checks next to the pipeline they cover, rather than in a
separate test suite, keeps the assertion and the SQL it tests in view together.

## How it works

### The six check types

| Check | Declares | Fails when |
|---|---|---|
| `not_null` | a list of columns | any listed column has a NULL |
| `unique` | a list of columns | that column group appears more than once |
| `row_count` | `min` and/or `max` | the row count falls outside the bounds |
| `freshness` | a `column` and `max_age` | the newest value in `column` is older than `max_age`, or the table is empty |
| `accepted_values` | a `column` and a list of `values` | a non-NULL value falls outside the list |
| `custom_sql` | a `name` and a `sql` query | the query returns any rows |

`custom_sql` runs its SQL verbatim against the staging database, so it queries the pipeline's own
`staging.<pipeline>` table.

### Where checks are declared

Checks live under the `checks:` key in a pipeline's sidecar config, one entry per check:

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

Only a non-ephemeral pipeline can carry checks: an ephemeral pipeline produces no node for a
check to depend on. See [Pipelines](/concepts/pipelines/) for what makes a pipeline ephemeral.

### Checks observe, they don't gate

A check node depends only on the pipeline it checks. It has no edge to that pipeline's sink
writes. That means a failing check fails the run, but does not stop the flagged rows from
landing at their destination: the check and the write are siblings, not a gate in front of a
door.

Treat a red check as an alarm on data that already shipped, not as a precondition for shipping
it. When you need an actual gate, run the checks first and only load if they pass:

```console
$ pz test && pz run
```

`pz test` runs the checks and their required ancestors, the owning pipeline and its sources,
without touching any sink. Chained with `pz run`, the load only happens behind a fully green
check pass.

### `check_samples` and per-check overrides

By default, a failing check's report includes a sample of the offending rows. The project-wide
default lives at `engine.check_samples` in `project.yml`, and any check can override it with its
own `sample_values: false`:

```yaml
checks:
  - not_null: { columns: [id], sample_values: false }
```

### Exit code

`pz run` and `pz test` exit `1` when any node fails, a failing check included, alongside a
failing pipeline or sink write. `0` means every node succeeded. See the full table in the
[CLI reference](/reference/cli/#exit-codes).

## Example

The `sqlserver` template uses all six check kinds on one pipeline:

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

Run just these checks, without touching the `mart` sink, with `pz test`.

## Related

- [Key concepts](/concepts/key-concepts/): check and node defined.
- [Pipelines](/concepts/pipelines/): the sidecar config's other keys, and what "ephemeral" rules out.
- [How a run works](/concepts/how-a-run-works/): where check nodes sit in the graph.
- [Pipeline config reference](/reference/pipeline-config/): every sidecar key, including check options.
- [CLI reference](/reference/cli/): `pz test`'s full flag list and the exit code table.
