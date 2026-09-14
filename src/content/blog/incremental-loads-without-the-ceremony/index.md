---
title: "Incremental loads without the ceremony"
description: "Full refresh reads everything, every time. Watermarks, sync modes, and merge writes let pz read only what changed, safely."
date: 2026-09-10
heroImage:
  dark: ./hero-dark.svg
  light: ./hero-light.svg
  alt: "A yellow step-chart line climbing across a grid background, next to the words Incremental loads."
---

The default instinct for a first pipeline is to read the whole table, every run. It's simple,
it's obviously correct, and it works fine right up until the table has a year of history in it
and the "quick daily job" is spending most of its time re-reading rows that haven't changed since
last week.

## Full refresh is the easy trap

A full refresh extracts everything every time, so there's nothing to get wrong: no watermark to
track, no missed row, no stale cursor. That's exactly why it's the default. The cost is that the
job's runtime grows with total history, not with what actually changed, and that growth is
invisible until the table crosses a size where it starts to matter.

An incremental read flips this: it extracts only what's new since the last run, tracked by a
stored watermark, the highest value of a cursor column already seen. Runtime then scales with
the day's new rows, not the table's whole past.

| | Full refresh | Incremental |
|---|---|---|
| Runtime | Grows with total history | Grows with new rows since last run |
| State to track | None | A stored watermark |
| Correctness risk | None, nothing to get wrong | A missed or stale cursor |
| Deletes visible? | Yes, every run | Only with `mode: cdc` |

## What changed since last time

pz tracks incrementality per entity, under a `sync:` key on its `read:` block:

```yaml title="connections.yml"
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

Each run reads the stored watermark, asks the connector for rows past it, and only advances the
watermark once every downstream write for that run has committed. If a write fails, the
watermark doesn't move, so a retry re-reads instead of silently skipping data.

## Or just write it in SQL

The same comparison can live directly in a pipeline's `WHERE` clause instead of in YAML, using
`{{ watermark() }}`:

```sql title="pipelines/orders_log.sql"
INSERT INTO {{ sink('lake', 'orders_log', format: 'parquet', strategy: 'append', duplicates: 'accept') }}
select order_id, customer_id, amount, status, updated_at
from {{ source('raw', 'orders') }}
where updated_at > {{ watermark('raw', 'orders') }}
```

`watermark('<connection>', '<entity>')` renders the stored cursor value, or `NULL` on an
entity's first run. This is the same mechanism as the YAML form, just declared where the read
already lives: the `.sql` file names the whole story, extract through load, including that it's
incremental. An entity picks one form or the other, never both.

Run that pipeline twice and the second run lands nothing, because the watermark has already
advanced past every row it saw.

## Making re-extraction safe

An incremental read that gets retried, or that overlaps slightly with the previous run, can hand
the same row to the sink more than once. What happens next depends entirely on the write
strategy:

| Strategy | Delivery | Re-extraction | Best for |
|---|---|---|---|
| `merge` | Exactly-once | Upserts on `keys:`, so replays converge | A table-shaped sink, the default choice |
| `append` | At-least-once | Adds rows; requires `duplicates: 'accept'` | A delta log deduplicated downstream |

**`strategy: merge`** upserts on a set of `keys:`, so re-extracting the same slice converges on
the same rows instead of duplicating them. This is the strategy to reach for by default when
pairing incremental reads with a table-shaped sink.

**`strategy: append`** just adds rows, so it's at-least-once: a replayed run can re-deliver a
slice. pz requires you to opt into that explicitly with `duplicates: 'accept'`, which is correct
for something like a delta log you plan to deduplicate downstream.

```sql
INSERT INTO {{ sink('mart', 'mart.orders_current', strategy: 'merge', keys: ['order_id']) }}
select order_id, customer_id, amount, status, updated_at
from {{ source('erp', 'dbo.orders') }}
where updated_at > {{ watermark('erp', 'dbo.orders') }}
```

## When cursor and watermark aren't enough

Two cases go beyond a plain incremental read, and both stay declarative rather than turning into
custom pipeline logic:

A **backfill** needs to move a large amount of history without one unbounded extract hitting the
source all at once. Adding `max_window` alongside `cursor:` bounds each run to a fixed-size
slice instead, so a `pz run` moves one slice at a time and repeating the command drives the
backfill forward. See [Backfill in slices](/how-to/backfill-in-slices/) for the full walkthrough.

**Change data capture** replaces the cursor comparison entirely: `mode: cdc` reads inserts,
updates, and deletes straight from the source's own change log, which is how deletes get
captured at all, something a cursor column can never see on its own. It needs server-side setup
ahead of time and a merge write with an explicit `on_delete` policy. See [Capture changes with
CDC](/how-to/capture-changes-with-cdc/) for the prerequisites.

## Try it

[Incremental loads](/concepts/incremental-loads/) is the full concept page this post walks a
path through, including bounded windows, `mode: auto` for connector-managed cursors, and the
`--full-refresh` escape hatch. The `sqlserver` [quickstart](/quickstart/) template ships an
incremental read paired with a keyed merge sink, so you can see the whole thing run instead of
just reading about it.
