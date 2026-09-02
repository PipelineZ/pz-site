---
title: "Detect source drift at run time"
description: "How to turn on on_source_drift for contract-less entities, read a drift warning, and promote a new shape into the baseline with pz schema accept."
sidebar:
  order: 8
---

This page shows how to turn on `on_source_drift`, a run-time gate that watches a contract-less
entity's actual landed schema for changes, and how to accept a new shape with `pz schema accept`.
Read it once you have entities with no `columns:` contract at all. For the validate-time picture
and sink-side drift, see [Guard against schema changes](/how-to/handle-schema-drift/).

## Prerequisites

- A runnable project with at least one contract-less entity: no `columns:` under its `read:`
  block. Follow the [quickstart](/quickstart/) to scaffold one.

## Steps

### 1. Turn on the policy

```yaml title="project.yml"
on_source_drift: warn   # ignore (default) | warn | fail
```

`ignore` is a true no-op: no `DESCRIBE`, no baseline read or write, no event. Only contract-less
entities are checked; one that declares `columns:` is skipped entirely, since the contract
already types and prunes the read.

### 2. Let the first run seed the baseline

The first `warn`/`fail` run for each entity has no baseline yet, so it seeds one silently from
what it observes. The node succeeds normally. From the second run on, drift detection is live.

### 3. Read a drift warning

Under `warn`, a drifted run publishes a `source_drift_detected` event, prints a console warning
naming the connection, entity, and each column-level change, and lets the node succeed:

```console
$ pz run --all
warning: schema drift on pg.orders (warn): retyped amount (BIGINT->VARCHAR)
ok src_pg__orders 412 rows 220ms
run 20260902T093011003Z-5d21: 3 succeeded, 0 failed, 0 skipped (.pz/runs/20260902T093011003Z-5d21/run_results.json)
```

The baseline doesn't advance on its own. The same warning repeats every run until it's accepted.

### 4. Accept the new shape

```console
$ pz schema accept pg.orders
pg.orders: column 'amount' retyped BIGINT -> VARCHAR
accepted 1 schema change(s)
```

`accept` promotes the latest run's recorded observed schema into the baseline. It never opens a
connection: it only reads the latest run's artifacts and the current baseline, so it works even
when the source that drifted is currently unreachable. Run it with no arguments to accept every
entity whose latest observed schema differs from its baseline.

## Verify

Run `pz run` again. A drift that's been accepted no longer prints a warning, since the baseline
now matches.

## Use fail instead of warn

Under `on_source_drift: fail`, a drifted `SourceLoad` node fails outright with `PZ0331`, naming
the entity, the changes, and `pz schema accept` as the next step. Downstream nodes skip, so no
sink ever writes drifted data. The staged table is retained like any other failed run's staging,
so the sequence is:

1. `pz run` fails a `SourceLoad` with `PZ0331`.
2. `pz schema accept` updates the baseline from that run's recorded schema. No connection opened.
3. `pz retry` reuses the already-staged table instead of re-extracting.

## Troubleshooting

| If you see | Do |
|---|---|
| `PZ0126` at load time | `on_source_drift:` is not `ignore`, `warn`, or `fail`. Fix the value in `project.yml`. |
| `PZ0331` under `fail` | A contract-less entity's landed schema no longer matches its baseline. Run `pz schema accept`, then `pz retry`. |
| `PZ0127` from `pz schema accept` | The named entity has no recorded observed schema in the latest run. Run once more under `warn`/`fail` first, or accept before retrying a run that reused staged data. |
| The same warning repeats every run | The baseline only advances when you accept it. Run `pz schema accept`. |
| A retry doesn't clear a drift warning | A `pz retry` that reuses a previously staged `SourceLoad` doesn't re-run the drift gate for that node, so it carries no fresh observed schema. Accept before retrying, or run once more without reuse. |
| An entity you didn't expect got checked | `localfiles` and `azureblob` csv/json entities with no `columns:` are covered too, since their native scan already infers a schema. |

## Related

- [Guard against schema changes](/how-to/handle-schema-drift/): the validate-time `--connect`
  picture and sink-side `schema_policy`.
- [Schema contracts](/concepts/schema-contracts/): what `columns:` and `on_source_drift` each
  cover, and where the two overlap.
- [Run events reference](/reference/events/): the full `source_drift_detected` event shape.
- [Move state off the local disk](/how-to/remote-state/): where the accepted baseline lives under
  each `state:` backend.
