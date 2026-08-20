---
title: "Run checks and retry failures"
description: "This article shows you how to run only your data-quality checks with pz test, and how to resume a failed run with pz retry instead of re-running everything."
---

This article shows you how to run only your data-quality checks with `pz test`, and how to
resume a failed run with `pz retry` instead of re-running everything.

## Prerequisites

- A runnable project. Follow the [quickstart](/quickstart/) to scaffold one.

## Run only the data-quality checks

To execute just the checks — and only the nodes they depend on — use `pz test`:

```console
$ pz test
ok src_raw__customers 3 rows 38ms
ok src_raw__orders 5 rows 30ms
ok stg_orders 3 rows 7ms
ok orders_enriched 3 rows 6ms
ok check_orders_enriched_not_null_id_email 0 rows 6ms
ok check_orders_enriched_unique_id 0 rows 3ms
run <runId>: 6 succeeded, 0 failed, 0 skipped (demo/.pz/runs/<runId>/run_results.json)
```

`pz test` executes every ancestor a check depends on, plus the checks themselves. Anything with
no check downstream is skipped — in the quickstart project that's `order_totals`, all three
sinks, and the whole products flow (`src_raw__products`, `product_catalog`).

> [!WARNING]
> A failing check can record offending data verbatim in `run_results.json` (and in the
> `--log-format json` NDJSON output) to help you find the bad data: `not_null`/`unique` record
> up to 5 offending row values, `accepted_values` records up to 5 distinct offending values, and
> `custom_sql` records up to 5 rows returned by your query. `row_count` and `freshness` never
> report row data — only counts and bounds. If that isn't acceptable for your project, opt out
> with `sample_values: false` on the check (or `engine.check_samples: false` project-wide to
> suppress it everywhere by default).

## Choose a check type

> [!WARNING]
> Checks are observational: a failing check fails the run (exit 1) but does **not** block the
> pipeline's sink writes — the flagged rows still land in the destination in the same run that
> reports the failure. See
> [Checks](/concepts/project-structure/#pipelinessql-and-sidecar-configs).
>
> If bad data must never reach a destination, gate the run yourself: `pz test && pz run`.
> `pz test` executes the checks and only their required ancestors — no sinks — so the `&&` lets
> the sinks run only when every check passed. This is sound for incremental sources too:
> watermarks advance only when every structural sink descendant committed (commit-gated
> advancement), and a `pz test` run executes no sinks, so the follow-up `pz run` extracts the
> same window the checks just validated. The cost is a second extraction — for expensive
> sources weigh it against the guarantee.

`not_null`, `unique`, and `row_count` catch structural problems. Three more types round out
the vocabulary:

```yaml
# pipelines/configs/orders_enriched.yml
pipeline: orders_enriched
checks:
  - freshness: { column: updated_at, max_age: 24h }
  - accepted_values: { column: status, values: [pending, shipped, delivered] }
  - custom_sql:
      name: no_negative_totals
      sql: select * from staging.orders_enriched where total < 0
```

- **`freshness`** fails when `max(column)` is older than `max_age` ago — and when the table is
  empty, because no rows is no evidence of recent data. If emptiness is expected, pair it with
  `row_count`. The failure message reports the actual max and the bound, never row data.
  Freshness compares against a UTC cutoff and assumes a UTC-naive `timestamp`/`date` column (the
  staging default); `timestamptz` columns are converted using the session time zone.
- **`accepted_values`** fails on any non-NULL value outside the list, and reports up to 5
  distinct offending values. NULLs pass — add `not_null` if they shouldn't.
- **`custom_sql`** is the escape hatch: the query returns *violating* rows and the check passes
  only when it returns none. It runs verbatim (no templating) against the staging database, so
  target your own pipeline's table `staging.<pipeline>` — the check only orders after its
  owning pipeline, and referencing other pipelines' tables has undefined ordering. `name`
  becomes the node name: `check_<pipeline>_<name>`.

Typo'd check types or malformed options fail at compile time with PZ0113 — before any data
moves.

## Resume a failed run

To re-execute only what didn't succeed last time, use `pz retry`:

```console
$ pz retry
nothing to retry (run <runId> succeeded)
```

`pz retry` reads the most recent run's `run_results.json` and re-executes only the nodes that
didn't succeed, plus the ancestors they need. With nothing to fix, it says so and exits cleanly.

Succeeded source loads are not re-extracted: their staged tables are copied from the failed
run's retained staging database, so the source system is never contacted again for data it
already delivered (`note: reusing staged data for N source load(s)`). Sinks that already
committed are carried forward, which lets the watermark advance once the retry succeeds. Any
staged table that can't be reused (staging deleted, `--full-refresh`) falls back to a normal
re-extraction with a note. See [Delivery guarantees](/concepts/delivery-guarantees/) for
the exact rules.

A typical failure workflow:

1. `pz run` fails on one node; independent nodes still complete.
2. Fix the broken configuration (or just wait out the outage).
3. `pz retry` picks up exactly where the failed run left off — committed sinks stay committed,
   and staged data is reused instead of re-extracted.

## Next steps

- [Tune retries per database](/how-to/tune-retries/) — automatic retries for transient failures,
  before you ever need `pz retry`.
- [Inspect and validate a project](/how-to/inspect-and-validate/)
- [CLI reference](/reference/cli/)
