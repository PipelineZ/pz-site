---
title: "Architecture overview"
description: "PipelineZ is a CLI-first, batch-oriented ETL framework for .NET that applies dbt's philosophy to data movement, not analytics modeling. This article is the..."
---

PipelineZ is a CLI-first, batch-oriented ETL framework for .NET that applies dbt's philosophy
to **data movement**, not analytics modeling. This article is the hub for the concept pages:
it covers the design principles and how the pieces fit together.

<figure class="dgm">
  <a href="/diagrams/01-overview.png">
    <img class="dgm-light" loading="lazy" decoding="async" src="/diagrams/01-overview.png" alt="Overview: a pz project of YAML and SQL compiles to a DAG that DuckDB executes, producing data and a run receipt">
    <img class="dgm-dark" loading="lazy" decoding="async" src="/diagrams/01-overview-dark.png" alt="" aria-hidden="true">
  </a>
  <figcaption>Click the diagram to open it full size.</figcaption>
</figure>

## Design principles

- **Configuration as code** — the entire pipeline definition lives in versionable text files.
- **SQL-first** — transformations are DuckDB SQL files, not C# code.
- **Deterministic and reproducible** — pinned connector versions, lock files, rendered
  artifacts, stable node identities. Same project + same inputs ⇒ same behavior.
- **The CLI is the product** — connectors ship independently as NuGet packages; the CLI
  discovers, validates, and executes them through a stable ABI.
- **Performance is a feature** — columnar, zero-copy where possible, larger-than-memory by
  default, allocation-conscious.
- **Transparent execution** — you can always answer "what is it doing right now, and why is
  it slow?"

> [!NOTE]
> The v1 non-goals are equally deliberate: no streaming, no orchestration/scheduling (compose
> with Airflow, Dagster, or cron), no distributed execution, no UI. The
> [evolution path](#evolution-path) shows how those grow later without a redesign.

## How the pieces fit

PipelineZ is a **hub-and-spoke engine with DuckDB as the hub**. Sources land data into a
DuckDB staging database, SQL pipelines transform it inside DuckDB, and sinks drain results
out. Builtin connectors are compiled straight into the CLI; every other connector is a NuGet
package that `pz restore` pins and that runs as its own **out-of-process** connector, spawned
and driven over a small wire protocol (PCP) — the CLI process never loads third-party code
in-process. See [Connectors](/concepts/connectors/).

A universal-tier source that declares `StablePartitionIds` lands each partition into its own
part table instead of one shared ingest stream; a short transaction then moves a completed
partition into the main staging table together with a done row in an accounting ledger
(`pz_meta`, inside the same staging database), so a later attempt — the same run's retry loop
or a later `pz retry` — skips whatever already landed instead of re-extracting it. A partition
that also declares `CheckpointableReads` stages its progress through an additional segment
table, so a resume token always covers exactly the rows already committed. Connectors that
declare neither capability are unaffected: extraction stays the single shared-channel path it
has always been.

A sink whose connector declares `CheckpointableWrites` gets the mirror-image treatment on the
write side: the engine drains its input in a content-deterministic `order by all` and, after each
batch, asks the write session how many rows it has durably confirmed, persisting that acknowledged
count (fingerprinted against the drained relation's content) to a `pz_meta.sink_deliveries` row at
attempt teardown. A later attempt — same run or a later `pz retry` — resumes past the acknowledged
prefix instead of re-delivering from zero, provided the relation's content and the fingerprint
still match; any mismatch scratches the row and falls back to a full re-drain. Sinks that don't
declare the capability are unaffected: the drain stays the plain unordered `select *` it has
always been.

Layering is strictly downward:

| Layer | Responsibility | Depends on |
|---|---|---|
| `Pz.Cli` | argument parsing, console rendering, exit codes | Core, Engine |
| `Pz.Core` | project model, YAML/SQL parsing, template rendering, DAG compilation, validation | Abstractions |
| `Pz.Engine` | dispatch, node execution, retries, run artifacts | Core, DuckDb, Abstractions |
| `Pz.DuckDb` | thin interop layer over the DuckDB C API (Arrow ingest/export, query, EXPLAIN) | — |
| `Pz.PackageManagement` | NuGet resolution, lock file, connector materialization, the out-of-process connector host (PCP) | Abstractions |
| `Pz.Connectors.Abstractions` | the connector ABI (the only assembly connector authors reference) | Apache.Arrow only |

The **Abstractions assembly is the contract of the whole ecosystem**. It depends on nothing
but `Apache.Arrow` and the BCL, changes under a strict compatibility policy, and is
deliberately small. See [Connectors](/concepts/connectors/).

## The two-tier data plane

DuckDB already ships world-class readers and writers (Parquet, CSV, JSON, httpfs/S3,
`postgres_scanner`, and more). Streaming S3 Parquet bytes through .NET row by row when DuckDB
can scan them directly would waste that. So the data plane has two tiers, chosen per edge,
per run, by the planner:

1. **Native scan/copy** — the connector hands DuckDB a SQL fragment; data never enters .NET.
2. **Arrow batch stream** — the universal path that works for any system.

The engine prefers the native path and logs which tier each edge used. The full story,
including batch ownership rules, is in [The data plane](/concepts/data-plane/).

## Evolution path

The architecture grows toward these without a rewrite: the contracts — Arrow batches,
JSON configs, serializable plans, typed events — are transport- and location-neutral. Growth
changes implementations, never interfaces.

- **Incremental processing** — shipped (v0.2 unbounded watermarks, v0.3 bounded backfill
  windows): content-addressed node IDs, the `.pz/state` watermark store,
  `DatasetSpec.WatermarkCursor`/`WatermarkUpperBound`, and the `merge` sink mode. What was
  speculative at v0.1 needed no architectural change — only planner/executor logic and an
  additive capability flag (`BoundedWindow`).
- **CDC** — a source capability emitting change batches with op-type columns; DuckDB merge
  pipelines consume them. The batch-stream contract already fits.
- **Distributed execution** — `plan.json` is a serializable DAG of nodes with content hashes;
  nodes become dispatchable units; Arrow Flight replaces in-proc channels between workers.
  The format never changes, only the transport.
- **Orchestration integration** — `manifest.json` + selectors map directly onto
  Airflow/Dagster task generation, exactly how dbt integrations work today; exit codes and
  `run_results.json` are the contract.
- **Lineage** — the manifest already *is* table-level lineage; column-level comes from
  DuckDB's SQL parser (`json_serialize_sql`) over already-rendered SQL. An OpenLineage emitter
  is one more event renderer.
- **Cloud-native** — the CLI is already a self-contained batch job: container image + project
  mount + env secrets. Metrics and traces already speak OTel.

## Next steps

- [Key concepts](/concepts/key-concepts/) — the vocabulary, in plain language.
- [Project structure](/concepts/project-structure/) — what the files in a project mean.
- [The data plane](/concepts/data-plane/) — how bytes actually move.
- [The execution model](/concepts/execution-model/) — the DAG, the eight phases, dispatch.
- [Connectors](/concepts/connectors/) — the plugin architecture.
- [Validation and errors](/concepts/validation/) — the five tiers and the error philosophy.
- [Contributor internals](/concepts/contributing-internals/) — performance, testing, solution layout.
