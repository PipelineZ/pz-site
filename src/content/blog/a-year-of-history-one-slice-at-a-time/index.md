---
title: "A year of history, one slice at a time"
description: "A backfill doesn't have to be one huge extract. max_window bounds every pz run to a fixed slice past the watermark, caughtUp says when to stop, and until: now keeps the same windows running on a schedule."
date: 2026-10-10
heroImage:
  dark: ./hero-dark.svg
  light: ./hero-light.svg
  alt: "The words Backfill in slices, above a backlog cut into equal slices, the current one glowing yellow and rising into a pipeline, with a flag marking where the backlog ends."
---

The first run of a new incremental entity has no watermark yet, so it reads everything. On a
table with a year of history, that's one extract the size of the whole year. It hammers a
replica that was never sized for it, burns through a rate-limited API's quota in an afternoon,
and if it fails three hours in, the next attempt starts again from zero.

pz splits that one extract into slices. Each `pz run` moves one bounded window of history past
the watermark, commits it, and exits. The backlog shrinks one run at a time, and a failure only
ever costs the slice it happened in.

## A window is three keys

A bounded window sits alongside `cursor:` in the entity's `sync:` block:

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
        columns: { id: bigint, customer_id: bigint, amount: double, updated_at: timestamp }
        sync:
          mode: incremental
          cursor: updated_at
          max_window: 7d
          initial: 2025-10-01
          until: 2026-10-01
```

| Key | Meaning |
|---|---|
| `max_window` | Each run extracts at most this much cursor past the watermark: a duration like `7d` or `1h` on a date or timestamp cursor, a plain value like `"10000"` on a numeric one. |
| `initial` | Where the first run's window starts, before any watermark exists. |
| `until` | Optional. Where the backfill stops: the entity is caught up once the watermark reaches it. |

With that in place, every run reads `(watermark, watermark + max_window]`, clamped to `until`,
and never the whole remaining backlog. The config above turns a year of orders into 53 runs of a
week each. The bounds are computed before anything is extracted, so the cursor has to be typed up
front in `columns:`. A window that can't work, such as an `until` that doesn't come after
`initial`, is `PZ0213` at compile time, not a surprise halfway through.

## One slice, then commit

What makes slicing safe is that the watermark only moves once a slice has landed. It advances
after every downstream write for the run has committed, never before. A run that fails partway
leaves the watermark exactly where it was, and the next run re-extracts the same slice.

Re-extracting a slice is only harmless if the sink can absorb it, so pz asks for a keyed merge:

```sql title="pipelines/orders_out.sql"
INSERT INTO {{ sink('lake', 'orders_synced', strategy: 'merge', keys: ['id']) }}
SELECT id, customer_id, amount, updated_at
FROM {{ source('pg_prod', 'orders') }}
```

A replayed slice updates the rows it already wrote instead of adding them twice. Point an
incremental read at a plain `append` sink and the compiler stops you with `PZ0214`, unless you
explicitly accept duplicates.

| | One big extract | Slices |
|---|---|---|
| Rows per run | The whole history | At most one `max_window` |
| A failure costs | Everything read so far | One slice |
| Where a retry starts | The beginning | The last committed watermark |
| Load on the source | One long burst | Bounded bursts you can space out |

## Knowing when to stop

A backfill is a loop of ordinary `pz run`s. With `--log-format json`, every windowed source that
has an `until` reports `caughtUp` on its `node_completed` event, so the loop is one line:

```console
$ while out=$(pz run --all --log-format json) && grep -q '"caughtUp":false' <<<"$out"; do :; done
```

The `&&` is the important part. A failed run ends the loop with pz's exit code, instead of
retrying the same slice forever or stopping quietly as if the backfill were done. Fix the cause,
start the loop again, and it picks up from the stored watermark.

The run whose window reaches `until` loads the last slice and reports `"caughtUp":true`, and the
loop ends after it. Running again after that is harmless: pz prints a note that the entity is
caught up, moves zero rows, and exits `0`.

If the source can't take back-to-back slices, put a `sleep` in the loop body or lower
`max_window`. [Throttle a source](/how-to/throttle-a-source/) covers pacing in more depth,
including `rate_limit:` pacing within a run.

## The same windows, on a schedule

Backfills end. Scheduled jobs don't, and sometimes one day's data is already too much for a single
extract. `until: now` reuses the same windows to keep a source current:

```yaml
sync:
  mode: incremental
  cursor: updated_at
  max_window: 1h
  initial: "2026-01-01"
  until: now
```

`now` is the moment the run started, in UTC, fixed for the whole run. The last window stops just
before it, so a date cursor loads up to yesterday and never half of today, and rows that arrive
mid-run wait for the next one. Schedule the same loop: it takes one hourly slice per run and stops
once a window reaches that run's start.

Two rules keep this honest. Each run resolves `now` again, so one run, counting any wait before it
starts, has to be shorter than `max_window`, or the loop chases a moving target and never catches
up. And the cursor must hold UTC values: an empty window still moves the watermark to its end, so
a cursor in local time behind UTC can push the watermark into the source's future, past rows
that haven't been written yet. `until: now` on a numeric cursor is `PZ0213`.

## Starting over, or stepping back

`pz state show pg_prod.orders` prints the current watermark and the run that set it, which is
the quickest way to see how far a backfill has got. Two tools cover going backwards:

- **`pz state rollback`** moves a watermark back to the value a named earlier run left it at, so
  the next run re-extracts from there. The merge sink makes the overlap harmless.
- **`pz run --full-refresh`** ignores the stored watermark for one run and starts the window over
  from `initial`. Use it once, then drop the flag. Left on every loop iteration, it extracts the
  same first slice forever.

## Try it

[Backfill in slices](/how-to/backfill-in-slices/) walks the whole recipe, from the first windowed
entity through the caught-up loop and a troubleshooting table. For where bounded windows sit next
to cursors, CDC, and connector-managed tokens, see
[Incremental loads](/concepts/incremental-loads/#bounded-windows-max_window-initial-until), and
[State](/concepts/state/) covers where the watermark lives between runs.
