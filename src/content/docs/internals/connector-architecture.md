---
title: "Connector architecture"
description: "This page documents the connector ABI in Pz.Connectors.Abstractions, the PCP out-of-process protocol, package layout, TestKit conformance, the Rust SDK, and the builtin registry."
sidebar:
  order: 5
---

This page is for contributors writing or reviewing a connector, or working on the connector
host itself. It documents the ABI surface, how a connector is hosted, how a package is laid out
and discovered, and how conformance is proven. For how to build one, see
[Author a connector](/how-to/author-a-connector/); this page is the why and the contract.

## The ABI surface

The ABI lives in `Pz.Connectors.Abstractions`, is small, async, Arrow-native, and capability
based:

```csharp
namespace Pz.Connectors.Abstractions;

public interface IConnector
{
    ConnectorInfo Info { get; }
    ConnectorCapabilities Capabilities { get; }
    string ConnectionConfigSchema { get; }
    string DatasetConfigSchema { get; }
    ValueTask<ValidationResult> ValidateAsync(ConnectorConfig config, CancellationToken ct);
    ValueTask<ConnectionCheck> CheckConnectionAsync(ConnectorConfig config, CancellationToken ct);
}

public interface ISourceConnector : IConnector
{
    ValueTask<ISource> OpenAsync(ConnectorConfig config, CancellationToken ct);
}

public interface ISource : IAsyncDisposable
{
    ValueTask<DatasetSchema> GetSchemaAsync(DatasetSpec spec, CancellationToken ct);
    bool TryGetNativeScan(DatasetSpec spec, out NativeScan? scan);
    ValueTask<IReadOnlyList<IDatasetPartition>> PlanReadAsync(
        DatasetSpec spec, ReadHints hints, CancellationToken ct);
}

public interface IDatasetPartition
{
    IAsyncEnumerable<RecordBatch> ReadAsync(BatchOptions options, CancellationToken ct);
}

public interface ISinkConnector : IConnector
{
    ValueTask<ISink> OpenAsync(ConnectorConfig config, CancellationToken ct);
}

public interface ISink : IAsyncDisposable
{
    bool TryGetNativeCopy(OutputSpec spec, out NativeCopy? copy);
    ValueTask<ISinkWriteSession> BeginWriteAsync(OutputSpec spec, Schema schema, CancellationToken ct);
}

public interface ISinkWriteSession : IAsyncDisposable
{
    ValueTask WriteBatchAsync(RecordBatch batch, CancellationToken ct);
    ValueTask<WriteResult> CommitAsync(CancellationToken ct);
    ValueTask AbortAsync(CancellationToken ct);
}
```

Errors cross the ABI as one exception type, `PzConnectorException`, carrying `IsTransient` and
an optional `RetryAfter` that drive the engine's retry policy. Connectors never retry
internally; the engine owns retry policy and reads the connector's diagnosis.

**Write sessions are transactional in intent.** Sinks write to a temp location or table and swap
on `Commit` where the destination supports it; `Abort` cleans up. The engine guarantees `Commit`
xor `Abort` is always called, and abort never follows an attempted commit.

## `DatasetSpec`, `OutputSpec`, and `PathTemplate`

`DatasetSpec` (a source read) and `OutputSpec` (a sink write) are the records carrying
everything a connector needs for one dataset or output, beyond connection config:

- `DatasetSpec` carries `Source`/`Dataset` names, an `Options` map (the entity's `read:` keys
  or `source()` kwargs, whichever surface declared them), and the watermark fields
  (`WatermarkCursor`, `WatermarkValue`, `WatermarkUpperBound`, `WatermarkLowerInclusive`,
  `PriorSyncState`, `ChangeCapture`) a connector may read while building `TryGetNativeScan` or
  `PlanReadAsync`.
