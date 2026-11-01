---
title: "Preview data"
description: "How to look at a sample of a source or pipeline with pz preview: from a finished run or computed fresh, with sensitive columns redacted."
sidebar:
  order: 18
---

This guide shows you how to look at a sample of what a source or pipeline produces, with
`pz preview`, and how to keep sensitive columns out of that sample. `pz preview` is new in
pz 0.17.0.

## Prerequisites

- A pz project. To preview from a run, at least one finished `pz run` or `pz retry` made by
  pz 0.17.0 or later.

## Steps

### 1. Mark sensitive columns

Before you show anyone a sample, mark the columns whose values should never appear in it. A
marked column shows `•••` in every row, nulls included. Marks are read only by `pz preview`: they
change no types, no node ids, and nothing a run does.

On a source, use the long form of a `columns:` entry, in `connections.yml` or in the `columns`
kwarg of a `source()` call:

```yaml title="connections.yml"
raw:
  connector: localfiles
  entities:
    customers:
      read:
        path: data/customers.csv
        format: csv
        columns:
          id: bigint
          name: varchar
          email: { type: varchar, redact: true }
```

On a pipeline, list the columns in its sidecar:

```yaml title="pipelines/configs/stg_customers.yml"
pipeline: stg_customers
columns:
  - name: email
    redact: true
```

Marks do not follow a column through a pipeline. The mark on `raw.customers` above protects the
source's sample only; `stg_customers` outputs `email` unmarked unless its own sidecar marks it
too. Mark the column on every step that outputs it. A source with no `columns:` contract cannot
carry marks: mark the column in the sidecar of the pipeline that reads it instead.

Run `pz validate`. A sidecar mark that names a column the pipeline does not output, usually a
typo or a column renamed in the SQL, is warning `PZ0403`.

### 2. Run the pipeline

```console
$ pz run stg_customers
ok src_raw__customers 1840 rows 95ms
ok stg_customers 1840 rows 12ms
run 20260902T094011003Z-7c2a: 2 succeeded, 0 failed, 0 skipped (.pz/runs/20260902T094011003Z-7c2a/run_results.json)
```

The last line names the run id.

### 3. Preview from the run

```console
$ pz preview stg_customers --run 20260902T094011003Z-7c2a --limit 3
id   name          email (redacted)
---  ------------  ----------------
101  Ada Lovelace  •••
102  Alan Turing   •••
103  Grace Hopper  •••
3 of 1840 rows
```

This reads the run's `staging.duckdb` read-only and shows the node exactly as that run left it.
The rows are a sample, in no particular order. `--limit` takes `1` to `500` (default `50`).

A run directory is self-contained: each run records which relation holds each node and which
columns were marked, in its own `staging.duckdb`. Point `--run-dir` at a copied run directory and
`pz preview` needs no project files at all:

```console
$ pz preview stg_customers --run-dir /backups/runs/20260902T094011003Z-7c2a
```

Marks come from the project as it was when that run compiled it, so a mark added since does not
apply to an older run's sample.

### 4. Preview fresh, without a run

```console
$ pz preview stg_customers --fresh
```

`--fresh` compiles the project as it is now and runs the node and its ancestors in a throwaway
in-memory DuckDB. It never runs a sink or a check, never reads or writes state (watermarks, sync
tokens, cdc slots), and writes no run directory. Use it to check a change before you run it, or
to preview an ephemeral pipeline, which a run never stores.

Each source stops after `--slice` rows (default `1000`, up to `100000`), so a fresh sample is
built from a slice of each source, not from all of it. Joins can match fewer rows than a real run
would, and totals and counts can look thin. A `cdc` dataset is read as a plain snapshot. Raise
`--slice` when the sample looks too sparse to judge.

### 5. Get JSON for a tool

Add `--json` to print one JSON object on stdout instead of a table. Values longer than 200
characters are cut to their first 200 characters followed by `…`, and a redacted column's cells
are all `"•••"`. The [CLI reference](/reference/cli/#pz-preview) has the full shape.

## Verify

`pz preview` exits `0` when it printed a sample. A column you marked shows `(redacted)` in its
table header, or `"redacted": true` in `--json` output, and `•••` in every row.

## Troubleshooting

| If you see | Do |
|---|---|
| `PZ0537` | The run has nothing to show for this node: the run was made by an older pz, its `staging.duckdb` was cleaned, it is still in progress, or the node did not run or failed. Preview it with `--fresh`, or pick a run that produced it. |
| `PZ0538` | The node is a sink or a check, which has no rows of its own; preview the pipeline that feeds it. For an ephemeral pipeline, use `--fresh`. |
| `PZ0539` | An option breaks a rule: give exactly one of `--run`, `--run-dir`, `--fresh`, and use `--slice` and `--vars` only with `--fresh`. |
| A column you expected to be redacted shows values | Marks do not follow a column through a pipeline. Mark it in this node's own sidecar or source `columns:`. |
| Exit `1` with `--fresh` | A node failed while computing the sample; the error is that node's own. Fix it as you would in a run. |

## Related

- [CLI reference](/reference/cli/#pz-preview): every `pz preview` option, the JSON shape, and exit codes.
- [Pipeline config](/reference/pipeline-config/#columns): the sidecar `columns:` list.
- [connections.yml reference](/reference/connections-yml/#redacting-columns): the `columns:` long form on a source.
- [Debug a failed run](/how-to/debug-a-failed-run/): querying a run's staged tables directly.
- [Error codes](/reference/error-codes/): `PZ0403` and `PZ0537` to `PZ0539`.
