---
title: "Look at the rows, not the secrets"
description: "pz preview shows a sample of any source or pipeline, from a finished run or computed fresh without touching state, and columns marked redact: true come out as ••• in every row, so the sample is safe to paste."
date: 2026-11-04
heroImage:
  dark: ./hero-dark.svg
  light: ./hero-light.svg
  alt: "The words Preview the rows, not the secrets, above a small data table fed by a pipeline: two columns of grey value bars, and one column where every cell is a row of three glowing yellow dots."
---

Someone asks what `stg_customers` actually looks like after last night's change. The honest answer
takes a few steps. Find the run id, open `.pz/runs/<run-id>/staging.duckdb` with the `duckdb` CLI,
remember which schema and relation name the node landed under, and type a `SELECT * ... LIMIT 5`.
Then copy the result into the ticket, and notice, after you've pasted it, that the third column is
every customer's email address.

`pz preview` turns that into one command, and redaction marks keep the third column out of the
paste. Both are new in pz 0.17.0.

## One node, one sample

`pz preview` takes a node name, as `pz ls` prints it, and exactly one of three modes:

| Mode | Reads | Good for |
|---|---|---|
| `--run <id>` | `.pz/runs/<id>/staging.duckdb`, read-only | What a finished run actually produced |
| `--run-dir <path>` | A run directory anywhere, with no project files | A run copied off a container or out of a backup |
| `--fresh` | The project as it is now, computed in memory | Checking a change before you run it |

Giving none, or two, is `PZ0539`. Whichever mode you pick, the output is a plain text table, or one
JSON object with `--json`.

## From a run: exactly what it left

```console
$ pz preview stg_customers --run 20260902T094011003Z-7c2a --limit 3
id   name          email (redacted)
---  ------------  ----------------
101  Ada Lovelace  •••
102  Alan Turing   •••
103  Grace Hopper  •••
3 of 1840 rows
```

This opens the run's staging database read-only and shows the node as that run left it, so it's
the same data the run's sinks and checks saw. The last line gives the relation's full row count
next to the number shown. `--limit` takes `1` to `500` and defaults to `50`.

The rows are a sample, in no particular order. There's no `ORDER BY` behind them, so they're not
the first rows by any key, and two previews of the same run can show different rows.

Source nodes and `table` and `view` pipelines can be previewed from a run. An ephemeral pipeline is
inlined into the nodes that read it and never stored, so there's nothing in staging to show
(`PZ0538`), and a sink or a check has no rows of its own in any mode. When a run has nothing for the
node, because it failed, wasn't selected, the run is still going, or its `staging.duckdb` has been
cleaned, `pz preview` says so with `PZ0537` rather than showing an empty table.

### A run directory carries its own index

Every `pz run` and `pz retry` records in its `staging.duckdb` which relation holds each node and
which columns are marked. That makes a run directory self-contained:

```console
$ pz preview stg_customers --run-dir /backups/runs/20260902T094011003Z-7c2a
```

No `project.yml`, no `connections.yml`, no credentials. That matters on the hosts where a run's
[staging database stays local](/blog/state-that-outlives-the-container/) and the project never
leaves the image: copy the run directory somewhere you can reach it, and you can preview any node
in it from a laptop. The one catch is age. A run written by a pz older than 0.17.0 has no index,
and reports `PZ0537`.

## Fresh: compute it now, touch nothing

```console
$ pz preview stg_customers --fresh
```

`--fresh` compiles the project as it is on disk right now and runs the node and its ancestors in a
throwaway in-memory DuckDB. It's for the change you haven't run yet: a new join, a fixed filter, or
an ephemeral pipeline, which a run never stores.

The guarantee that makes it safe to reach for is what it leaves alone. A fresh preview never runs a
sink or a check, never reads or writes state, and writes no run directory. No watermark moves, no
sync token is spent, no cdc slot is advanced, and `PZ_STATE_URL` plays no part. Sources are read
from the start, and a `cdc` dataset is read as a plain snapshot. Previewing a node ten times while
you iterate on its SQL costs the next real run nothing.

The price is completeness. Each source stops after `--slice` rows, `1000` by default and up to
`100000`, so the sample is built from a slice of every source, not from all of it:

```console
$ pz preview orders_enriched --fresh --slice 20000
```

