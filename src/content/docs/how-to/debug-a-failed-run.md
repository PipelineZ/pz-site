---
title: "Debug a failed run"
description: "A diagnostic ladder for a failed pz run: the console summary, run_results.json, the NDJSON event stream, pz plan, pz validate --connect, the staged tables, and pz retry."
sidebar:
  order: 9
---

This page walks through diagnosing a failed `pz run`, from the one-line summary down to querying
the staged data yourself. Work through it top to bottom: each step needs less guessing than the
one before it, but costs a little more to run.

## Prerequisites

- A project that ran and left behind at least one failed or skipped node.

## Steps

### 1. Read the console summary and exit code

Every node prints one line as it finishes. A failed node prints its error code and message
indented underneath:

```console
$ pz run --all; echo "exit $?"
ok src_crm__orders 4200 rows 810ms
FAIL lake.orders_curated 0 rows 120ms
  PZ0501: sink 'lake' output 'orders_curated': connection reset by peer
run 20260902T094011003Z-7c2a: 1 succeeded, 1 failed, 0 skipped (.pz/runs/20260902T094011003Z-7c2a/run_results.json)
exit 1
```

| Exit code | Meaning |
|---|---|
| `0` | Every node succeeded. |
| `1` | The run finished, but at least one node failed. |
| `2` | A configuration or validation error stopped the run before it started. |
| `3` | An unexpected, fatal error. |

Exit `2` means the problem is in `connections.yml`, `project.yml`, or pipeline SQL, not in a
running node: no run directory is created, so skip straight to `pz validate` below instead of
looking for a `run_results.json`. Exit `1` means at least one node ran and failed: keep reading.

### 2. Open run_results.json

The summary line names the file. It's written incrementally as nodes finish, so it's readable
even after a crash mid-run:

```console
$ cat .pz/runs/20260902T094011003Z-7c2a/run_results.json
```

Each entry under `nodes` carries `id`, `kind`, `name`, `status`, `rows`, `durationMs`, and an
`error` object (`code`, `message`) or `null`. A failed node's full, untruncated error message
lives here even when the console only showed its first line. Optional fields appear only when
they apply: `timings` (producer/consumer stall, for a channel-instrumented node), `ops`
(operation-gate counts, on a rate-limited connector), `partitions`, `delivery` (checkpoint
resume stats), `cdc`, `observed_schema` (under `on_source_drift`), and `watermark` (the candidate
cursor value a source load produced).

### 3. Re-run with the event stream

For a fuller picture of what led up to the failure, not just its final state, re-run with
`--log-format json` and read the NDJSON stream it writes to stdout:

```console
$ pz run --all --log-format json > run.ndjson
$ grep node_completed run.ndjson | tail -5
```

Every event shares `event`, `at`, and `runId`. For one node, events arrive in order:
`node_started`, then zero or more `node_progress`, `retry_scheduled` on a transient failure, then
`node_completed`. See the [run events reference](/reference/events/) for every event's full field
list, including `source_drift_detected` and `breaker_state_changed`.

### 4. Check what pz plan says would run

```console
$ pz plan
strategy      node                        reason
arrow_stream  src_crm__orders             arrow stream: connector 'postgres' has no native path
native_copy   lake.orders_curated         localfiles supports native copy
```

`pz plan` compiles the full project and shows the strategy and reason for every node, without
running anything. Use it to confirm the node that failed is using the tier and connector you
expect, and that a selection (a flow name, `--select`, or `--all`) reaches the nodes you think it
does.

### 5. Probe connectivity with pz validate --connect

If the failure looks like a connection problem rather than a bad query, probe it directly:

```console
$ pz validate --connect
error PZ0330: source 'crm' connection check failed: connection refused
```

This also fetches every declared entity's live schema and diffs it against its `columns:`
contract, so a `PZ0331` here points at drift instead of a dropped connection. See
[Guard against schema changes](/how-to/handle-schema-drift/).

