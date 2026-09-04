---
title: "Data plane"
description: "This page explains how bytes physically move through PipelineZ: the native and universal tiers, why Arrow RecordBatch is the one canonical in-memory format, batch ownership, and how the planner chooses a tier per edge."
sidebar:
  order: 2
---

This page is for contributors. It explains how bytes physically move through `pz`: why DuckDB
is the hub, the two tiers a connector's data can travel on, why Arrow `RecordBatch` is the one
canonical in-memory format, and the ownership rules that keep the zero-copy path safe.

<figure class="dgm">
  <a href="/diagrams/03-data-plane.png">
    <img class="dgm-light" loading="lazy" decoding="async" src="/diagrams/03-data-plane.png" alt="The data plane: native scan versus streamed Arrow batches, chosen per edge" />
    <img class="dgm-dark" loading="lazy" decoding="async" src="/diagrams/03-data-plane-dark.png" alt="" aria-hidden="true" />
  </a>
  <figcaption>Click the diagram to open it full size.</figcaption>
</figure>

## DuckDB is the hub

Sources land data into a DuckDB staging database, SQL pipelines transform it inside DuckDB,
and sinks drain results out. The engine never tries to be a buffer manager. DuckDB is the
buffer manager:

- Staging is a **disk-backed DuckDB database file** (`.pz/runs/<id>/staging.duckdb`), not
  `:memory:`. DuckDB spills cold data, and its out-of-core operators handle datasets far
  beyond RAM, governed by its `memory_limit`.
- The .NET side holds only **in-flight batches**: `bounded_channel_capacity × batch_bytes ×
  concurrent_nodes`, a small, predictable, configurable number.
- Sink egress streams: DuckDB result to Arrow batches to sink writer. Nothing is ever fully
  materialized in managed memory.

## Tier 1: native scan and copy

On the native tier, the connector returns a DuckDB SQL fragment plus setup statements, for
example `read_parquet('s3://bucket/path/*.parquet')` and a `CREATE SECRET` statement. Data
never enters .NET memory; DuckDB pulls directly, or pushes via `COPY TO`. The connector's job
reduces to configuration translation, and this is the fastest possible path. Setup statements
run once per run, not once per node: the engine keys them by exact statement text, so every
node that needs the same extension load, secret, session setting, or attach shares one execution,
concurrent nodes await the one in flight, and a statement that failed is re-issued when the node
retries. MotherDuck depends on this, since its extension accepts a token only before its first
attach. A connector
declares this on the read side with `ConnectorCapabilities.NativeScan`
(`ISource.TryGetNativeScan`) and on the write side with `NativeCopy` (`ISink.TryGetNativeCopy`).

The planner chooses the tier **per edge, per run**, prefers the native path, and logs which
tier each edge used. `pz plan` shows the choice and the reason before anything runs.

## Tier 2: the universal Arrow path

The universal tier is an async stream of Arrow `RecordBatch`es, produced by a source connector
or consumed by a sink connector. It works for any system: SaaS APIs, message queues drained as
batches, proprietary databases. It is the path the engine's internals optimize.

**Arrow `RecordBatch` is the one canonical in-memory format**, for four reasons:

1. **Zero-copy into and out of DuckDB.** DuckDB natively consumes Arrow streams via the C
   Data Interface (`ArrowArrayStream`) as a table scan and exports query results as Arrow.
   Ingest becomes a scan over the connector's own buffers, with no per-value marshaling.
2. **Columnar batches amortize everything.** Type dispatch happens once per column per batch
   instead of once per value, conversion vectorizes, and layouts are SIMD-friendly.
3. **Off-heap memory.** Arrow buffers live in native memory from a pooling allocator. A 64 MB
   batch is invisible to the GC; the managed heap stays small.
4. **It is the industry interchange standard.** ADBC drivers, Arrow Flight, Parquet, and every
   modern engine speak it, so out-of-process connectors and distributed execution are
   transport changes, not format changes.

Row-based edges are embraced, not denied. Most OLTP wire protocols are row-oriented anyway, so
`Pz.Connectors.Abstractions` ships batteries: an `ArrowBatchBuilder` for pooled, allocation-free
column builders, and a `DataReaderSource` that wraps any `DbDataReader` into an Arrow batch
stream, so an ADO.NET-backed connector is around 50 lines. The row-to-column pivot happens once,
at the edge, into pooled native buffers, the only place row orientation touches the system.

Batch sizing is **byte-targeted, not row-targeted**: `engine.batch_bytes` defaults to about
32 MB and is configurable, with rows per batch also capped to keep DuckDB's vectors well-fed.

## Batch ownership

:::caution
A batch handed to `WriteBatchAsync` is **engine-owned until the call returns**. Buffers are
pooled native memory, recycled the instant the engine disposes the batch. A connector that
holds a reference past the call observes recycled memory. Ownership bugs are the worst bugs
in this system, and `Pz.Connectors.TestKit` enforces the lifetime protocol against every
connector.
:::

## Tier selection: `engine.force_universal` and PZ0312

`engine.force_universal` in `project.yml` is an escape hatch that forces the universal tier
even when a native scan or copy is available, useful for debugging or working around a native-
path bug. Some connectors have no universal route at all for a given edge: they implement the
empty marker interface `INativeOnlySource` or `INativeOnlySink`, which tells the planner there
is nothing to fall back to.

When a run asks for the universal tier on an edge that can't provide one, the planner refuses
the combination outright rather than planning "successfully" onto a partition or write-session
call that would only fail once the run reached it:

| Connector | Native-only reads | Native-only writes |
|---|---|---|
| `mysql` | Yes (DuckDB `mysql` extension is the whole data plane) | Yes |
| `sqlite` | Yes (DuckDB `sqlite` extension is the whole data plane) | Yes |
| `duckdb` | Yes (the engine's own session attaches the file) | Yes |
| `ducklake` | Yes (DuckDB `ducklake` extension is the whole data plane) | Yes |
| `motherduck` | Yes (DuckDB `motherduck` extension is the whole data plane) | Yes |
| `quack` | Yes (DuckDB `quack` extension is the whole data plane) | Yes |
| `iceberg` | Yes (DuckDB `iceberg` extension is the whole data plane) | Yes |
| `s3` | No, but native both directions; `force_universal` still refused | No |
| `azureblob` | Yes | No, writes run either tier (`partition_by` fan-out needs the universal tier) |
| `gcs` | Only under `hmac` auth; `service_account`/`adc` are write-only, universal-tier | No |

`postgres`, `sqlserver`, and `http` have no native tier at all, so `force_universal` is moot
for them. Requesting the universal tier where it doesn't exist, whether via
`engine.force_universal` or via a universal-only dataset option like `files_per_partition` on a
native-only connector, is `PZ0312`, naming the option, dataset, and connector.

## Larger than memory

Because staging is disk-backed and the .NET side only ever holds in-flight batches, a dataset
larger than RAM is the default case, not a special mode. DuckDB's `memory_limit` governs spill;
the engine's own memory use stays bounded by the channel formula above.

## Related

- [Architecture](/internals/architecture/): where the data plane fits in the layering.
- [Execution internals](/internals/execution-internals/): the dispatcher and channels that drive it.
- [Connector architecture](/internals/connector-architecture/): the ABI a connector implements to feed it.
- [Connectors](/concepts/connectors/): the user-facing view of native vs universal tiers.
