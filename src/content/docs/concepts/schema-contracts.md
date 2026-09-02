---
title: "Schema contracts"
description: "What columns: promises on a read, what schema_policy enforces on a write, and how on_source_drift catches a source that changed shape without either."
sidebar:
  order: 12
---

This page explains the two places pz can pin down a shape: `columns:` on a read and
`schema_policy` on a write, plus `on_source_drift` for reads that declare neither. Read it when a
source or a destination table might change shape under you, or when you hit `PZ0331`.

## What it is

A schema contract is a declared shape that pz checks instead of trusting. On the read side,
`columns:` under an [entity](/concepts/key-concepts/)'s `read:` block names every column pz
expects and its type. On the write side, `schema_policy` says how a write reconciles its own
target's existing columns. An entity that declares no read contract at all can still be watched:
`on_source_drift` compares its actual landed shape against a remembered baseline.

## Why it matters

A source that quietly adds, drops, or retypes a column can break a pipeline days after the
change actually happened, once the missing column finally gets referenced or a type mismatch
finally corrupts a value. A contract turns that into an explicit, early failure: at `pz validate
--connect` time if you run it before deploying, or at the write itself if you didn't. Without a
contract, `on_source_drift` still gives contract-less entities a way to raise a flag instead of
drifting silently forever.

## How it works

### `columns:` as a read contract

```yaml title="connections.yml"
crm:
  connector: postgres
  entities:
    orders:
      read:
        columns:
          id: bigint
          customer_id: bigint
          updated_at: timestamp
```

Each value is a DuckDB type name: `bigint`, `varchar`, `double`, `timestamp`, and so on. A
contract does two things at once: it types every column so pz never has to guess, and it prunes
the read to exactly those columns, nothing more. It also lets pz validate an incremental
[`watermark()`](/concepts/incremental-loads/) cursor ahead of time, rather than discovering at run
time that the cursor column doesn't exist or isn't an orderable type.

`columns:` is optional on most connectors, which can describe their own shape at read time. Some
connectors require it for `csv` or `json` entities: `azureblob` always, and `localfiles` when the
read falls onto the universal execution tier rather than a native DuckDB scan. `sftp` requires it
for `json`. See each connector's page under [Connectors](/connectors/) for its exact rule.

### What disagreement looks like

`pz validate --connect` fetches every declared entity's real schema and diffs it against its
`columns:` contract, for every entity at once rather than stopping at the first mismatch:

```console
$ pz validate --connect
error PZ0331: entity 'crm.orders': declared column 'region' is missing from the fetched schema
```

At run time, a contract that no longer matches the source usually surfaces as the extraction
itself failing, naming the column pz expected and couldn't find. A drift that lands on the same
underlying type, `varchar` widening to `varchar(500)`, say, can pass silently at run time and
only show up under `--connect`. Treat `--connect` as the check to run after a schema change you
suspect happened upstream, not just before a first deploy.

### `on_source_drift` for contract-less reads

An entity with no `columns:` contract can still be watched, at run time, by setting a project-wide
policy:

```yaml title="project.yml"
on_source_drift: warn   # ignore (default) | warn | fail
```

`ignore` does nothing. `warn` and `fail` compare each contract-less entity's actually landed
schema against a stored baseline, seeding that baseline silently on the first run a policy is
active. `warn` publishes a `source_drift_detected` event, prints a warning, and lets the node
succeed; the baseline does not move on its own, so the same warning repeats every run until
someone accepts it. `fail` fails the load node outright, with `PZ0331`.

`pz schema accept` promotes the latest run's observed schema into the baseline:

```console
$ pz schema accept crm.orders
crm.orders: column 'region' added
accepted 1 schema change(s)
```

It never opens a connection. It only reads the latest run's recorded schema and rewrites the
baseline, which is also why it works even when the source is currently unreachable.

### `schema_policy` on writes

A write's `schema_policy` says how the sink reconciles an existing target's columns against the
data it is about to write:

| Value | Behavior |
|---|---|
| `fail_on_change` (default) | Compares every declared column by name and type against the existing target. Any mismatch fails the write, naming the column and both types. |
| `additive` | Same comparison, but on `postgres` and `sqlserver` it also adds one specific missing column: the soft-delete marker a CDC-fed merge writes when `on_delete: soft` is set. It does not add arbitrary new columns. |
| `evolve` | Recognized, but not implemented. A sink that sees it refuses the write with a clean error rather than attempting to alter the target's shape. |

`schema_policy` only changes behavior on connectors that write into a pre-existing, typed target:
today that means `postgres` and `sqlserver`. A target that doesn't exist yet is always created
from the write's own schema, regardless of policy.

```yaml
entities:
  public.orders_current:
    write:
      strategy: merge
      keys: [order_id]
      schema_policy: fail_on_change
```

## Example

A source entity with a full read contract, feeding a merge write with the default write policy:

```yaml title="connections.yml"
entities:
  dbo.orders:
    read:
      columns:
        order_id: bigint
        customer_id: bigint
        updated_at: timestamp
    write:
      strategy: merge
      keys: [order_id]
```

With `on_source_drift: warn` set in `project.yml`, any other contract-less entity in the same
project gets the same watch for free, with no per-entity configuration.

## Errors

| Code | Meaning |
|---|---|
| [`PZ0126`](/reference/error-codes/) | `on_source_drift:` is not `ignore`, `warn`, or `fail`. |
| [`PZ0127`](/reference/error-codes/) | `pz schema accept <target>` names an entity the latest run recorded no observed schema for. |
| [`PZ0212`](/reference/error-codes/) | An incremental `cursor:` is missing from, or mistyped in, a declared `columns:` contract. |
| [`PZ0227`](/reference/error-codes/) | A SQL `watermark()` call's cursor column is missing from, or outside the allowed types in, a declared `columns:` contract. |
| [`PZ0331`](/reference/error-codes/) | A declared column is missing or retyped under `pz validate --connect`, or a contract-less entity's schema drifted under `on_source_drift: fail`. |
| [`PZ0334`](/reference/error-codes/) | `write.schema_policy` (or another `write:` key) is malformed or unrecognized. |

## Related

- [Handle schema drift](/how-to/handle-schema-drift/): the `--connect` and sink-side playbook, with SQL Server examples.
- [Detect schema drift at run time](/how-to/schema-drift/): the full `on_source_drift` and `pz schema accept` walkthrough.
- [Incremental loads](/concepts/incremental-loads/): how a `columns:` contract interacts with a `watermark()` cursor.
- [connections.yml reference](/reference/connections-yml/): every `read:` and `write:` key, including `columns` and `schema_policy`.
- [`project.yml` reference](/reference/project-yml/#on_source_drift): the `on_source_drift` key in full.