A join between two slices can match far fewer rows than the real tables would, and totals and
counts can look thin. That's the slice, not a bug in the SQL. Raise `--slice` until the sample is
dense enough to judge, or run the pipeline and preview the run. `--vars` overrides vars for a fresh
preview. A run's preview doesn't take it, because that run's values are already baked into its
staging.

## Marking what nobody should see

A mark is one key. On a source, it goes in the long form of a `columns:` contract entry:

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

The same long form works in the `columns:` kwarg of a `source()` call. On a pipeline, the sidecar
takes a `columns:` list:

```yaml title="pipelines/configs/stg_customers.yml"
pipeline: stg_customers
columns:
  - name: email
    redact: true
  - name: phone
    redact: true
```

A marked column shows `•••` in every row, nulls included, so the sample doesn't even reveal which
customers have an email on file. Its header reads `email (redacted)`, and in JSON its column entry
carries `"redacted": true`.

### A mark belongs to one node

Marks don't follow a column through a pipeline. The mark on `raw.customers` protects the source's
sample. `stg_customers` selects that same `email` column, but its output is unmarked unless its own
sidecar marks it. Every node that outputs a sensitive column marks it in its own config.

That's more typing than inference would be, but it's predictable. The mark you read in a node's
config is exactly the set of columns its preview hides, with nothing derived from SQL you'd have to
trace to be sure. It also covers the gap a source can't fill: a source with no `columns:` contract
has nowhere to put a mark, so mark the column in the sidecar of the first pipeline that reads it.

The cost of a typo is a column you thought was hidden and isn't. `pz validate` checks every sidecar
mark against the pipeline's dry-compiled output, and a name that isn't there, usually a misspelling
or a column renamed in the SQL, is warning `PZ0403`. It's a warning rather than an error, so it
won't stop a run, but it's worth treating like one: a mark that names nothing protects nothing.

### What a mark is not

A mark is read by `pz preview` and nothing else. It changes no types, no node ids, and nothing a run
does. The staging database still holds the real values, and a sink still writes them. That makes
adding a mark free: no rebuild, no invalidated retry. It also means a mark keeps a column out of a
sample, not out of the data, so who can open `.pz/runs` is still a question for file permissions.

One more consequence of reading marks from a run: a run's marks are the ones the project had when
that run compiled it. Mark `phone` today and yesterday's run still shows phone numbers. Preview
fresh, or wait for the next run.

## A sample a tool can read

`--json` prints exactly one object on stdout, with its fields in a fixed order:

```json
{"node":"stg_customers","mode":"run","runId":"20260902T094011003Z-7c2a",
 "columns":[{"name":"id","type":"INTEGER","redacted":false},{"name":"email","type":"VARCHAR","redacted":true}],
 "rows":[[101,"•••"],[102,"•••"]],
 "totalRows":12408,"limit":50,"sliced":false}
```

`type` is the DuckDB type, `totalRows` is `null` in fresh mode, and `sliced` says whether the rows
came from source slices. Numbers, booleans and nulls stay JSON values, and everything else is a
string. Any string longer than 200 characters is cut to its first 200 followed by `…`, so a stray
blob column can't flood the output. A failure prints
`{"error":{"code":"PZ####","message":"..."}}` instead, and the exit code says which kind:

| Exit | Meaning |
|---|---|
| `0` | The sample printed |
| `1` | With `--fresh`, a node failed, and the error carries that node's own code |
| `2` | `PZ0537`, `PZ0538`, `PZ0539`, an unknown node, or a project configuration error |
| `3` | An unexpected failure |

That shape is what makes a preview safe to hand to something that isn't you. A CI job can attach
one to a pull request, and an [AI agent](/how-to/use-with-an-ai-agent/) can look at real rows
before it edits a pipeline's SQL. In both cases the redacted columns are already `•••` before the
output leaves pz.

## Try it

[Preview data](/how-to/preview-data/) walks through marking, running, and previewing step by step,
with a troubleshooting table for each error code. Every option and the full JSON shape are in the
[CLI reference](/reference/cli/#pz-preview). The two places a mark can live are documented in
[Pipeline config](/reference/pipeline-config/#columns) and
[Redacting columns](/reference/connections-yml/#redacting-columns). When a preview isn't enough
and you need to query staged tables directly, [Debug a failed run](/how-to/debug-a-failed-run/)
shows how.
