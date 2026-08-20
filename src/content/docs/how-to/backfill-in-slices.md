---
title: "Backfill in bounded slices"
description: "Some sources can't tolerate one huge cursor > watermark extract — a flaky replica, a rate-limited API, a backlog too large to read in one pass. This article..."
---

Some sources can't tolerate one huge `cursor > watermark` extract — a flaky replica, a
rate-limited API, a backlog too large to read in one pass. This article shows you how to bound
each `pz run` to a fixed-size window instead, so a run's row count, memory, and blast radius
stay bounded no matter how far behind the backfill is.

## Prerequisites

- An incremental dataset (one with a `sync: { mode: incremental, cursor: ... }` block).
- A merge-capable sink, so re-extracting a slice never duplicates rows.

## 1. Add a window to the dataset

Add window keys alongside the dataset's `sync.cursor:`:

| Key | Meaning |
|---|---|
| `max_window` | Each run extracts at most this many cursor units |
| `initial` | Where the *first* run's window starts |
| `until` | Optional: stop backfilling once the cursor reaches this value |

```yaml
# connections.yml
pg_prod:
  connector: postgres
  # ...host, credentials, connector options -- flat
  host: ${PG_PROD_HOST}
  database: prod
  user: ${PG_PROD_USER}
  password: ${PG_PROD_PASSWORD}
  entities:
    public.orders:
      read:
        columns:
          id: bigint
          customer_id: bigint
          amount: double
        sync:
          mode: incremental
          cursor: id
          max_window: "10000"     # each run extracts at most this many cursor units
          initial: "0"             # where the FIRST run's window starts
          until: "5000000"         # optional: stop backfilling once the cursor reaches this value
  retry:
    max_attempts: 8
    base_delay: 2s
    max_delay: 5m
```

Give the source a `retry:` block sized for the database you're backfilling from — see
[Tune retries per database](/how-to/tune-retries/).

> [!TIP]
> **Backfilling a date-partitioned file layout?** `max_window` isn't just what bounds each
> run's blast radius here — on a date-templated `path` it's also what turns on listing pruning
> (a date-templated `path` with no bounded window is a compile error, not a silent full scan).
> A plain incremental dataset on a glob **without** date tokens scans the full glob every run and
> relies on the merge sink to dedup; declaring `max_window` on a date-partitioned layout lets
> each run list only the window's minimal folder cover instead of the whole history. See
> [Date-partitioned paths](/concepts/connectors/#date-partitioned-paths).

## 2. Pair the sink with merge mode

Use `write: { strategy: merge }` on the output so a re-extracted slice updates rows instead of
duplicating them:

```yaml
# connections.yml
lake:
  connector: postgres
  # ...host, credentials, connector options -- flat
  # ...host, credentials, connector options -- flat
```

The pipeline that produces the slice loads it with a leading `INSERT INTO {{ sink(...) }}`
carrying the write options — there is no YAML wiring to the output:

```sql
-- pipelines/orders_out.sql
INSERT INTO {{ sink('lake', 'orders_synced') }}
select id, customer_id, amount
from {{ source('pg_prod', 'orders') }}
```

## 3. Run it — one slice per run

Each `pz run` now extracts one `(watermark, watermark + max_window]` slice — clamped to
`until`, if set — never the whole remaining backlog.

## 4. Drive the backfill to completion

Repeat `pz run` until the backfill catches up. A small external loop on the stored watermark
works well:

```console
$ until jq -e '.watermarks["pg_prod.orders"].value == "5000000"' .pz/state/watermarks.json > /dev/null 2>&1; do
    pz run --project .
  done
```

### When `until` is set

Once the stored watermark reaches `until`, the dataset is *caught up*: every run from then on
prints a `note: source 'pg_prod.orders' is caught up (watermark ... has reached until ...)`
line and moves 0 rows. A caught-up run still exits `0` — this is a steady state, not a failure.
If you'd rather not depend on `jq`, a loop that watches the console also works:

```console
$ while ! pz run 2>&1 | grep -q "is caught up"; do :; done
```

### When `until` is not set

> [!WARNING]
> Without `until` there is no caught-up state to reach: every run keeps windowing forward by
> `max_window` regardless of what it finds, and even an empty slice still advances the
> watermark — so a `grep -q "is caught up"` loop would spin forever. Stop the loop yourself
> instead: on the watermark condition (the `jq` form above, once you know the value you're
> driving toward), or on a run that moves 0 rows, which means the window has drawn even with
> the live edge of the source for now. From there, drop the loop and run `pz run` periodically
> like any other incremental dataset.

## Reset a backfill with --full-refresh

`pz run --full-refresh` on a windowed dataset ignores the stored watermark on that invocation
and starts the window over from `initial`. Watermark capture and advancement still run and
overwrite whatever was stored.

> [!WARNING]
> Don't pass `--full-refresh` on every loop iteration — each pass would re-extract the same
> first slice forever. Use it once, to reset a backfill back to the start, then drop the flag
> so the rest of the loop picks up from the watermark that reset run just re-established.

## Next steps

- [Throttle a struggling source or sink](/how-to/throttle-a-source/) — bound how *hard* the run leans
  on the database, not just how much it extracts.
- [Connectors](/concepts/connectors/) — how incremental extraction and watermarks work.
