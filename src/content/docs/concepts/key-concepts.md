---
title: "Key concepts"
description: "A glossary of the vocabulary pz uses for its projects, connections, pipelines, and runs, with a dbt-to-pz translation table."
sidebar:
  order: 1
---

This page defines the words `pz` uses for its own parts. Read it first if you are new to `pz`,
especially if you know dbt and expect different words for similar things. Each entry links to
the concept page that explains it in depth.

## Project

A `pz` project is files in a directory: `project.yml` and `connections.yml` for configuration,
`.sql` files under `pipelines/` for transformations. There is no server to run and no database
to administer. The project is fully described by what you check into version control.

See [Project layout](/concepts/project-layout/).

## Connection

A connection is one place `pz` talks to: a folder of files, a Postgres database, an S3 bucket.
You declare it once, under a name, in `connections.yml`. A connection carries credentials and
connector config, and it can be read from, written to, or both.

See [Connections and entities](/concepts/connections-and-entities/).

## Entity

An entity is one named thing inside a connection: one file pattern, one database table, one
HTTP resource. The entity's key is spelled exactly the way its own system names it, such as
`dbo.orders` or `public.customers`. A connection can declare many entities.

See [Connections and entities](/concepts/connections-and-entities/).

## Read and write

Reading and writing are directions, not separate objects. An entity that is written and later
read back is declared once, with a `read:` block, a `write:` block, or both. In pipeline SQL,
reading is the `source()` call and writing is the `sink()` call.

See [Connections and entities](/concepts/connections-and-entities/).

## Pipeline

A pipeline is one SQL file under `pipelines/`, named after its file. Its SQL tells the whole
story: `source()` or `ref()` calls in the `FROM` clause say what feeds it, the `SELECT` is the
transform, and a leading `INSERT INTO {{ sink(...) }}` says where the result loads.

See [Pipelines](/concepts/pipelines/).

## `source()`, `ref()`, and `sink()`

These are the three template calls that appear inside pipeline SQL. `source('conn', 'entity')`
names a loaded entity. `ref('pipeline')` names another pipeline's result. `sink('conn',
'entity')` names where a pipeline's result loads. Each call resolves to a real table name and
also declares one edge of the dependency graph.

See [Pipelines](/concepts/pipelines/).

## Check

A check is a data-quality assertion attached to a pipeline, declared in a sidecar YAML file.
Six types exist: `not_null`, `unique`, `row_count`, `freshness`, `accepted_values`, and
`custom_sql`. A failing check fails the run.

See [Checks](/concepts/checks/).

## Flow

A flow is a named node plus everything upstream and downstream of it: run `pz run
orders_enriched` and every pipeline, check, and connection that node touches runs with it. A
project with more than one independent flow must name one, or pass `--all`.

See [How a run works](/concepts/how-a-run-works/).

## Node

A node is one unit of work in the dependency graph. There are exactly four kinds: **SourceLoad**
(load an entity), **Pipeline** (run one SQL transform), **Check** (run one assertion), and
**SinkWrite** (write one entity out). Every line of `pz run`'s output reports one node finishing.

See [How a run works](/concepts/how-a-run-works/).

## Run

A run is one execution of the dependency graph, triggered by `pz run`. Every run gets an ID and
a directory under `.pz/runs/<id>/`, and writes a `run_results.json` summarizing what succeeded,
failed, or was skipped. `pz retry` reads that file to resume after a failure.

See [How a run works](/concepts/how-a-run-works/).

## Watermark

A watermark is the remembered high-water mark of an incremental entity's cursor column: the
highest cursor value already extracted. The next run reads only rows past it. Watermarks live
in `.pz/state/watermarks.json` and advance only after every downstream write commits.

See [Incremental loads](/concepts/incremental-loads/).

## Staging database

The staging database is an embedded DuckDB file created fresh for each run, under
`.pz/runs/<id>/staging.duckdb`. Reads land their data there, every pipeline's SQL runs there,
and writes drain from there to their destinations. It is the hub every byte moves through.

See [Project layout](/concepts/project-layout/).

## Connector

A connector is a plugin that teaches `pz` how to talk to a kind of system: local files,
Postgres, S3-compatible storage, and so on. Fifteen connectors ship built into the `pz` tool:
`localfiles`, `postgres`, `s3`, `sqlserver`, `azureblob`, `gcs`, `http`, `mysql`, `sqlite`,
`duckdb`, `ducklake`, `motherduck`, `quack`, `iceberg`, and `sftp`. Anything else is a NuGet
package that `pz restore` pins and runs as its own process.

See [Connectors](/concepts/connectors/).

## Coming from dbt

If you know dbt, most of the authoring model will feel familiar: SQL files, `ref()` templating,
a compiled dependency graph you can inspect before running. The table below maps dbt's
vocabulary onto `pz`'s.

| dbt term | pz term |
|---|---|
| model | pipeline |
| source | connection (read direction) |
| target / output | connection (write direction) |
| `ref()` | `ref()` (same) |
| `source()` | `source()`, but naming a connection and an entity |
| materialization | materialization (`table`, `view`, `ephemeral`) |
| test | check |
| DAG | dependency graph (same idea, `pz` calls its unit of work a node) |
| `dbt run` | `pz run` |
| `dbt test` | `pz test` |
| profile / target warehouse | connection, plus the embedded DuckDB staging database |
| adapter | connector |

The biggest structural difference: dbt transforms data that is already inside a warehouse. `pz`
moves data too, so a `pz` project also declares where data comes from and where it lands, not
just how to transform it once it arrives.

## Related

- [Project layout](/concepts/project-layout/): the files a `pz` project is made of.
- [Connections and entities](/concepts/connections-and-entities/): declaring where data lives.
- [Pipelines](/concepts/pipelines/): how a `.sql` file becomes a graph node.
- [How a run works](/concepts/how-a-run-works/): what happens when you type `pz run`.
- [Quickstart](/quickstart/): build and run a small project end to end.
