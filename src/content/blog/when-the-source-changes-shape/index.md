---
title: "When the source changes shape"
description: "Upstream tables get columns renamed, retyped, and dropped without asking you. A columns: contract, pz validate --connect, on_source_drift, and a sink's schema_policy turn that into an early, named failure instead of a quiet one."
date: 2026-10-23
heroImage:
  dark: ./hero-dark.svg
  light: ./hero-light.svg
  alt: "The words Schema drift, above a row of column bars standing in dashed baseline outlines, one bar glowing yellow and taller than its outline where its shape has changed."
---

Nobody tells the pipeline when a source changes. An upstream team renames `amount` to
`total_amount`, or a CSV export starts quoting its prices with a currency symbol, and the next
run reads whatever is there. If nothing in the job looks at shape, the change rides along: through
the staging query, into the destination, and onto a dashboard that's been wrong for a week by the
time someone notices.

The failure you want is the opposite one: early, loud, and naming the column. pz gives you four
places to get it, and they cover different situations, so most projects end up using more than
one.

## A contract says what you expect

The most direct guard is a `columns:` contract on an entity's `read:` block, naming every column
the pipeline depends on and its type:

```yaml title="connections.yml"
crm:
  connector: postgres
  entities:
    orders:
      read:
        columns:
          id: bigint
          customer_id: bigint
          amount: double
          updated_at: timestamp
```

Each value is a DuckDB type name. A contract does more than check: it prunes the read to exactly
these columns and types each one, so pz never has to guess. A column added upstream is tolerated
and left out until you add it to the contract. A column that's removed or renamed is no longer
something the pipeline can silently read around.

At run time, a contract that no longer matches usually shows up as the extraction failing, naming
the column pz expected and couldn't find. That's already better than a wrong row, but it's still
a failure you find out about from a scheduled job.

## Ask the source before you deploy

`pz validate --connect` doesn't wait for a run. It fetches the real schema of every declared
entity and diffs it against its contract, every entity at once rather than stopping at the first
mismatch:

```console
$ pz validate --connect
error PZ0331: source 'crm' dataset 'orders': declared column 'amount' (double) is missing from the fetched schema
```

It catches one case the run itself can't. A retype that lands on the same underlying type, say
`varchar` widening to `varchar(500)`, can pass silently at run time and only show up under
`--connect`. So it's worth running whenever you suspect an upstream DDL change, not just before a
first deploy.

## Watching entities with no contract

Contracts are the right tool for tables you know well, but plenty of entities don't have one: a
quick extract, a wide table whose every column you pass through, a folder of CSV files. For those,
`on_source_drift` in `project.yml` watches the shape each run actually lands:

```yaml title="project.yml"
on_source_drift: warn   # ignore (default) | warn | fail
```

| Policy | On a changed shape |
|---|---|
| `ignore` | Nothing. No schema read, no baseline, no event. |
| `warn` | Prints a warning, publishes a `source_drift_detected` event, and the node succeeds. |
| `fail` | Fails the load node with `PZ0331`. Downstream nodes skip, so no sink writes the drifted data. |

The first `warn` or `fail` run for an entity has nothing to compare against, so it seeds a
baseline silently and succeeds. From the second run on, every load compares its landed schema to
that baseline and reports each column-level change:

```console
$ pz run --all
warning: schema drift on pg.orders (warn): retyped amount (BIGINT->VARCHAR)
ok src_pg__orders 412 rows 220ms
run 20260902T093011003Z-5d21: 3 succeeded, 0 failed, 0 skipped (.pz/runs/20260902T093011003Z-5d21/run_results.json)
```

Only entities without a `columns:` contract are checked, since a contract already pins the shape.
That includes `localfiles` and `azureblob` CSV and JSON entities, because their native scan
already infers a schema to compare.

The `source_drift_detected` event carries more than the console line. With `--log-format json`,
it lists every change as `added`, `removed`, or `retyped` with the old and new types, plus the
entity's full observed schema, so a platform consuming the event stream can alert on drift, or
accept it, without fetching anything itself.

## Accepting a change on purpose

Not every change is a mistake. Sometimes the upstream team told you, and the new shape is the
right one. The baseline never moves on its own, so a `warn` repeats every run until someone
decides. `pz schema accept` is that decision:

```console
$ pz schema accept pg.orders
pg.orders: column 'amount' retyped BIGINT -> VARCHAR
accepted 1 schema change(s)
```

It promotes the latest run's recorded schema into the baseline, and it never opens a connection.
It only reads the run's artifacts and the current baseline, so it works even while the source
that drifted is unreachable. With no argument, it accepts every entity whose latest observed
schema differs from its baseline.

## Drift and retry

Under `on_source_drift: fail`, a drifted load stops the run before anything is written, but the
data it extracted stays staged like any other failed run's. That makes the recovery cheap:

1. `pz run` fails the load with `PZ0331`.
2. `pz schema accept` updates the baseline from that run's recorded schema. No connection opened.
3. `pz retry` reuses the already-staged table instead of extracting it again.

The order matters in one direction. A retry that reuses a staged load doesn't run the drift gate
for it again, so it carries no fresh observed schema. Accept first, then retry. If you retry
first, the warning sticks around until a run extracts that entity for real.

When drift means editing a pipeline or a contract, it's a fresh run, not a retry: node ids come
from what a node does, so an edited node is no longer the one that failed.
[Retry without starting over](/blog/retry-without-starting-over/) covers why. And if the column
that changed is the incremental cursor itself, the stored watermark may no longer compare
correctly, so run once with `--full-refresh` to re-establish it from a full extract.

## The destination has a shape too

Drift isn't only a source problem. A destination table that someone altered by hand, or a
pipeline whose output columns changed, can mismatch the target just as easily. A sink's
`schema_policy` decides what happens when the data about to be written doesn't match the table
already there:

```yaml title="connections.yml"
entities:
  public.orders_current:
    write:
      strategy: merge
      keys: [order_id]
      schema_policy: fail_on_change
```

| Value | Behavior |
|---|---|
| `fail_on_change` (default) | Compares every column by name and type. Any mismatch fails the write, naming the column and both types. |
| `additive` | The same check, but it also adds the one soft-delete marker column a CDC merge writes with `on_delete: soft`. No other columns. |
| `evolve` | Recognized, but refused with a clean error. pz doesn't alter a target's shape for you. |

The check runs before any row is written, so a mismatch leaves the target exactly as it was. The
fix is deliberate too: apply the `ALTER TABLE` the error names, or drop the table and let the sink
recreate it from the write's own schema. `schema_policy` applies where a write lands in an
existing, typed table, which today means `postgres` and `sqlserver`; a target that doesn't exist
yet is always created from the data.

## Which guard for which entity

| Situation | Guard |
|---|---|
| A table the pipeline depends on column by column | `columns:` contract |
| Before a deploy, or after an upstream change you suspect | `pz validate --connect` |
| Entities with no contract, especially files | `on_source_drift: warn` or `fail` |
| An existing `postgres` or `sqlserver` target | `schema_policy: fail_on_change`, the default |

## Try it

[Guard against schema changes](/how-to/handle-schema-drift/) walks contracts, `--connect`, and
`schema_policy`, with a playbook for responding to drift. [Detect source drift at run
time](/how-to/schema-drift/) covers `on_source_drift` and `pz schema accept` step by step, and
[Schema contracts](/concepts/schema-contracts/) has the full model and every related error code.
