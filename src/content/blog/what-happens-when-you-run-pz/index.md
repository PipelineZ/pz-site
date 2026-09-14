---
title: "What happens when you run pz"
description: "The seven phases between typing pz run and seeing a result: load, compile, validate, plan, dispatch, finalize, report, and what each one leaves on disk."
date: 2026-09-14
heroImage:
  dark: ./hero-dark.svg
  light: ./hero-light.svg
  alt: "The word Inside above the accent-colored words 'a run', next to a yellow circuit path over a dot grid."
---

`pz run` looks like one command. Underneath it's seven phases, each one narrowing what could
still go wrong before any byte of data actually moves. Knowing the shape of a run tells you
where to look when something fails, and why a retry is usually cheap.

## Load and compile

`pz` first parses `project.yml` and `connections.yml`, resolving environment variables and any
`--vars` overrides. A malformed file stops here, before a run directory even exists.

Then every `.sql` file under `pipelines/` renders as a template. This is how `pz` discovers the
dependency graph: it never parses SQL to guess at edges you didn't tell it about. Each
`source()`, `ref()`, and `sink()` call declares one edge as it fires. What comes out is a graph
of exactly four node kinds:

- **SourceLoad** loads one entity into the staging database.
- **Pipeline** runs one pipeline's `SELECT`.
- **Check** runs one data-quality assertion against a pipeline's result.
- **SinkWrite** writes one entity out to its destination.

`pz compile` and `pz ls` stop right here: one writes the graph to `.pz/target/manifest.json`,
the other just prints it.

## Validate before anything runs

Before `pz run`, `pz test`, or `pz retry` opens a real staging database, every pipeline's SQL
dry-compiles against empty tables shaped by its known columns. A broken query fails here, as one
clear error, instead of surfacing as a node failure partway through a real run. This is one tier
of a five-tier validation model; see [Validation and errors](/concepts/validation-and-errors/)
for the full set, including the connectivity checks that only run with `--connect`.

## Plan

For every edge, `pz` decides how the data actually moves: a native path when the connector can
hand DuckDB the work directly, or a universal batch path otherwise. `pz plan` prints this table
without running anything, so you can see the strategy before committing to it.

## Dispatch

Nodes run as soon as every parent has succeeded, up to a configured concurrency limit. This is a
topological dispatcher, not a fixed stage-by-stage schedule, so independent branches of the
graph run in parallel without you having to say so:

```
ok stg_orders 5 rows 12ms
ok orders_enriched 5 rows 8ms
ok check_orders_enriched_not_null_id_email 5 rows 3ms
FAIL lake.order_totals 0 rows 4ms
```

## Finalize and report

Sinks commit, or the node is marked failed. The staging database sticks around either way, so a
failure doesn't cost you the work that already succeeded, only the part that didn't. `pz` then
prints a summary line naming the run ID and where its results landed, and exits with a code that
says exactly what happened: `0` for a clean run, `1` if any node failed, `2` for a validation
error that stopped things before they started, `3` for anything unexpected.

## Why this shape makes retries cheap

Every run gets its own directory under `.pz/runs/<run-id>/`, holding the staging database and a
`run_results.json` written incrementally as nodes finish. That file is what `pz retry` reads: it
re-runs only what failed or was skipped, reusing everything that already succeeded rather than
starting the whole graph over.

```console
$ pz run orders_enriched
ok stg_orders 5 rows 12ms
ok orders_enriched 5 rows 8ms
FAIL lake.order_totals 0 rows 4ms
run 20260902T101533221Z-4c1a: 2 succeeded, 1 failed, 0 skipped

$ pz retry
note: reusing staged data for 2 source load(s) from run 20260902T101533221Z-4c1a
ok lake.order_totals 5 rows 6ms
run 20260902T101602118Z-9e2f: 1 succeeded, 0 failed, 0 skipped
```

Nothing here is special-cased for this one example. It falls straight out of every phase writing
down what it did before the next one starts.

## Try it

[How a run works](/concepts/how-a-run-works/) covers the same seven phases in full, including
the exit code table and every artifact a run leaves behind. [Delivery
guarantees](/concepts/delivery-guarantees/) picks up from here: what each write strategy
promises the destination when a run dies mid-write, and what `pz retry` will and won't redo.
