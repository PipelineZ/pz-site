---
title: "Run checks and retry"
description: "How to run only your data-quality checks with pz test, gate a run behind them, and resume a failed run with pz retry instead of re-running everything."
sidebar:
  order: 4
---

This page shows how to run only your data-quality checks with `pz test`, gate a run behind them,
and resume a failed run with `pz retry`. Read it once you have a project with at least one
[check](/concepts/checks/) declared.

## Prerequisites

- A runnable project. Follow the [quickstart](/quickstart/) to scaffold one.
- At least one pipeline with a `checks:` block in its sidecar config. See
  [Checks](/concepts/checks/) for the six check types and where they're declared.

## Steps

### 1. Run only the checks

```console
$ pz test
ok src_raw__customers 3 rows 38ms
ok stg_orders 3 rows 7ms
ok orders_enriched 3 rows 6ms
ok check_orders_enriched_not_null_id_email 0 rows 6ms
ok check_orders_enriched_unique_id 0 rows 3ms
run 20260902T092011003Z-3b7a: 5 succeeded, 0 failed, 0 skipped (.pz/runs/20260902T092011003Z-3b7a/run_results.json)
```

`pz test` runs every check plus the nodes it depends on: the owning pipeline and its sources.
Anything with no check downstream is skipped. `pz test` takes `--select` to narrow which checks
run, but no positional flow name: see [Selecting nodes](/concepts/selecting-nodes/).

### 2. Gate a run behind checks passing

A check is observational. It fails the run but does not stop its pipeline's sink writes: the
check and the write are siblings, not a gate in front of a door. See
[Checks](/concepts/checks/#checks-observe-they-dont-gate) for why. If bad data must never reach a
destination, chain the two commands yourself:

```console
$ pz test && pz run
```

`pz test` writes to no sink, so the load only happens once every check has passed.

### 3. Resume a failed run

When `pz run` fails partway through, fix the cause, then resume with `pz retry` instead of
starting over:

```console
$ pz retry
ok src_raw__customers 3 rows 41ms
note: reusing staged data for 1 source load(s)
ok stg_orders 3 rows 6ms
ok orders_enriched 3 rows 5ms
run 20260902T092530118Z-c41f: 3 succeeded, 0 failed, 0 skipped (.pz/runs/20260902T092530118Z-c41f/run_results.json)
```

`pz retry` reads the most recent run's `run_results.json` and re-executes only the nodes that
didn't succeed, plus the ancestors they need. Succeeded source loads are not re-extracted: their
staged tables are copied from the failed run's retained staging database, so the source system
isn't contacted again for data it already delivered. Sinks that already committed are carried
forward, which lets a watermark advance once the retry succeeds. `pz retry` takes no `--select`
or `--vars`: it re-runs the prior intent verbatim.

With nothing to fix, it says so and exits cleanly:

```console
$ pz retry
nothing to retry (run 20260902T092530118Z-c41f succeeded)
```

## Verify

Check the exit code of either command: `0` means every node succeeded, `1` means at least one
failed. See the full table in the [CLI reference](/reference/cli/#exit-codes).

```console
$ pz test; echo $?
0
```

## Troubleshooting

| If you see | Do |
|---|---|
| A check fails but the sink still wrote the rows | This is expected: checks are observational. Chain `pz test && pz run` if the write must be gated. |
| `PZ0113` at compile time | A check's type is misspelled, or its options are malformed. Fix it before any data moves. |
| `PZ0510` from `pz test` or `pz run` | A check found violating rows. Read the row sample in `run_results.json`, or opt out with `sample_values: false`. |
| `pz retry` says "nothing to retry" but you expected a resume | The last run already succeeded. Check `pz state show` or `run_results.json` for the run you meant. |
| A retried node re-extracts everything instead of reusing staged data | The prior run's staging database was deleted (by `pz clean`, for example), or `--full-refresh` was passed. Reuse only applies to the immediately prior run's own staging file. |

## Related

- [Checks](/concepts/checks/): the six check types, where they're declared, and why they don't
  gate sink writes.
- [Selecting nodes](/concepts/selecting-nodes/): the `--select` grammar `pz test` accepts.
- [Debug a failed run](/how-to/debug-a-failed-run/): the full diagnostic ladder for a run that
  failed, before you reach for `pz retry`.
- [Tune retries](/how-to/tune-retries/): automatic retries for transient failures, which run
  before a node ever reaches `pz retry`.
- [CLI reference](/reference/cli/): every flag on `pz test` and `pz retry`, and the exit code
  table.
