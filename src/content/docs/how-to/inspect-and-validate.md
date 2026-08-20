---
title: "Inspect and validate a project"
description: "This article shows you how to check a project before running it: preview the execution plan, validate configuration and SQL, and compile without executing...."
---

This article shows you how to check a project before running it: preview the execution plan,
validate configuration and SQL, and compile without executing. All three verbs are read-only —
no data moves.

## Prerequisites

- A runnable project. Follow the [quickstart](/quickstart/) to scaffold one.

## Preview the execution plan

To see what a run *would* do — which nodes exist and how each will execute — use `pz plan`:

```console
$ pz plan
strategy      node                     reason
native_scan   src_raw__customers       native scan: connector 'localfiles' provides read_csv over data/customers.csv
native_scan   src_raw__orders          native scan: connector 'localfiles' provides read_csv over data/orders.csv
duck_sql      stg_orders               duckdb sql: executes in-engine
duck_sql      order_totals             duckdb sql: executes in-engine
duck_sql      orders_enriched          duckdb sql: executes in-engine
native_copy   lake.order_totals        native copy: connector 'localfiles' provides COPY TO csv
native_copy   lake.orders_curated      native copy: connector 'localfiles' provides COPY TO parquet
memory budget: ~1.63 GB (duckdb 1.00 GB + channels 0.38 GB + overhead 256MB)
```

No nodes execute. The output shows each node's execution strategy — native scan/copy where the
connector can hand work straight to DuckDB, universal-path `duck_sql` otherwise — and the
static memory budget for the run.

> [!TIP]
> How the memory budget is computed, and how to benchmark your own hardware, is covered in
> [Performance](/performance/).

## Validate without running

To catch configuration and SQL errors before a run, use `pz validate`:

```console
$ pz validate
validation passed (3 pipelines, 2 connections checked)
```

This runs validation tiers 1–4: project load, compilation, configuration checks, and a SQL
dry-compile against DuckDB.

> [!NOTE]
> Add `--connect` to also run tier 5: probe live connectivity and detect schema drift. With
> only `localfiles` datasets that's a no-op — they need no live connection — but it becomes
> essential once you add a networked connector like Postgres.

## Compile only

To render pipelines, build the DAG, and write the `.pz/target` artifacts without executing or
planning, use `pz compile`. It's the fastest way to check that templating resolves and the
DAG is well-formed — for example in a pre-commit hook.

## A watermark is wrong

A watermark that has advanced past data you still need means the next run skips it. Fix it with
`pz state`, never by editing `.pz/state/watermarks.json` — the verb validates the value, refuses while
a run is in flight, and records what it replaced. That covers a bad *entry*; if the whole file is
unparseable, every `pz state` subcommand exits 1 without repairing it — restore it from a backup, or
delete the file and accept that the next run extracts everything in full.

1. **See what is stored, and what the runs recorded:**

   ```bash
   pz state show erp.dbo.orders
   ```

   The `history` section lists every run that recorded a watermark for this dataset, newest first, with
   that run's own status. This is the menu you pick a rollback target from.

2. **Roll back to the position before the bad run.** Each run's recorded value is what that run
   advanced *to*, so rolling back to run N−1 restores the state as of before run N:

   ```bash
   pz state rollback erp.dbo.orders --to-run 20260727T020009111Z-3f2e --reason "late-arriving rows"
   ```

   It prints the before/after and what the next run will re-extract, then asks for confirmation. Add
   `--dry-run` to see all of that without writing, or `--yes` to skip the prompt (required when not on a
   terminal, e.g. from a scheduled task).

3. **If no run has the value you need** — `pz clean --purge` (or manual deletion) removed the run
   directory the value lived in, or you want to skip past a batch of bad source rows — set it
   directly. The cursor column and type come from the stored entry, so only the value is yours to get
   right:

   ```bash
   pz state set erp.dbo.orders --value 2026-07-01 --reason "skipping corrupt batch"
   ```

4. **If the entry itself is broken** — a cursor type pz does not recognize, which only hand-editing can
   produce — remove it and let the next run extract in full:

   ```bash
   pz state clear erp.dbo.orders --reason "corrupt entry"
   ```

Every write appends one line to `.pz/state/audit.jsonl` recording the replaced value, the new one, and
your `--reason`. That file is the undo: `pz state show <key>` shows the recent entries, and nothing in
pz ever rewrites or prunes it — `pz clean` cannot touch `.pz/state` at all.

**Watch the sink mode.** Rolling a watermark backward makes the next run re-extract rows it already
delivered. Against a `merge` or `replace` sink that is harmless; against an `append` sink those rows are
duplicated. `pz state` says so before it writes, but it cannot check your sink's mode without compiling
the project — see [Delivery guarantees](/concepts/delivery-guarantees/).

## Next steps

- [Run checks and retry failures](/how-to/run-checks-and-retry/)
- [CLI reference](/reference/cli/) — every verb, option, and exit code.
- [Validation and errors](/concepts/validation/) — what each validation tier checks.
