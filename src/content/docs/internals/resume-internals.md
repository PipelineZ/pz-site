---
title: "Resume internals"
description: "This page documents the ledgers and mechanisms behind pz retry: the pz_meta schema, part and segment tables, delivery checkpoints, attempt identity, and sync-state replay."
sidebar:
  order: 4
---

This page is for contributors. It documents the actual tables and classes behind resume and
retry: the `pz_meta` accounting schema, part tables and `StablePartitionIds`, segment tables and
`CheckpointableReads`, the delivery ledger behind `CheckpointableWrites`, attempt identity, and
what `pz retry` reuses. For the guarantees this machinery exists to uphold, see
[Delivery guarantees](/concepts/delivery-guarantees/); this page is the mechanism underneath it.

## `pz_meta`: the accounting schema

Every run's `staging.duckdb` carries a second schema, `pz_meta`, alongside `staging`. It holds
the progress records a failure cannot destroy, written in the same DuckDB transaction as the
data they account for. `PzMeta.EnsureSchemaAsync` creates it, and `PartitionLedger` and
`SinkDeliveryLedger` are its two writers. Because the ledger write and the data write share a
transaction, "rows are in `staging`" and "the ledger says done" can never disagree.

`pz_meta` travels with the staging database. When `pz retry` needs a failed run's progress, it
`ATTACH`es that run's `staging.duckdb` read-only under a per-node alias and reads the prior
run's `pz_meta` tables directly, then `DETACH`es. It's the same attach-and-copy mechanism the
staging-reuse section below uses for source data.

## Part tables and `StablePartitionIds`

A source that declares `ConnectorCapabilities.StablePartitionIds` promises that every partition
it plans carries a stable, engine-opaque id: planning the same dataset again, in a later attempt
of the same run or a later `pz retry`, yields the same id for the same logical slice. Under this
flag, each partition lands into its own **part table** instead of the shared ingest stream,
named `staging.__pz_part__<nodeKey>__<hash>`, where `<hash>` is the first 16 hex characters of a
SHA-256 of the partition id (`PartitionLedger.PartTable`). Raw partition ids never appear in
events, notices, or errors, only their hash, inside a table name.

Three tables in `pz_meta` track this:

| Table | Tracks |
|---|---|
| `pz_meta.partitions_done` | Which `(node_id, partition_id)` pairs are fully staged in the main table, and their row count. |
| `pz_meta.partition_checkpoints` | A partition's in-progress checkpoint token and the row count it covers. |
| `pz_meta.node_window` | The `(lower, upper)` extraction window a node ran under. |

Completing a partition is one transaction (`PartitionLedger.CompleteStatements`): its rows move
from the part table into the main staging table, the part table drops, and a done row lands in
`partitions_done`. On a retry, partitions already marked done are skipped entirely, since their
rows already persist in `staging`, so a transient failure re-reads only the partitions that failed.

## Segment tables and `CheckpointableReads`

`CheckpointableReads` is declared only together with `StablePartitionIds`; the planner refuses
the combination otherwise (`PZ0319`). A partition that can resume mid-read from an opaque token
stages its progress through a **segment table**, `staging.__pz_seg__<nodeKey>__<hash>`
(`PartitionLedger.SegTable`), so a resume token always covers exactly the rows already committed
there. The engine calls `TryGetCheckpoint` only after every row so far is durably staged, and
`TryResumeFrom` before `ReadAsync` on a retry; returning `false` (never throwing) restarts the
partition from scratch. Tokens live only in `pz_meta.partition_checkpoints`, never in logs.

## `CheckpointableWrites`: acknowledged counts and fingerprints

A sink whose connector declares `CheckpointableWrites` gets an engine-owned delivery ledger:
`pz_meta.sink_deliveries`, one row per node id, holding `acknowledged_rows` plus a content
**fingerprint** of the relation the engine drained (`SinkDeliveryLedger.Fingerprint`: a row
count and an order-independent aggregate hash, computed as the sum of a `HUGEINT` per-row hash).

