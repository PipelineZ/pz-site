---
title: "Inspect and validate"
description: "How to check a pz project before running it: preview the execution plan, validate configuration and SQL, compile without executing, and fix a wrong watermark."
sidebar:
  order: 15
---

This guide shows you how to check a project before running it: preview the execution plan,
validate configuration and SQL, and compile without executing. All three verbs are read-only;
no data moves. It also covers fixing a watermark that has advanced too far.

## Prerequisites

- A runnable project. Follow the [quickstart](/quickstart/) to scaffold one.

## Steps

1. **Preview the execution plan** with `pz plan`, to see which nodes exist and how each will
   execute:

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

   No nodes execute. The output shows each node's execution strategy, native scan or copy where
   the connector can hand work straight to DuckDB, universal-path `duck_sql` otherwise, and the
   static memory budget for the run.

2. **Validate configuration and SQL** with `pz validate`, to catch errors before a run:

   ```console
   $ pz validate
   validation passed (3 pipelines, 2 connections checked)
   ```

   This runs validation tiers 1 to 4: project load, compilation, configuration checks, and a SQL
   dry-compile against DuckDB.

   :::note
   Add `--connect` to also run tier 5: probe live connectivity and detect schema drift. With only
   `localfiles` entities that's a no-op, since they need no live connection, but it becomes
   essential once you add a networked connector like Postgres.
   :::

3. **Compile only**, with `pz compile`, to render pipelines and build the DAG without executing
   or planning:

   ```console
   $ pz compile
   ```

   This is the fastest way to check that templating resolves and the DAG is well-formed, for
   example in a pre-commit hook.

## Verify

`pz plan`, `pz validate`, and `pz compile` all exit `0` on success. A clean `pz validate` run
prints `validation passed` with the pipeline and connection counts; anything else is a
configuration problem to fix before you run the project for real.

## Fix a wrong watermark

A watermark that has advanced past data you still need means the next run skips it. Fix it with
`pz state`, never by editing `.pz/state/watermarks.json` directly: the verb validates the value,
refuses while a run is in flight, and records what it replaced.

1. **See what is stored, and what past runs recorded:**

   ```console
   $ pz state show erp.dbo.orders
   ```

   The history section lists every run that recorded a watermark for this entity, newest first,
   with that run's own status. This is the menu you pick a rollback target from.

2. **Roll back to the position before the bad run.** Each run's recorded value is what that run
   advanced *to*, so rolling back to run N-1 restores the state as of before run N:

   ```console
   $ pz state rollback erp.dbo.orders --to-run 20260727T020009111Z-3f2e --reason "late-arriving rows"
   ```

   It prints the before and after values and what the next run will re-extract, then asks for
   confirmation. Add `--dry-run` to preview without writing, or `--yes` to skip the prompt.

3. **If no run has the value you need**, set it directly. The cursor column and type come from
   the stored entry, so only the value is yours to get right:

   ```console
   $ pz state set erp.dbo.orders --value 2026-07-01 --reason "skipping corrupt batch"
   ```

4. **If the entry itself is broken**, a cursor type pz doesn't recognize, remove it and let the
   next run extract in full:

   ```console
   $ pz state clear erp.dbo.orders --reason "corrupt entry"
   ```

Every write appends one line to `.pz/state/audit.jsonl` recording the replaced value, the new
one, and your `--reason`. `pz clean` never touches that file.

:::caution
Rolling a watermark backward makes the next run re-extract rows it already delivered. Against a
`merge` or `replace` write that's harmless; against an `append` write those rows are duplicated.
See [Delivery guarantees](/concepts/delivery-guarantees/).
:::

## Troubleshooting

| If you see | Do |
|---|---|
| `pz validate` fails with a `PZ####` error | Fix per the error's own file, line, and message. See [Error codes](/reference/error-codes/). |
| A watermark has advanced past data you still need | Roll it back with `pz state rollback`. See [Fix a wrong watermark](#fix-a-wrong-watermark) above. |
| `pz state show` exits `1` | The state file is corrupt. Restore it from a backup, or delete it and accept that the next run extracts everything in full. |
| `pz plan` shows `duck_sql` where you expected a native scan or copy | The connector has no native path for that format, or `engine.force_universal` is set project-wide in `project.yml`. |

## Related

- [Run checks and retry failures](/how-to/run-checks-and-retry/): running only your data-quality checks, and resuming after a failure.
- [CLI reference](/reference/cli/): every verb, option, and exit code, including `pz state`.
- [Validation and errors](/concepts/validation-and-errors/): what each validation tier checks and how to read an error.
- [State](/concepts/state/): what pz remembers between runs and where it lives.
- [Error codes](/reference/error-codes/): the full `PZ####` registry.
