---
title: "Handle schema drift"
description: "What happens when a source or target table changes shape under a running mart, how each change surfaces, and what to do about it. SQL Server examples; the..."
---

What happens when a source or target table changes shape under a running mart, how each
change surfaces, and what to do about it. SQL Server examples; the mechanics are
connector-generic.

## Prerequisites

- A runnable project with at least one networked source or sink. Follow the
  [quickstart](/quickstart/) to scaffold one.

## Detection surfaces

Two guards exist, at different times:

- **`pz validate --connect`** (tier 5, opt-in, run it on demand or before deploys): probes
  every source/sink connection and fetches each declared dataset's schema, comparing it to
  the dataset's `columns:` contract. All drift findings are reported together, not
  fail-fast.
- **Run time**: the source read fails if a referenced column is gone; the sink's
  `schema_policy: fail_on_change` (the default — `evolve` is rejected by the sqlserver
  sink) fails the write if the target table's columns no longer match the expected
  canonical types.

## Drift classes and what you'll see

| Change | Surfaces as |
|---|---|
| Source column **added** | Nothing — extra fetched columns are tolerated by design; contracts prune on read. Add it to `columns:` and your SQL when you want it. |
| Source column **removed/renamed** | `--connect`: a PZ0331 error — "declared column 'X' … missing from the fetched schema". Run time: the extraction query fails naming the column. |
| Source column **retyped** | `--connect`: a PZ0331 error naming the declared and fetched types. Run time: values may still widen silently if the new type maps to the same Arrow type — run `--connect` after suspected DDL changes rather than trusting a green run. |
| Target column missing/retyped | Sink fails with `fail_on_change`: "target column 'X' … has type 'decimal(18,2)', expected 'decimal(38,9)'" — align the target by hand, or drop the table and let the sink recreate it. |
| Target column **added** (nullable or identity) | Tolerated — the sink inserts an explicit column list; extra target columns (audit timestamps, surrogate identity keys) fill from their defaults. |

## The response playbook

1. **Confirm the drift**: `pz validate --connect --project <dir>` — read every PZ0331
   line; they aggregate.
2. **Update the contract**: edit the entity's `columns:` under `entities: <e>: read:` in `connections.yml` and any
   pipeline SQL that references changed columns.
3. **Mind the node IDs**: node IDs are content-addressed — editing a source or pipeline
   changes its ID, so a subsequent `pz retry` treats edited nodes as new (a stale failed
   node from the old shape won't be retried; run `pz run` for a full pass after schema
   edits).
4. **Mind the watermark**: if the drift touched the **cursor column** (renamed/retyped),
   the stored watermark value may no longer compare correctly against the new column.
   Run once with `--full-refresh` to re-establish the watermark from a full extract.
   Merge/replace sinks stay effectively-once under re-extraction; append sinks will
   duplicate (that's the PZ0214 `write: { duplicates: accept }` consent).
5. **Align the target last**: for `fail_on_change` failures, apply the matching `ALTER
   TABLE` by hand (the error names expected canonical types), or drop and let the sink
   recreate — recreating loses target-side extras like identity values.

## Limits worth knowing

- Retype drift that lands on the same Arrow type (e.g. `varchar` → `nvarchar`) is
  invisible at run time and only reported by `--connect`.
- `--connect` validates datasets that declare a `columns:` contract; a `query:` dataset
  without one is probed and its fetched schema reported, but nothing is contract-checked —
  prefer declared contracts on mart-critical datasets.
