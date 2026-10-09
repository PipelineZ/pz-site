---
title: "Backfill in slices"
description: "How to bound each pz run to a fixed-size window instead of one huge extract, using max_window, initial, and until, and how to drive the backfill to completion."
sidebar:
  order: 3
---

This page shows how to bound each `pz run` to a fixed-size window instead of one huge extract, so
a run's row count and blast radius stay bounded no matter how far behind a backfill is. Read it
when a source can't tolerate one unbounded `cursor > watermark` read: a flaky replica, a
rate-limited API, or a backlog too large for one pass.

## Prerequisites

- An entity declared incremental, either with a `sync: { mode: incremental }` block or a
  `watermark()` call in its pipeline. See [Incremental loads](/concepts/incremental-loads/).
- A merge-capable sink, so re-extracting a slice never duplicates rows.

## Steps

### 1. Add a window to the entity

Add `max_window`, `initial`, and optionally `until` alongside `cursor:`:

```yaml title="connections.yml"
pg_prod:
  connector: postgres
  host: ${PG_PROD_HOST}
  database: prod
  user: ${PG_PROD_USER}
  password: ${PG_PROD_PASSWORD}
  entities:
    public.orders:
      read:
        columns: { id: bigint, customer_id: bigint, amount: double }
        sync:
          mode: incremental
          cursor: id
          max_window: "10000"
          initial: "0"
          until: "5000000"
```

| Key | Meaning |
|---|---|
| `max_window` | Each run extracts at most this many cursor units past the watermark. |
| `initial` | Where the first run's window starts. |
| `until` | Optional. The entity is caught up once the watermark reaches this value. |

### 2. Pair the sink with a keyed merge

Use `strategy: merge` with `keys:` on the write, so a re-extracted slice updates rows instead of
duplicating them. The pipeline's `sink()` call carries the write options; there is no separate
YAML wiring to the output:

```sql title="pipelines/orders_out.sql"
INSERT INTO {{ sink('lake', 'orders_synced', strategy: 'merge', keys: ['id']) }}
SELECT id, customer_id, amount
FROM {{ source('pg_prod', 'orders') }}
```

Incremental plus merge is effectively-once: a replayed run converges on the same rows rather than
duplicating them. See
[Incremental loads](/concepts/incremental-loads/#strategy-merge-and-re-extraction) for why this
pairing matters for a backfill specifically.

### 3. Run it, one slice at a time

Each `pz run` now extracts one `(watermark, watermark + max_window]` slice, clamped to `until` if
set, never the whole remaining backlog:

```console
$ pz run --all
ok src_pg_prod__public_orders 10000 rows 2100ms
ok lake.orders_synced 10000 rows 480ms
run 20260902T091500118Z-9a1c: 2 succeeded, 0 failed, 0 skipped (.pz/runs/20260902T091500118Z-9a1c/run_results.json)
```

### 4. Drive the backfill to completion

Repeat `pz run` until the backfill catches up. With `--log-format json`, every windowed source that has an
`until` reports `caughtUp` on its `node_completed` event, so loop while the run succeeded and any of them is
still behind:

```console
$ while out=$(pz run --all --log-format json) && grep -q '"caughtUp":false' <<<"$out"; do :; done
```

The `&&` matters: a failed run stops the loop with pz's exit code instead of re-extracting the same slice
forever or ending quietly as if the backfill were done.

The run whose window reaches `until` reports `"caughtUp":true`: it loads the last slice, and the loop ends after
it. A run that starts with the watermark already at `until` also says `true`, prints a note that it's caught up,
and moves zero rows; it still exits `0`. Without `until`, there is no caught-up state and no `caughtUp` field:
stop the loop yourself once you know the watermark value you're driving toward.

## Keep a source current in windows

A scheduled job (nightly, hourly) can use the same windows when one day's data is too much for a single extract.
Set `until: now` on a date or timestamp cursor:

```yaml
sync:
  mode: incremental
  cursor: updated_at
  max_window: 1h
  initial: "2026-01-01"
  until: now
```

`now` is the time the run started, fixed for the whole run. The last window stops just before it, so a date cursor
loads up to yesterday and never half of today, and rows that arrive during the run wait for the next one. Schedule
the same loop as above: each night it loads one window at a time and stops once the window reaches the night's
start. `until: now` on a numeric cursor is `PZ0213`.

## Verify

Confirm the watermark has advanced to where you expect:

```console
$ pz state show pg_prod.orders
pg_prod.orders — cursor id (bigint)
  current  2340000  run 20260902T091500118Z-9a1c
```

## Reset a backfill

`pz run --full-refresh` on a windowed entity ignores the stored watermark for that one run and
starts the window over from `initial`. Watermark capture and advancement still run and overwrite
whatever was stored. Don't pass it on every loop iteration, or each pass re-extracts the same
first slice forever. Use it once to reset, then drop the flag.

## Troubleshooting

| If you see | Do |
|---|---|
| The loop stops after one run | `until` isn't set, so there's no caught-up signal (`caughtUp` is absent). Add `until`, or loop on the stored watermark yourself. |
| The loop stops with a non-zero exit | A run failed. Fix the cause shown in the run output, then start the loop again; it resumes from the stored watermark. |
| `PZ0214` at compile time | An incremental read feeds a plain `append` sink. Switch to `strategy: merge` with `keys:`, as above. |
| Every run re-extracts the same first slice | `--full-refresh` is set on every loop iteration. Use it once to reset, then remove it. |
| A source struggling under repeated large slices | Pace the loop, or lower `max_window`. See [Throttle a source](/how-to/throttle-a-source/). |

## Related

- [Incremental loads](/concepts/incremental-loads/): the full watermark, window, and merge model.
- [Throttle a source](/how-to/throttle-a-source/): bound how hard a run leans on the source, not
  just how much it extracts per run.
- [Tune retries](/how-to/tune-retries/): size a retry policy for the database you're backfilling
  from.
- [State](/concepts/state/): where the watermark lives and how `pz state` inspects it.
