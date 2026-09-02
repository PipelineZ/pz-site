---
title: "Guard against schema changes"
description: "How to catch a source or target table changing shape under a running project, with a columns: contract, pz validate --connect, and a sink's schema_policy."
sidebar:
  order: 7
---

This page shows how to catch a source or destination table changing shape out from under a
running project, using a `columns:` contract, `pz validate --connect`, and a sink's
`schema_policy`. Read it before a scheduled DDL change, or after a run fails on a missing column.

For contract-less entities, and a run-time complement to the validate-time picture here, see
[Detect source drift at run time](/how-to/schema-drift/).

## Prerequisites

- A runnable project with at least one networked connection. Follow the
  [quickstart](/quickstart/) to scaffold one.

## Steps

### 1. Declare a read contract

Name every column an entity expects, and its type, under `read:`:

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

A contract prunes the read to exactly these columns and types every one, so `pz` never has to
guess. See [Schema contracts](/concepts/schema-contracts/) for which connectors require it.

### 2. Probe for drift before you deploy

`pz validate --connect` fetches every declared entity's real schema and diffs it against its
`columns:` contract, all at once rather than stopping at the first mismatch:

```console
$ pz validate --connect
error PZ0331: entity 'crm.orders': declared column 'region' is missing from the fetched schema
```

Run it after a schema change you suspect happened upstream, not only before a first deploy. A
retype that lands on the same underlying type, `varchar` widening to `varchar(500)`, say, can
pass silently at run time and only show up under `--connect`.

### 3. Choose a schema_policy for the write side

A write's `schema_policy` says how the sink reconciles an existing target's columns against the
data it's about to write. It only changes behavior on connectors writing into a pre-existing,
typed target: today that's `postgres` and `sqlserver`.

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
| `fail_on_change` (default) | Compares every declared column by name and type. Any mismatch fails the write, naming the column and both types. |
| `additive` | Same comparison, but also adds the one soft-delete marker column a CDC merge writes when `on_delete: soft` is set. It adds no other columns. |
| `evolve` | Recognized, but refused. Both `postgres` and `sqlserver` reject the write with a clean error rather than altering the target's shape. |

## Verify

Run `pz validate --connect` again after fixing a contract or aligning a target table. A clean
pass prints nothing for that entity.

## Respond to drift

1. Confirm it with `pz validate --connect`; every `PZ0331` line aggregates rather than stopping
   at the first.
2. Update the entity's `columns:` contract and any pipeline SQL that references changed columns.
3. If the drift touched the cursor column itself, renamed or retyped, the stored watermark may no
   longer compare correctly. Run once with `--full-refresh` to re-establish it from a full
   extract. A `merge`/`replace` sink stays effectively-once under re-extraction; an `append` sink
   duplicates, which is what `duplicates: 'accept'` already consents to.
4. For a `fail_on_change` failure, apply the matching `ALTER TABLE` by hand, using the types the
   error names, or drop the table and let the sink recreate it. Recreating loses target-side
   extras such as identity values.

Node ids are content-addressed: editing a source or pipeline changes its id, so a stale failed
node from before the edit isn't something `pz retry` can pick up. Run `pz run` for a full pass
after a schema-driven edit.

## Troubleshooting

| If you see | Do |
|---|---|
| `PZ0331` under `--connect` | A declared column is missing or retyped. Update `columns:`, or align the source. |
| `PZ0331` at run time on a write | The target table's columns no longer match. Apply the `ALTER TABLE` the error names, or drop and let the sink recreate. |
| An extraction query failing, naming a column | A source column was removed or renamed. Update `columns:` and any SQL that references it. |
| A write refusing `schema_policy: evolve` | Neither `postgres` nor `sqlserver` implements automatic evolution. Use `fail_on_change` or `additive` instead. |
| A retype that never surfaced until `--connect` | A retype landing on the same underlying Arrow type is invisible at run time. Run `--connect` after any suspected upstream DDL change. |
| A source column added upstream, doing nothing | This is by design: extra fetched columns are tolerated and pruned. Add it to `columns:` when you want it. |

## Related

- [Detect source drift at run time](/how-to/schema-drift/): the run-time gate for entities with
  no `columns:` contract, and `pz schema accept`.
- [Schema contracts](/concepts/schema-contracts/): the full `columns:` and `schema_policy` model,
  and every related error code.
- [Debug a failed run](/how-to/debug-a-failed-run/): reading a failed write's error message in
  full.
- [connections.yml reference](/reference/connections-yml/): every `read:` and `write:` key,
  including `columns` and `schema_policy`.