The engine drains the sink's input in a content-deterministic `order by all`, and after each
batch asks the write session how many rows it has durably confirmed
(`ICheckpointingSinkSession.TryGetAcknowledgedRows`). At attempt teardown, success or failure,
the acknowledged count and the fingerprint are persisted together (delete-then-insert, upsert-
safe under a crash mid-write). A later attempt re-fingerprints the relation, and only when both
the row count and the content hash still match does it resume the drain
(`TryResumeFrom(acknowledgedRows)`) past the acknowledged prefix. Any mismatch scratches the row
and falls back to a full re-drain. The ledger is written only from counts the destination
actually confirmed, never from rows merely sent, so a resume never skips a row the destination
hasn't seen.

## Attempt identity

Every `SinkWrite` reaching a connector through the universal tier carries `OutputSpec.Attempt`,
a `WriteAttempt` record of three fields: `Node` (the output's content-addressed node id), `Run`
(the run the attempt belongs to), and `Ordinal` (which attempt within that run, counting from
1). A sink whose destination can record a durable progress marker transactionally with the data
can stamp `Attempt` on commit and read it back at the start of the next attempt, to skip work an
earlier attempt already committed, closing the within-run duplicate window for a commit that
reached the destination but was never reported back to `pz`. `Attempt` does not span runs: a
second `pz run` is a new `Run`, and it is absent on the native-copy path, where there is no
write session to carry it.

## Sync-state replay

A **feed-shaped** dataset (no `sync:` block, or an explicit `mode: auto` that the connector
resolves to `feed`) carries an opaque **sync-state token** instead of an orderable cursor: a
connector-issued "call this next time" pointer, such as a delta link. The engine stores it in
`.pz/state/sync-state.json` and replays it verbatim on `DatasetSpec.PriorSyncState`, never
inspecting or comparing it. A connector implements `ISyncStatePartition.TryGetSyncStateCandidate`
to hand back the next token; the engine calls it exactly once per run, after `ReadAsync`'s
enumeration completes cleanly, never mid-read or on a failed read. Advancement follows the same
commit-gated rule as a watermark: the token only advances after every downstream sink for that
dataset has committed. A feed-shaped dataset is always single-partition, because one opaque
token cannot reconcile state across independent partitions (`PZ0316`).

## What `pz retry` reuses

`pz retry` re-runs only failed and skipped nodes, plus their ancestors. Two mechanisms close the
gap so a fully successful retry can still advance a watermark:

- **Staging reuse.** For each `SourceLoad`, when the prior run recorded that node `success`
  under the same content-hash id, the prior `staging.duckdb` still exists and contains that
  node's staging table, and `--full-refresh` was not passed, the executor copies the table
  before the connector is ever resolved:

  ```sql
  ATTACH '<prior run dir>/staging.duckdb' AS pz_prior_<node id> (READ_ONLY);
  CREATE OR REPLACE TABLE staging.<table> AS SELECT * FROM pz_prior_<node id>.staging.<table>;
  -- verify COUNT(*) matches the prior run's recorded row count
  DETACH pz_prior_<node id>;
  ```

  Any guard failing (a row-count mismatch, a missing table, a locked file) drops what was
  copied and falls back to normal extraction through the connector, with a `note:` naming the
  reason. The node completes with `provenance: reused` on success.

- **Carried-forward sinks.** Before dispatch, `pz retry` seeds the run's results with every
  `SinkWrite` that succeeded in the prior run, has an unchanged id in the recompiled DAG, and,
  the soundness condition, has every `SourceLoad` ancestor being reused this retry, not falling
  back to re-extraction. That node is recorded as already-completed with `provenance:
  carried_forward`, never dispatched, and counts toward the all-structural-sinks-committed rule
  that gates watermark advancement.

Only `SourceLoad` nodes are ever reused this way. Pipelines and Checks are always recomputed:
they're cheap inside DuckDB, and recomputation avoids any question about per-run template
constants (`run_id`, `run_started_at`) baked into their rendered SQL.

## Related

- [Delivery guarantees](/concepts/delivery-guarantees/): the stability contract this machinery upholds.
- [Execution internals](/internals/execution-internals/): the run artifacts these ledgers travel alongside.
- [Connector architecture](/internals/connector-architecture/): the capability flags a connector declares to opt in.
- [Architecture](/internals/architecture/): where `Pz.Engine` sits in the layering.
