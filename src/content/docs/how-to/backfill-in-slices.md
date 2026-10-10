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

Pass `--until-caught-up` and pz repeats the run until every windowed source with an `until` has caught up.
The example above needs 500 slices (`until` 5,000,000 in windows of 10,000), more than the default limit of 100
passes, so raise it:

```console
$ pz run --all --until-caught-up --max-runs 1000
...
run 20260902T094812004Z-31f7: 2 succeeded, 0 failed, 0 skipped (.pz/runs/20260902T094812004Z-31f7/run_results.json)
note: until-caught-up: 500 passes, stopped: caught up
```

Each pass is a full run: it loads one slice, writes the sinks, and advances the watermark before the next pass
starts, so stopping (or crashing) loses at most the slice in flight. The loop ends:

| When | Exit code |
|---|---|
| Every windowed source with an `until` has caught up. The pass whose window reaches `until` is the last one. | `0` |
| A pass fails. The loop doesn't retry it. | that pass's exit code |
| You press Ctrl-C, or a supervisor sends `SIGTERM`/`SIGHUP`. | `3` |
| `--max-runs` passes have run (default `100`). The next invocation continues from the stored watermarks. | `0` |
| No windowed source in the selection has an `until`. It runs once and says so. | `0` |

The last line, `note: until-caught-up: <N> passes, stopped: <reason>`, says which. Under `--log-format json` it
goes to stderr, so stdout stays NDJSON. Instead of raising `--max-runs`, you can keep the default and schedule the
command: each invocation picks up where the last one stopped.

Without `until`, there is no caught-up state, and `--until-caught-up` runs once. Stop the backfill yourself once
the watermark reaches the value you're driving toward.

#### Driving it from a platform

A platform that wants one run per slice (its own history per slice, other work between slices) can read the same
signal: with `--log-format json`, every windowed source with an `until` reports `caughtUp` on its `node_completed`
event and in `run_results.json`. Start another run while the last one succeeded and any source said `false`. The run
whose window reaches `until` says `true`; a run that starts with the watermark already there also says `true`, moves
zero rows, and exits `0`.

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

`now` is the time the run started, in UTC, fixed for the whole run. The last window stops just before it, so a date
cursor loads up to yesterday and never half of today, and rows that arrive during the run wait for the next one.
Schedule `pz run --until-caught-up`: it loads windows until a run's window reaches that run's start.
Each run resolves `now` again, so keep one run (including any wait before it starts) shorter than `max_window`, or the
loop never catches up. `until: now` on a numeric cursor is `PZ0213`.

The cursor must hold UTC values. An empty window moves the watermark to its end, so with a cursor in a local time
behind UTC, a window can end in the source's future and the rows written there later are skipped.

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
whatever was stored. With `--until-caught-up`, it applies to the first pass only, so
`pz run --all --full-refresh --until-caught-up` restarts the backfill and drives it to the end. In a
loop of your own, pass it once and then drop it, or each pass re-extracts the same first slice forever.

## Troubleshooting

| If you see | Do |
|---|---|
| `stopped: no windowed source with a stop` | `until` isn't set, so there's no caught-up signal (`caughtUp` is absent). Add `until`, or loop on the stored watermark yourself. |
| `stopped: run failed` | A pass failed, and the loop exits with its code. Fix the cause shown in the run output, then start again; it resumes from the stored watermark. |
| `stopped: max runs (N) reached` | The backfill needs more than `N` slices. Run the command again, raise `--max-runs`, or raise `max_window`. |
| `PZ0214` at compile time | An incremental read feeds a plain `append` sink. Switch to `strategy: merge` with `keys:`, as above. |
| Every run re-extracts the same first slice | Your own loop passes `--full-refresh` on every iteration. Use it once, or use `--until-caught-up`, which applies it to the first pass only. |
| A source struggling under repeated large slices | Pace the loop, or lower `max_window`. See [Throttle a source](/how-to/throttle-a-source/). |

## Related

- [Incremental loads](/concepts/incremental-loads/): the full watermark, window, and merge model.
- [Throttle a source](/how-to/throttle-a-source/): bound how hard a run leans on the source, not
  just how much it extracts per run.
- [Tune retries](/how-to/tune-retries/): size a retry policy for the database you're backfilling
  from.
- [State](/concepts/state/): where the watermark lives and how `pz state` inspects it.
