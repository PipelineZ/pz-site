---
title: "The data plane"
description: "This article explains how bytes move through PipelineZ: why DuckDB is the hub, the two tiers a connector's data can travel on, why Arrow RecordBatch is the..."
---

This article explains how bytes move through PipelineZ: why DuckDB is the hub, the two tiers a
connector's data can travel on, why Arrow `RecordBatch` is the one canonical in-memory format,
and the ownership rules that keep the zero-copy path safe.

<figure class="dgm">
  <a href="/diagrams/03-data-plane.png">
    <img class="dgm-light" loading="lazy" decoding="async" src="/diagrams/03-data-plane.png" alt="The data plane: native scan versus streamed Arrow batches, chosen per edge">
    <img class="dgm-dark" loading="lazy" decoding="async" src="/diagrams/03-data-plane-dark.png" alt="" aria-hidden="true">
  </a>
  <figcaption>Click the diagram to open it full size.</figcaption>
</figure>

## DuckDB is the hub

Sources land data into a DuckDB staging database, SQL pipelines transform it inside DuckDB,
and sinks drain results out. The engine never tries to be a buffer manager — **DuckDB is the
buffer manager**:

- Staging is a **disk-backed DuckDB database file** (`.pz/runs/<id>/staging.duckdb`), not
  `:memory:`. DuckDB spills cold data, and its out-of-core operators (sort, hash join, window)
  handle datasets far beyond RAM, governed by its `memory_limit`.
- The .NET side holds only **in-flight batches**:
  `bounded_channel_capacity × batch_bytes × concurrent_nodes` — a small, predictable,
  configurable number.
- Sink egress streams: DuckDB result → Arrow batches → sink writer. Nothing is ever fully
  materialized in managed memory.

## Tier 1: native scan and copy

DuckDB already ships world-class readers and writers — Parquet, CSV, JSON, httpfs/S3,
`postgres_scanner`, `sqlite_scanner`, Iceberg, Delta. Streaming S3 Parquet bytes through .NET
row by row when DuckDB can scan them directly, in parallel, with predicate pushdown, would
throw that away.

On the native tier, the connector returns a DuckDB SQL fragment plus secret setup — for
example `read_parquet('s3://bucket/path/*.parquet')` and a `CREATE SECRET` statement. Data
never enters .NET memory; DuckDB pulls directly (or pushes, via `COPY TO`). The connector's
job reduces to configuration translation, and this is the fastest possible path.

The planner chooses the tier **per edge, per run**, prefers the native path, and logs which
tier each edge used — `pz plan` shows the choice and the reason before anything runs.

## Tier 2: the universal Arrow path

The universal tier is an async stream of Arrow `RecordBatch`es, produced by a source connector
or consumed by a sink connector. It works for *any* system — SaaS APIs, message queues drained
as batches, proprietary databases — and is the path the engine's internals optimize.

**Arrow `RecordBatch` is the one canonical in-memory format**, for four reasons:

1. **Zero-copy into and out of DuckDB.** DuckDB natively consumes Arrow streams via the C
   Data Interface (`ArrowArrayStream`) as a table scan and exports query results as Arrow.
   Ingest becomes `CREATE TABLE staging.x AS SELECT * FROM arrow_scan(...)` — DuckDB reads
   the connector's buffers directly, in parallel, with no per-value marshaling.
2. **Columnar batches amortize everything.** Type dispatch happens once per column per batch
   instead of once per value; conversion vectorizes; layouts are SIMD-friendly.
3. **Off-heap memory.** Arrow buffers live in native memory. A 64 MB batch is invisible to
   the GC; the managed heap stays small and Gen2/LOH churn disappears.
4. **It is the industry interchange standard.** ADBC drivers, Arrow Flight, Parquet, and every
   modern engine speak it — so distributed execution and out-of-process connectors later
   become transport changes, not format changes.

The alternatives (`DataTable`, `IDataRecord` rows, the DuckDB Appender API, memory-mapped
files) were each rejected as the canonical format — per-value copies, GC pressure, or no
ecosystem leverage. Ingest is a genuine columnar transfer — one native call converts a whole
batch across the Arrow C Data Interface, one more appends it, and no managed cost scales with
row count — and egress rides DuckDB's own Arrow export the same way.

**Row-based edges are embraced, not denied.** Most OLTP wire protocols are row-oriented
anyway, so the Abstractions package ships batteries:

- `ArrowBatchBuilder` — pooled, allocation-free column builders; connector authors push rows
  and get batches at a target byte size.
- `DataReaderSource` — wraps any `IDataReader`/`DbDataReader` into an Arrow batch stream, so
  an ADO.NET-backed connector is ~50 lines. The row→column pivot happens **once, at the edge,
  into pooled native buffers** — the only place row-orientation touches the system.

Batch sizing is **byte-targeted, not row-targeted** (default ~32 MB, configurable; rows per
batch also capped to keep DuckDB's 2048-row vectors well-fed). Wide and narrow tables both
land in the sweet spot: big enough to amortize per-batch overhead, small enough to keep
pipeline latency, memory bounds, and progress reporting granular.

## Batch ownership

> [!IMPORTANT]
> A batch handed to `WriteBatchAsync` is **engine-owned until the call returns**. Buffers are
> pooled native memory, recycled the instant the engine disposes the batch — a connector
> that holds a reference past the call observes recycled memory. Ownership bugs are the worst
> bugs in this system, and `Pz.Connectors.TestKit` enforces the lifetime protocol against
> every connector.

## Larger than memory

Because staging is disk-backed and the .NET side only ever holds in-flight batches, a dataset
larger than RAM is the *default* case, not a special mode. DuckDB's `memory_limit` governs
spill; the engine's own memory use stays bounded by the channel formula above.

## Next steps

- [The execution model](/concepts/execution-model/) — how nodes and channels drive this data plane.
- [Connectors](/concepts/connectors/) — the ABI a connector implements to feed it.
