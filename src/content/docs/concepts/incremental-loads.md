---
title: "Incremental loads"
description: "Full refresh versus incremental reads, the sync block's three modes, bounded windows for backfilling, and the merge write strategy that makes re-extraction safe."
sidebar:
  order: 6
---

This page explains how `pz` reads only what changed since the last run: watermarks, the three
`sync` modes, bounded windows, and the `merge` write strategy that pairs with them. Read it
before making an entity incremental, or when you need to backfill or capture deletes.

## What it is

A **full refresh** read extracts everything, every run. An **incremental** read extracts only
what's new since the last run, tracked by a stored **watermark**: the highest value of a cursor
column already seen. `pz` supports three ways to declare incrementality, all under one `sync:`
key on an entity's `read:` block.

## Why it matters

Re-reading a whole table or file set every run wastes time and load on the source, and it grows
without bound as history accumulates. Incremental reads keep each run's cost proportional to
what changed, not to total history, as long as the write side can absorb re-extraction safely.

## How it works

### Declaring `sync: { mode: incremental }`

An entity opts in with `sync: { mode: incremental, cursor: <column> }` under its `read:` block:

```yaml
entities:
  public.orders:
    read:
      columns:
        id: bigint
        updated_at: timestamp
      sync:
        mode: incremental
        cursor: updated_at
```

Each run reads the stored watermark, asks the connector to extract only rows past it, then
captures a new watermark as the maximum cursor value landed and advances the stored value. That
advance is commit-gated: if any downstream write fails, the watermark does not move, so a retry
re-reads rather than skipping data.

:::note
Only a connector with predicate pushdown (postgres, sqlserver) narrows the extraction itself. A
file connector such as `localfiles` lands every row and leaves the cut to your pipeline, so pair
a `sync:` block on such an entity with a `watermark()` comparison in the SQL, as shown next.
:::

### `{{ watermark() }}` in SQL

The same comparison can live directly in a pipeline's `WHERE` clause instead of in YAML, using
`watermark('<connection>', '<entity>')`:

```sql title="pipelines/orders_log.sql"
INSERT INTO {{ sink('lake', 'orders_log', format: 'parquet', strategy: 'append', duplicates: 'accept') }}
select order_id, customer_id, amount, status, updated_at
from {{ source('raw', 'orders') }}
where updated_at > {{ watermark('raw', 'orders') }}
```

`watermark()` takes the connection name and entity name and renders the stored cursor value, or
`NULL` on an entity's first run. This is the SQL-declared form of the same mechanism: the `.sql`
file names the whole story, extract through load, including that the read is incremental. An
entity is declared incremental either in YAML or through `watermark()` in SQL, never both.

### Bounded windows: `max_window`, `initial`, `until`

Add these keys alongside `cursor:` to bound each run to a fixed-size slice instead of one
unbounded `cursor > watermark` read:

| Key | Meaning |
|---|---|
| `max_window` | each run extracts at most this many cursor units past the watermark |
| `initial` | where the first run's window starts |
| `until` | optional: the cursor value past which the entity is considered caught up |

This is what makes a large backfill safe: instead of one huge extract, each `pz run` moves one
bounded slice, and repeating the command drives the backfill forward. See [Backfill in
slices](/how-to/backfill-in-slices/) for the full walkthrough, including how to loop `pz run`
until the backfill catches up.

### `mode: cdc`

Change data capture reads inserts, updates, and deletes from the source's own change log,
instead of comparing an ordered cursor column. It needs no `cursor:` at all:

```yaml
entities:
  public.orders:
    read:
      sync:
        mode: cdc
        # slot: pz_crm_orders   -- postgres only; default pz_{connection}_{entity}
```

Postgres CDC reads a logical-replication publication; SQL Server CDC reads the server's own
change tables through a capture instance. Both need server-side setup done ahead of time, and a
cdc-fed write must use `strategy: merge` with an explicit `on_delete` policy. See [Capture
changes with CDC](/how-to/capture-changes-with-cdc/) for the prerequisites, the `slot`,
`publication`, and `capture_instance` options, and `on_delete`'s three modes.

### `mode: auto`

An entity with no `sync:` block, or an explicit `mode: auto`, reads with whatever mechanism the
connector manages on its own: an opaque, connector-owned continuation token such as a
change-feed delta link, stored verbatim instead of a comparable cursor value. This is the shape
an HTTP API with its own pagination cursor typically uses.

### `strategy: merge` and re-extraction

Pairing an incremental or windowed read with `strategy: replace` or plain `append` risks
duplicating or losing rows across run boundaries. `strategy: merge` upserts on a set of `keys:`,
so re-extracting the same slice converges on the same rows instead of duplicating them:

```sql
INSERT INTO {{ sink('mart', 'mart.orders_current', strategy: 'merge', keys: ['order_id']) }}
select order_id, customer_id, amount, status, updated_at
from {{ source('erp', 'dbo.orders') }}
where updated_at > {{ watermark('erp', 'dbo.orders') }}
```

An append sink fed by an incremental read is legal, but it is at-least-once: a replayed run can
re-deliver a slice, so `pz` requires you to consent with `duplicates: 'accept'`, correct for a
delta log you plan to deduplicate downstream. A cdc-fed merge additionally needs `on_delete` to
say how a source-side delete is applied: `delete` removes the row, `soft` stamps a
`_pz_deleted_at` column, and `ignore` drops deletes entirely.

### `--full-refresh`

`pz run --full-refresh` ignores every stored watermark and sync-state token for the run and
extracts everything. Capture and advancement still run, so watermarks are re-established from
the full extract rather than left stale. On a windowed entity, this also resets the window back
to `initial`.

## Example

The `incremental` template's single pipeline declares its incremental read entirely in SQL, with
no `sync:` block in `connections.yml` at all:

```sql title="pipelines/orders_log.sql"
INSERT INTO {{ sink('lake', 'orders_log', format: 'parquet', strategy: 'append', duplicates: 'accept') }}
select order_id, customer_id, amount, status, updated_at
from {{ source('raw', 'orders') }}
where updated_at > {{ watermark('raw', 'orders') }}
```

Run it twice: the first run lands every row, and the second lands nothing, because the stored
watermark has advanced past every row's `updated_at`. The `sqlserver` template shows the merge
half of the same mechanism, pairing an incremental read with a keyed `strategy: merge` sink for
an effectively-once load.

## Related

- [Pipelines](/concepts/pipelines/): where `watermark()` sits among the other template calls.
- [Connections and entities](/concepts/connections-and-entities/): the `sync:` key's place under `read:`.
- [Backfill in slices](/how-to/backfill-in-slices/): driving a bounded-window backfill to completion.
- [Capture changes with CDC](/how-to/capture-changes-with-cdc/): server-side setup and the full `on_delete` contract.
- [Project layout](/concepts/project-layout/): where `.pz/state/watermarks.json` lives.