### 6. Query the staged table directly

A run's staging database survives the run, success or failure, at
`.pz/runs/<run-id>/staging.duckdb`. Open it with the `duckdb` CLI and query the `staging` schema
to see exactly what landed:

```console
$ duckdb .pz/runs/20260902T094011003Z-7c2a/staging.duckdb \
    "select * from staging.src_crm__orders limit 5"
```

A source load's table is named `src_<connection>__<entity>`; a pipeline's table is named after
the pipeline itself, `staging.orders_enriched`. This is the fastest way to tell whether a failed
sink write had bad data to work with, or never got the chance to run at all.

### 7. Resume with pz retry

Once you've fixed the cause, resume instead of starting over:

```console
$ pz retry
note: reusing staged data for 1 source load(s)
FAIL lake.orders_curated 0 rows 95ms
  PZ0501: sink 'lake' output 'orders_curated': connection reset by peer
run 20260902T094530118Z-2b9d: 0 succeeded, 1 failed, 0 skipped (.pz/runs/20260902T094530118Z-2b9d/run_results.json)
```

`pz retry` re-executes only the nodes that didn't succeed, plus their required ancestors.
Succeeded source loads aren't re-extracted: their staged tables are reused from the prior run.
See [Run checks and retry](/how-to/run-checks-and-retry/) for the full mechanics.

### 8. Check pz state show for watermark problems

If a node succeeds but reads the wrong slice of data, or `--full-refresh` doesn't seem to have
reset anything, check the stored watermark directly:

```console
$ pz state show crm.orders
crm.orders — cursor updated_at (timestamp)
  current  2026-08-30T11:04:00Z  run 20260828T110000000Z-4f1a
```

Add `history` context automatically: naming a key also lists that entity's run-by-run history and
any manual edits, so you can see exactly which run last advanced it. Use `pz state rollback` or
`pz state set` to correct a wrong value; see [State](/concepts/state/).

### 9. --full-refresh as a last resort

If the staged data itself looks wrong in a way retry can't fix, such as a watermark or contract
that no longer matches reality, re-run ignoring all stored state:

```console
$ pz run --all --full-refresh
```

This re-extracts everything and re-establishes every watermark and sync-state entry from the full
extract. It's the most expensive option here: reach for it only after the cheaper steps above
haven't explained the failure.

## Verify

Once a node succeeds, confirm the exit code is `0` and, for an incremental entity, that
`pz state show` reports a watermark newer than before.

## Troubleshooting

| Code | Meaning | Where it surfaces |
|---|---|---|
| [`PZ0201`](/reference/error-codes/) | A `source()`/`ref()` call is malformed: missing arguments, or extra positional arguments where only keyword options belong. | Rendering pipeline SQL |
| [`PZ0301`](/reference/error-codes/) | A connection or entity config value fails the connector's own published schema. | Loading `connections.yml` |
| [`PZ0312`](/reference/error-codes/) | An entity option needs the universal read path, but its connector supports only the native path. | Compiling the DAG, planning execution |
| [`PZ0313`](/reference/error-codes/) | An entity declares `max_window`, but its connector doesn't declare bounded-window support. | Planning execution |
| [`PZ0331`](/reference/error-codes/) | A live-fetched schema disagrees with a `columns:` contract, or an entity's last observed schema. | `pz validate --connect`, `pz run` |
| [`PZ0510`](/reference/error-codes/) | A data-quality check found violating rows. | `pz test`, `pz run` |

## Related

- [How a run works](/concepts/how-a-run-works/): the phases a run passes through, and what each
  artifact in `.pz/runs/<id>/` holds.
- [Run events reference](/reference/events/): every NDJSON event's full field list.
- [Run checks and retry](/how-to/run-checks-and-retry/): the full `pz retry` mechanics.
- [State](/concepts/state/): the full `.pz/state/` layout and every `pz state` subcommand.
- [Error codes reference](/reference/error-codes/): the complete `PZ####` registry.