- `OutputSpec` carries `Sink`/`Output` names, `Mode` (`append`/`replace`/`merge`),
  `SchemaPolicy`, an `Options` map, and `Attempt` (see
  [Resume internals: attempt identity](/internals/resume-internals/#attempt-identity)).
- `ReadHints` carries pushdown: requested `Columns`, an optional `PredicateSql`, and a `Limit`.
  Connectors ignore what they can't push.

`Pz.Connectors.Abstractions.Paths.PathTemplate` is the shared, connector-agnostic grammar and
cover algorithm for calendar-token paths (`{yyyy}/{MM}/{dd}`). A connector that implements it
declares `PathTemplating`; the `azureblob` connector is the one first-party implementor today.

## `ConnectorCapabilities`

`ConnectorCapabilities` is a `[Flags]` enum. A connector declares only what's true; the planner
refuses a mode or option a connector didn't declare, at compile or plan time, rather than
letting it fail or silently degrade at run time.

| Flag | Side | Means |
|---|---|---|
| `ColumnPruning` | source | Honors `ReadHints.Columns`. |
| `PredicatePushdown` | source | Honors `ReadHints.PredicateSql`. |
| `PartitionedRead` | source | `PlanReadAsync` may return more than one partition. |
| `NativeScan` | source | Can hand DuckDB a native scan via `TryGetNativeScan`. |
| `NativeCopy` | sink | Can hand DuckDB a native copy via `TryGetNativeCopy`. |
| `Merge` | sink | Supports `mode: merge`. |
| `Transactional` | sink | Commit is atomic (temp-swap or equivalent). |
| `BoundedWindow` | source | Applies `WatermarkUpperBound` during extraction; a windowed dataset on a connector without this flag is refused at plan time (`PZ0313`). |
| `PathTemplating` | both | Actually implements `PathTemplate` for pruning or partitioned writes; a date-templated path or partitioned output on a connector without it is refused (`PZ0314`). |
| `StreamingPartitions` | source | Yields partitions lazily instead of materializing the full list. |
| `InclusiveWatermarkBound` | source | Honors `WatermarkLowerInclusive` (`cursor >= value`); without it the engine pushes no bound at all rather than narrowing to a strict one. |
| `SyncState` | source | Emits an opaque connector-owned token, stored and replayed via `PriorSyncState`. |
| `GatedOperations` | both | Routes remote operations through `IOperationGate`; required for `rate_limit:` on that instance (`PZ0317`). |
| `StablePartitionIds` | source | Every planned partition has a stable, unique id, enabling partition-scoped retry. |
| `CheckpointableReads` | source | Some partitions can resume mid-read; requires `StablePartitionIds` (`PZ0319`). |
| `ReplaceWrites` | sink | Supports `mode: replace`; refused without it (`PZ0324`). |
| `CheckpointableWrites` | sink | Write sessions implement `ICheckpointingSinkSession`; enables the delivery ledger. |
| `ChangeCapture` | source | Supports `sync: {mode: cdc}`; refused without it (`PZ0338`). |
| `ApplyDeletes` | sink | Write sessions can implement `IDeleteApplyingWriteSession` for cdc-fed merge; `on_delete: delete\|soft` refused without it (`PZ0339`). |
| `TextLengthStats` | sink | Wants per-column max text lengths via `OutputSpec.MaxTextLengths` before `BeginWriteAsync`, to size text DDL. |
| `ColumnPartitionedWrites` | sink | The destination records its own `partition_by` layout, needing no `path:` template. Declared in the ABI; no first-party connector implements it today. |

`append` needs no capability flag; every sink supports it.

## Hosting model

**Builtins stay in-process.** The ten first-party connectors (LocalFiles, Postgres, S3,
SqlServer, AzureBlob, Gcs, Http, MySql, Sqlite, Sftp) are project-referenced straight into
`Pz.Cli` and compiled into the same assembly as the host. `BuiltinConnectors.CreateRegistry()`
(`Pz.Cli/BuiltinConnectors.cs`) `new`s each one up directly and registers it as both source and
sink where it implements both. There is no plugin-loading step and no isolation boundary for
them; they ship from this repository under the same review and CI as the engine itself.
`BuiltinConnectors.PackageIds` names the ten package ids so that a project declaring one of them
never triggers NuGet resolution, the lock file, or drift checking.

**Every other connector runs out-of-process, over PCP.** A restored package must declare
`runtime: "process"` in its `pz.connector.json` manifest, or the registry refuses it
(`PZ0360`); `"dotnet"`, or shipping no manifest at all, is refused the same way. Out-of-process
hosting is a security boundary, not just a versioning one: code loaded in-process would run with
the engine's own privileges, every connection's credentials included, which is a bad trade for
third-party code the CLI has never audited. Nothing above `ConnectorRegistry` (the planner, the
engine, the ABI types above) can tell whether an `ISourceConnector`/`ISinkConnector` instance is
a builtin or a shim proxying PCP calls to a child process.

## PCP: the out-of-process wire protocol

PCP's control plane is generated gRPC/protobuf code (`Pz.Connectors.Protocol`, built from
`pz_connector.proto`), spoken over a Unix domain socket; the row data itself crosses on a second,
paired data socket as raw Arrow IPC rather than serialized through the control channel.
`ConnectorProcess` (`Pz.PackageManagement/ProcessHosting/ConnectorProcess.cs`) owns one spawned
child process end to end:

- **Loading spawns nothing.** Registering a `runtime: "process"` package reads its manifest and
  resolves an entrypoint for the host's RID; the first call that actually needs a live connector
  (`OpenAsync`/`ValidateAsync`/`CheckConnectionAsync`) is what spawns the child.
- **The child's environment is a fixed allowlist**, never the full host environment: `PATH`,
  `HOME`, `TMPDIR`, `LANG`, `LC_ALL`, and both-case proxy variables
  (`http_proxy`/`HTTP_PROXY`, `https_proxy`/`HTTPS_PROXY`, `no_proxy`/`NO_PROXY`). Nothing on
  that list can carry a secret; actual connection configuration crosses only through the
  handshake's Configure RPC, never through argv or the environment.
- **The host owns every process it spawns.** Shutdown goes through a graceful cancel-then-kill
  ladder. A process that dies mid-operation surfaces as `PZ0358`; a protocol violation
  (malformed Arrow IPC, a reused write ticket) as `PZ0357`; a handshake failure as `PZ0356`; a
  failure to spawn at all as `PZ0355`; no usable entrypoint for the host's RID as `PZ0354`.

`pz connector test <entrypoint-or-package-dir> [--config file.yml]` runs black-box PCP protocol
conformance checks against one out-of-process connector, independent of any pz project.

## Package layout: `pz.connector.json`

A connector package ships a `pz.connector.json` manifest at its root, alongside the connector
assembly marked with `[assembly: PzConnector("name", typeof(MyConnector))]`:

```json
{ "name": "fakesource", "protocolMajorMin": 1, "protocolMajorMax": 1, "capabilities": ["source"],
  "runtime": "process", "entrypoints": { "linux-x64": "native/pz-mysink" } }
```

- `protocolMajorMin`/`protocolMajorMax` declare the inclusive range of
  `Pz.Connectors.Abstractions` protocol majors the connector supports. An incompatible or
  malformed manifest is `PZ0306`, before any assembly loads or process spawns.
- `runtime: "process"` and `entrypoints` (a RID-to-binary map, resolved with
  `RuntimeIdentifierGraph` fallback) apply only to a process-hosted package; a builtin's manifest
  omits both.
- `projectDirectoryAnchor` (optional, default `false`) asks pz to resolve the connector's
  relative paths against the project directory rather than leaving them unanchored.

`pz restore` resolves declared packages and their transitive closures with in-process NuGet
client libraries against configured feeds, writes `pz.lock.json` (exact versions, per-package
content hashes, and each asset as a name-plus-archive-path pair), and materializes assemblies
into a content-addressed cache under per-project links at `.pz/packages`. `pz run` and
`pz validate` verify the lock file against `project.yml` and refuse to run on drift
(`--no-lock-check` exists for emergencies).

## TestKit conformance

`Pz.Connectors.TestKit` is the ecosystem's keystone acceptance suite: a package of contract
tests every connector author runs against their implementation, covering schema fidelity,
cancellation honoring, the Arrow batch lifetime protocol, transactional commit/abort, transient-
error classification, and partition correctness. It ships an in-memory reference connector as
the executable specification, plus fixtures like `StubHttpServer` for scripted HTTP testing with
no docker and no network. TestKit hooks are virtual and defaulted to null, so a connector that
declares a new capability opts into the matching acceptance facts without every existing
subclass having to change.

## The Rust SDK

`rust/pz-connector` is a Rust crate for writing PCP connectors without hand-rolling the wire
protocol. It is **sink-only today**: it exports `SinkConnector`, `Sink`, and `WriteSession`
traits, plus a `serve_sink()` entry point that drives the gRPC/protobuf control plane and the
Arrow IPC data plane on a connector author's behalf. Its dependencies are `tonic`/`prost` for
gRPC and protobuf, `arrow` (pinned to one major across the workspace, since `arrow-rs` treats
every release as a new major and a mismatched pin would silently stop being the same nominal
`RecordBatch` type), and `tokio` for the async runtime. There is no published source-side trait
yet; a source connector in Rust means implementing the wire protocol directly.

## The builtin registry

`BuiltinConnectors.CreateRegistry()` wires the ten first-party connectors into the CLI's
in-process `ConnectorRegistry`, one `AddSource`/`AddSink` pair per connector that implements
both directions:

```csharp
var localFiles = new LocalFilesConnector();
registry.AddSource("localfiles", localFiles);
registry.AddSink("localfiles", localFiles);
// ... postgres, s3, sqlserver, azureblob, gcs, http, mysql, sqlite, duckdb, ducklake, quack, motherduck, iceberg, sftp
```

`GatedOperations` today is declared by `http`, `sftp`, `azureblob`, and `gcs`. `files_per_partition`
is an `sftp` dataset option, on its universal-tier partitioned read.

## Related

- [Author a connector](/how-to/author-a-connector/): the procedural guide for building one.
- [The data plane](/internals/data-plane/): the tiers `TryGetNativeScan`/`TryGetNativeCopy` feed.
- [Resume internals](/internals/resume-internals/): the ledgers behind `StablePartitionIds`, `CheckpointableReads`, and `CheckpointableWrites`.
- [Connectors](/concepts/connectors/): the user-facing view of the plugin architecture.
- [Architecture](/internals/architecture/): where `Pz.Connectors.Abstractions` sits in the layering.
