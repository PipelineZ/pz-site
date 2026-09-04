---
title: "Architecture"
description: "This page is the hub for contributors: the design principles behind PipelineZ, how the pieces fit together, and the strict layering of the solution."
sidebar:
  order: 1
---

This page is for someone working on `pz` itself, not using it. It covers the design principles
behind the engine, how the pieces fit together, and the layering every project in the solution
follows. If you're looking for how `pz` behaves as a user, start at
[Key concepts](/concepts/key-concepts/) instead.

<figure class="dgm">
  <a href="/diagrams/01-overview.png">
    <img class="dgm-light" loading="lazy" decoding="async" src="/diagrams/01-overview.png" alt="Overview: a pz project of YAML and SQL compiles to a DAG that DuckDB executes, producing data and a run receipt" />
    <img class="dgm-dark" loading="lazy" decoding="async" src="/diagrams/01-overview-dark.png" alt="" aria-hidden="true" />
  </a>
  <figcaption>Click the diagram to open it full size.</figcaption>
</figure>

## Design principles

- **Configuration as code.** The entire pipeline definition lives in versionable text files.
- **SQL-first.** Transformations are DuckDB SQL files, not C# code.
- **Deterministic and reproducible.** Pinned connector versions, a lock file, rendered
  artifacts, and stable node identities. Same project plus same inputs means same behavior.
- **The CLI is the product.** Connectors ship independently as NuGet packages. The CLI
  discovers, validates, and executes them through a stable ABI.
- **Performance is a feature.** Columnar, zero-copy where possible, larger-than-memory by
  default, allocation-conscious.
- **Transparent execution.** A contributor or an operator can always answer "what is it doing
  right now, and why is it slow?"

:::note
The v1 non-goals are equally deliberate: no streaming, no orchestration or scheduling (compose
with Airflow, Dagster, or cron instead), no distributed execution, no UI. The contracts these
choices rest on, Arrow batches, JSON configs, a serializable plan, and typed events, are
transport- and location-neutral, so growing past a non-goal later changes an implementation,
not an interface.
:::

## How the pieces fit

PipelineZ is a **hub-and-spoke engine with DuckDB as the hub**. Sources land data into a
DuckDB staging database, SQL pipelines transform it inside DuckDB, and sinks drain results
out. Builtin connectors are compiled straight into the CLI; every other connector is a NuGet
package that `pz restore` pins and that runs as its own **out-of-process** connector, spawned
and driven over a small wire protocol (PCP). The CLI process never loads third-party code
in-process. See [Connector architecture](/internals/connector-architecture/).

Two capability-gated resume mechanisms sit underneath the run loop, one on the read side and
one on the write side: a source that declares `StablePartitionIds` lands each partition into
its own part table instead of a shared ingest stream, and a sink that declares
`CheckpointableWrites` gets an engine-owned delivery ledger tracking how many rows the
destination has durably confirmed. Both are covered in full, with the actual table names and
schema, in [Resume internals](/internals/resume-internals/).

## Layering

Layering is strictly downward: a project may only reference the ones below it in this table.

| Project | Responsibility |
|---|---|
| `Pz.Cli` | Verbs, argument parsing, console rendering, exit codes. Thin; real work is delegated down. |
| `Pz.Core` | Project model, YAML/SQL parsing, Scriban template rendering, DAG compilation, validation. |
| `Pz.Engine` | Dispatcher, node executors, retries, run artifacts, watermark and sync-state stores. |
| `Pz.DuckDb` | Thin interop layer over the DuckDB C API: Arrow ingest/export, query, `EXPLAIN`. |
| `Pz.PackageManagement` | In-process NuGet resolution, the lock file, connector materialization, and the out-of-process connector host (PCP). |
| `Pz.Connectors.Abstractions` | The connector ABI: the contract of the whole ecosystem. References `Apache.Arrow` only. |
| `Pz.Connectors.Protocol` | Generated gRPC/protobuf code for the PCP wire format. Not a connector-authoring surface. |
| `Pz.Connectors.TestKit` | The acceptance and contract test suite every connector, builtin or external, runs against. |
| `Pz.Connectors.Toolkit` | Shared connector mechanism (format codecs, HTTP paging, auth, `{{ binding }}` expansion, transient-error classification) for **builtin** connectors. An ordinary transitive dependency, not part of the ABI. |
| `Pz.Diagnostics` | One typed event stream; console and NDJSON renderers, plus OpenTelemetry plumbing, are views over it. |
| `Pz.Mcp` | The `pz mcp` server: typed tools for introspection, verification, authoring, and docs. Run-triggering tools require `--allow-run`. |
| `Pz.State.Http` | A pluggable state backend: keyed watermark/sync-state storage over a server's run-scoped HTTP endpoints. |
| `Pz.State.SqlServer` | A pluggable state backend over SQL Server, with schema creation, migration, and batched run-artifact persistence. |
| `connectors/` | The fifteen first-party connectors: LocalFiles, Postgres, S3, SqlServer, AzureBlob, Gcs, Http, MySql, Sqlite, Sftp, DuckDb, DuckLake, Quack, MotherDuck, Iceberg. |

The **Abstractions assembly is the contract of the whole ecosystem**. It changes under a
strict additive-only compatibility policy: growth happens through new optional capability
interfaces and new `ConnectorCapabilities` flags, never through a breaking change to an
existing interface. See [Connector architecture](/internals/connector-architecture/).

## The two-tier data plane

DuckDB already ships world-class readers and writers: Parquet, CSV, JSON, `httpfs`/S3,
extensions for Postgres, MySQL, SQLite, and Azure. Streaming those bytes through .NET row by
row when DuckDB can scan them directly would waste that. So the data plane has two tiers,
chosen per edge, per run, by the planner: a native scan/copy where the connector hands DuckDB
a SQL fragment, or the universal Arrow batch stream that works for any system. The full story,
including batch ownership rules and the `engine.force_universal` escape hatch, is in
[The data plane](/internals/data-plane/).

## What's shipped and what's next

Everything above is shipped, including incremental processing (unbounded watermarks and
bounded backfill windows) and change data capture, which lands change batches with op-type
columns that DuckDB merge pipelines consume. What the architecture still grows toward without
a rewrite: distributed execution (`plan.json` is already a serializable DAG of content-hashed
nodes; Arrow Flight would replace in-process channels between workers), deeper orchestration
integration (`manifest.json` and selectors already map onto the way dbt integrations generate
tasks), and column-level lineage (the manifest is already table-level lineage; DuckDB's own SQL
parser can derive column-level lineage from already-rendered SQL).

## Related

- [Key concepts](/concepts/key-concepts/): the user-facing vocabulary this page assumes.
- [The data plane](/internals/data-plane/): the two tiers in full, with tier-selection rules and PZ0312.
- [Execution internals](/internals/execution-internals/): the compiler, the planner, and the dispatcher.
- [Resume internals](/internals/resume-internals/): the ledgers and checkpoints behind `pz retry`.
- [Connector architecture](/internals/connector-architecture/): the ABI, PCP, and the builtin registry.
