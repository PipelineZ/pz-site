---
title: "Key concepts"
description: "This article defines the vocabulary PipelineZ uses. If you're new to ETL tools — or coming from one that uses different words — read this first. Each entry..."
---

This article defines the vocabulary PipelineZ uses. If you're new to ETL tools — or coming from
one that uses different words — read this first. Each entry links to a concept page that goes
deeper.

## Project

A PipelineZ project is just files in a directory: YAML files that declare where data comes from
and where results go, and SQL files that describe the transformations in between. There is no
server and no database to administer — the project is fully described by what you check into
version control.

Learn more: [Project structure](/concepts/project-structure/).

## Source

Reading is a *direction*, not a kind of file. You declare each connection once in
`connections.yml` — a folder of CSV files, a Postgres database, an S3 bucket — and a pipeline
reads from it by calling `source()`. A connection contains one or more entities.

Learn more: [Project structure](/concepts/project-structure/).

## Dataset

A dataset is one named table's worth of data inside a source — one CSV file pattern, one
database table. When a run starts, each dataset is loaded and becomes a table your SQL can
query.

Learn more: [Project structure](/concepts/project-structure/).

## Pipeline

A pipeline is one SQL file under `pipelines/`. It produces exactly one table, named after the
file, and its SQL names the whole story — **extract, transform, load** — in one place:
`ref()`/`source()` in the `FROM` (extract), the `SELECT` (transform), and a leading
`INSERT INTO {{ sink(...) }}` (load) if the result is written to a destination. A pipeline with
no `INSERT INTO` is an intermediate — it still materializes and stays valid as long as another
pipeline consumes it via `ref()`.

Learn more: [Project structure](/concepts/project-structure/).

## Sink

Writing is the other direction of the same thing. A pipeline writes to a connection by calling
`sink()`, and one connection can be both read and written — it is one place, with one set of
credentials and one concurrency budget.

Learn more: [Project structure](/concepts/project-structure/).

## Output

An output maps a place in the sink to write to — "write CSV files under `out/order_totals/`,
replace mode" — but never says what feeds it. It's a **destination, not a producer binding**:
whichever pipeline's `INSERT INTO {{ sink(...) }}` names the output is what loads it, and that
call is also what brings the output into existence. One connection can have many outputs.

Learn more: [Project structure](/concepts/project-structure/).

## DAG

A DAG (directed acyclic graph) is the dependency map of your project. Every source dataset,
SQL file, check, and sink output becomes a step, and the arrows between them say "this must
finish before that starts". `pz` builds the graph from the `ref()`, `source()`, and `sink()`
calls in your SQL — it never guesses by parsing the SQL itself — and always runs steps in
dependency order.

Learn more: [Execution model](/concepts/execution-model/).

## Node

A node is one unit of work in the DAG. There are exactly four kinds: **SourceLoad** (load a
dataset in), **Pipeline** (run one SQL transformation), **Check** (run one data-quality
assertion), and **SinkWrite** (write one output out). Every line of `pz run`'s output is one
node finishing.

Learn more: [Execution model](/concepts/execution-model/).

## Check

A check is a data-quality assertion attached to a pipeline. Six types cover the practical
bases: `not_null`, `unique`, and `row_count` (nulls, duplicates, volume), `freshness` (is the
newest value of a timestamp column younger than `max_age`?), `accepted_values` (does a column
only contain values from a known list?), and `custom_sql` (any SQL query returning violating
rows — the check passes only when it returns none). Each check runs as its own node after the
pipeline it checks. A failing check fails the run's exit code, just like a failing pipeline.

Learn more: [Execution model](/concepts/execution-model/).

## Run

A run is one execution of the DAG — what happens when you type `pz run`. Every run gets an ID
and a directory under `.pz/runs/<id>/`, and writes a `run_results.json` summarizing what
succeeded, failed, or was skipped. That file is what `pz retry` reads to resume after a
failure.

Learn more: [Execution model](/concepts/execution-model/).

## Staging database

The staging database is an embedded DuckDB file (`.pz/runs/<id>/staging.duckdb`) created for
each run. Sources land their data there, all SQL executes there, and sinks read results from
there. It's the hub every byte moves through — PipelineZ never holds your whole dataset in
.NET memory.

Learn more: [The data plane](/concepts/data-plane/).

## Connector

A connector is a plugin that teaches PipelineZ how to talk to a kind of system — local files,
Postgres, S3-compatible object storage. Three connectors are built in; others ship as ordinary
NuGet packages that `pz restore` downloads and loads in-process.

Learn more: [Connectors](/concepts/connectors/).

## Watermark

A watermark is the remembered high-water mark of an incremental dataset's cursor column —
"I've already extracted everything up to id 41 000". The next run reads only rows past it, so
repeated runs move just the new data. Watermarks live in `.pz/state/watermarks.json`; inspect and
repair them with `pz state`.

Learn more: [Connectors](/concepts/connectors/).

## Templating: `ref()`, `source()`, and `sink()`

These are the three template calls you use inside SQL files. `source("raw", "orders")` names a
loaded dataset, `ref("stg_orders")` names another pipeline's output, and a leading
`INSERT INTO {{ sink("lake", "order_totals") }}` names the destination the pipeline loads its
result into (an array of `sink()` markers for N-way fan-out). They resolve to real table names
at compile time — and they're the only place DAG edges come from.

Learn more: [Project structure](/concepts/project-structure/).

## Next steps

- [Quickstart: run your first pipeline](/quickstart/)
- [Architecture overview](/concepts/architecture-overview/)
