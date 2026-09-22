---
title: "Connector architecture"
description: "This page documents the connector ABI in Pz.Connectors.Abstractions, the PCP out-of-process protocol, package layout, TestKit conformance, the C# and Rust SDKs, and the builtin registry."
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

### `ReadHints` extraction and joins

`ExtractReadHints` (`Pz.DuckDb/DuckDbSqlAstReader.cs`) walks the rendered pipeline SQL's own AST
(DuckDB's own `json_serialize_sql`, not a hand-rolled parser) to decide what's safe to push down
when the source is joined to other relations. Both halves fail toward "push nothing" on any shape
the walk doesn't recognize, so an unrecognized join costs speed, never correctness:

- **Predicate pushdown** only fires when every join between the target and the query's root
  **preserves the target's rows** — `INNER`/`CROSS` on either side, `LEFT`/`SEMI`/`ANTI` with the
  target on the left, `RIGHT` with the target on the right. `FULL`, `ASOF`, `POSITIONAL`, and any
  join kind the walk doesn't recognize push nothing: filtering the target ahead of a join that can
  null-extend it (the target sits on a nullable side) would silently change the result — pushing
  `id IS NULL` to the source ahead of a left join and landing zero rows turns an anti-join into
  "return every row". A self-join (one source feeding two aliases of the same table) also pushes
  nothing, since a predicate written for one alias would starve the other. The target must also be
  the query's *only* reference to that source — a second reference inside a CTE body or a subquery
  needs rows this walk never inspects, so the whole extraction backs off.
- **Column pruning** collects only column references it can attribute with certainty. An
  unqualified column name is the target's only when the target is the FROM clause's sole relation;
  with any other relation in scope, an unqualified reference is unattributable and pushes every
  column. A qualified reference (`o.payload.kind`) is attributed by its first part against the
  FROM's own aliases, and the column is the part right after it (`payload`, not the full path); a
  first part that isn't a FROM alias — a schema qualifier, or the root of a struct path pz can't
  resolve — is also unattributable. `select *` over the target, any subquery in scope, or a join
  that matches columns by name (`USING`, `NATURAL`) all fall back to reading every column, since
  none of them says which columns a bare name would need.

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
| `NativeOnlyRead` | source | No universal read path at all; `PlanReadAsync` always refuses. In process this is the marker interface `INativeOnlySource`; over PCP it is this bit, set by the C# SDK for any connector that implements the interface — an author declares the interface, never the flag. `pz connector test` reads it to skip the vectors that need `PlanRead` to succeed. |

`append` needs no capability flag; every sink supports it.

A sink may also implement `IOutputConfigSchema`, a JSON Schema for its own `write:`/`sink()`
options — the write-side mirror of `DatasetConfigSchema` — checked at tier 3 the same way a
dataset's read options are. It is a capability interface, not a `ConnectorCapabilities` flag,
since it describes a schema rather than gating a mode.

## Hosting model

**Builtins stay in-process.** The fifteen first-party connectors (LocalFiles, Postgres, S3,
SqlServer, AzureBlob, Gcs, Http, MySql, Sqlite, Sftp, DuckDb, DuckLake, Quack, MotherDuck, Iceberg) are project-referenced straight into
`Pz.Cli` and compiled into the same assembly as the host. `BuiltinConnectors.CreateRegistry()`
(`Pz.Cli/BuiltinConnectors.cs`) `new`s each one up directly and registers it as both source and
sink where it implements both. There is no plugin-loading step and no isolation boundary for
them; they ship from this repository under the same review and CI as the engine itself.
`BuiltinConnectors.PackageIds` names the fifteen package ids so that a project declaring one of them
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
`pz_connector.proto`), spoken over an AF_UNIX (Unix domain) socket, on Windows as well as Linux and
macOS; the row data itself crosses on a second, paired data socket as raw Arrow IPC rather than
serialized through the control channel.
`ConnectorProcess` (`Pz.PackageManagement/ProcessHosting/ConnectorProcess.cs`) owns one spawned
child process end to end:

- **Loading spawns nothing.** Registering a `runtime: "process"` package reads its manifest and
  resolves an entrypoint for the host's RID; the first call that actually needs a live connector
  (`OpenAsync`/`ValidateAsync`/`CheckConnectionAsync`) is what spawns the child.
- **The child's environment is a fixed allowlist**, never the full host environment: `PATH`,
  `HOME`, `TMPDIR`, `LANG`, `LC_ALL`, and both-case proxy variables
  (`http_proxy`/`HTTP_PROXY`, `https_proxy`/`HTTPS_PROXY`, `no_proxy`/`NO_PROXY`). On Windows
  it also passes `SystemRoot`, `windir`, `SystemDrive`, `TEMP`, `TMP`, `USERPROFILE`, `APPDATA`,
  `LOCALAPPDATA`, `PATHEXT`, and `ComSpec`: without `SystemRoot`, Winsock cannot load its
  providers and the child's first socket fails. Nothing on that list can carry a secret; actual
  connection configuration crosses only through the handshake's Configure RPC, never through argv
  or the environment.
- **The socket directory is owner-only.** The control socket carries connection credentials, so the
  host creates the directory holding both sockets with mode `0700` on Unix, and on Windows with a
  protected DACL that grants only the current user. On Windows the socket files inherit that DACL.
  Another local user cannot dial either socket.
- **A child's stdout is drained and discarded, never inherited.** Redirecting it keeps a
  connector's own stdout out of pz's own stdout (which may be the NDJSON event stream), and
  draining it as raw bytes rather than line-by-line keeps a connector that writes a lot with no
  newline from blocking on a full OS pipe buffer forever. **Stderr is the diagnostic channel**: a
  bounded tail of it is folded into a failure's message. A connector author who wants a message to
  reach pz's diagnosis should write it to stderr, or, better, log through the SDK (see
  [Telemetry](/how-to/author-a-connector/#telemetry) and the `connector_log` run event) rather than
  print to stdout.
- **The host owns every process it spawns, one per open.** Shutdown goes through a graceful
  cancel-then-kill ladder. **Disposing an opened source or sink reaps its process**: the engine
  opens a connection once per node (a `SourceLoad`, a `SinkWrite`, a couple of planner probes, a
  connectivity check), each inside its own `await using`/`finally`, so a child's lifetime tracks
  nodes in flight (bounded by `engine.threads`), not connections declared in the project — the host
  also reaps whatever is left, an open never disposed or one cut short by a failure, when it itself
  is disposed at run end. A process that dies mid-operation surfaces as `PZ0358`; a protocol
  violation (malformed Arrow IPC, a reused write ticket) as `PZ0357`; a handshake failure as
  `PZ0356`; a failure to spawn at all as `PZ0355`; no usable entrypoint for the host's RID as
  `PZ0354`. `PZ0356`/`PZ0358` name the child's exit code and, on Unix, the signal it decodes to
  (`exited with code 137 (signal SIGKILL)`), when the process has already exited by the time the
  failure is diagnosed.
- **A connector must not outlive a host that died.** The shutdown ladder only runs if the host's
  own code does; a host killed outright (a crash, `kill -9`, `taskkill /f`) never gets there. Two
  backstops cover that case. Both SDKs exit on their own when the control connection closes without
  a `Shutdown` RPC, which is what a dead host looks like from the child's side, and `pz connector
  test` checks it (the `exits-on-connection-loss` vector). On Windows the host also assigns every
  child to a Job Object with kill-on-close, so the OS kills the children when the host process
  goes away by any means, even a connector that ignores its control connection.
- **An unrecognized capability bit is a warning, never a handshake failure.** A connector built on
  a newer SDK than the host's own `Pz.Connectors.Abstractions` may declare a capability bit this
  build doesn't define; the host masks unknown bits out before comparing or naming capabilities and
  warns once per open rather than refusing the handshake, so a connector stays usable on an older
  `pz` for the capabilities that build does understand. This is the same additive-only policy the
  Abstractions ABI itself follows (see [Architecture](/internals/architecture/)).
- **Not every capability crosses the wire yet.** The host masks `CheckpointableReads`,
  `CheckpointableWrites`, and `ChangeCapture` on a process-hosted connector's declared
  capabilities, so the planner refuses a checkpointed or CDC dataset on it instead of silently
  degrading to a plain full read. `SyncState` is fully honored: the host reads the connector's
  natural read shape and its per-partition sync-state token through the `GetNaturalReadShape` and
  `GetReadState` RPCs, pulling the token only once the partition has finished draining over the
  data plane. That ordering is also why a feed connector must not offer a native scan for a feed
  dataset — the token doesn't exist until the drain happens, and a native scan bypasses the data
  plane entirely. `StreamingPartitions` takes the materialized partition-list path over PCP rather
  than streaming partitions lazily.

`pz connector test <entrypoint-or-package-dir> [--config file.yml]` runs black-box PCP protocol
conformance checks against one out-of-process connector, independent of any pz project. Its
`exits-on-connection-loss` vector spawns a separate instance, closes the control connection
without sending `Shutdown`, and fails if the process is still running after a grace period, since
a connector that waits only for the `Shutdown` RPC would linger forever after a host crash.

### RPC surface

Every RPC PCP defines, control plane unless noted:

| RPC | Direction | Purpose |
|---|---|---|
| `Handshake` | host → child | First call; exchanges protocol version, capabilities, and SDK identity (`Hello`). |
| `Configure` | host → child | Delivers connection config — the only path configuration ever crosses on. |
| `Validate` | host → child | Offline cross-field config validation, no network. |
| `CheckConnection` | host → child | Live connectivity probe (`pz validate --connect`). |
| `GetSchema` | host → child | Dataset schema for a source. |
| `TryNativeScan` | host → child | Asks for a native-tier DuckDB scan fragment. |
| `PlanRead` | host → child | Streams the planned partition list for a read. |
| `OpenReadStream` | host → child | Opens the paired data-plane socket for one partition's Arrow batches. |
| `GetNaturalReadShape` | host → child | The connector's own natural partitioning, for `SyncState`. |
| `GetReadState` | host → child | A partition's sync-state token, pulled once its data-plane drain finishes. |
| `GetStreamFailure` | host → child | Side-effect-free: asks why a read or write stream truncated mid-transfer, so a failure raised after the first batch keeps its transience and retry-after instead of surfacing as a bare protocol violation. |
| `TryNativeCopy` | host → child | Asks for a native-tier DuckDB copy fragment. |
| `BeginWrite` | host → child | Opens a write session and the paired data-plane socket. |
| `CommitWrite` | host → child | Commits an open write session. |
| `AbortWrite` | host → child | Aborts an open write session. |
| `Cancel` | host → child | Propagates run cancellation into an in-flight operation. |
| `Shutdown` | host → child | Graceful shutdown request, ahead of the cancel-then-kill ladder. |
| `HostChannel` | host ↔ child, bidirectional stream | The reverse channel: the host still dials it (as with every other RPC), but the connector is its semantic client — it authors every gate acquire/complete/budget request and log event on its outbox, while the host only ever answers with a gate grant on its own. Carries `GatedOperations` traffic and connector log lines. |

## Package layout: `pz.connector.json`

A connector package ships a `pz.connector.json` manifest at its root, alongside the connector
assembly marked with `[assembly: PzConnector("name", typeof(MyConnector))]`:

```json
{ "name": "fakesource", "protocolMajorMin": 1, "protocolMajorMax": 1, "capabilities": ["source"],
  "runtime": "process", "entrypoints": { "linux-x64": "native/pz-mysink" },
  "sdk": { "name": "Pz.Connectors.Sdk", "version": "x.y.z" } }
```

- `protocolMajorMin`/`protocolMajorMax` declare the inclusive range of
  `Pz.Connectors.Abstractions` protocol majors the connector supports. An incompatible or
  malformed manifest is `PZ0306`, before any assembly loads or process spawns.
- `runtime: "process"` and `entrypoints` (a RID-to-binary map, resolved with
  `RuntimeIdentifierGraph` fallback) apply only to a process-hosted package; a builtin's manifest
  omits both.
- `projectDirectoryAnchor` (optional, default `false`) asks pz to resolve the connector's
  relative paths against the project directory rather than leaving them unanchored.
- `sdk` (optional; name and version of the SDK that built the connector) is additive — an older
  manifest with no `sdk` block reads as null. Both SDKs write it themselves (the C# SDK from the
  assembly's own informational version, the Rust SDK from its crate name/version), so it needs no
  authoring effort. The same identity crosses the handshake as `Hello.sdk`, shown in `pz
  connectors`' `sdk` column and folded into `PZ0356`/`PZ0357` when the handshake or a protocol
  violation names the connector.

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

`SinkConnectorAcceptanceTests` is the sink half: every builtin sink subclasses it. Beyond the
lifetime and transactional facts, it covers a zero-batch commit, an already-cancelled
`WriteBatchAsync` token (several first-party sinks failed to honor this until the fact existed),
nulls in a nullable column, and, opt-in, a large multi-batch write and a full type-matrix
round-trip:

- `LargeBatchRows` (`protected virtual int`, default `20_000`) sizes the large-write fact, so a
  destination throttled by an emulator can lower it rather than exclude the fact entirely.
- `TypeMatrixOutput`/`ReadTypeMatrixCommittedAsync` (both null by default) opt a sink into a
  round-trip fact for `decimal128`, `timestamp`, `date`, and `bool` columns; a subclass that sets
  `TypeMatrixOutput` must also implement the read-back hook.
- A sink implementing `IOutputConfigSchema` gets a self-detecting fact that its declared schema
  actually validates the write options the sink accepts.

## The SDKs

Two SDKs drive the wire protocol on a connector author's behalf. `Pz.Connectors.Sdk` (C#) serves
any `Pz.Connectors.Abstractions` connector over PCP, both directions, and packs it as a
`pz`-installable package; the [authoring guide](/how-to/author-a-connector/#c-sdk) covers it.

`rust/pz-connector` is a Rust crate for writing PCP connectors without hand-rolling the wire
protocol. It is **sink-only today**: it exports `SinkConnector`, `Sink`, and `WriteSession`
traits, plus a `serve_sink()` entry point that drives the gRPC/protobuf control plane and the
Arrow IPC data plane on a connector author's behalf. Its dependencies are `tonic`/`prost` for
gRPC and protobuf, `arrow` (pinned to one major across the workspace, since `arrow-rs` treats
every release as a new major and a mismatched pin would silently stop being the same nominal
`RecordBatch` type), and `tokio` for the async runtime. There is no published source-side trait
yet; a source connector in Rust means implementing the wire protocol directly.

The crate speaks AF_UNIX on unix and Windows alike; pz's CI builds and tests it on Linux and
Windows, and macOS takes the same unix code path as Linux. Tokio has
no AF_UNIX types on Windows, so there the crate creates and accepts its sockets through `socket2`
and lets tokio's reactor drive them. One behavior differs by platform: on Windows, a `recv` already
waiting on an AF_UNIX socket ignores `shutdown`. When `Cancel`, `AbortWrite`, or `Shutdown` has to
end a data-plane read the host will never finish, the crate calls `shutdown` and then cancels the
pending read with `CancelIoEx` on the same handle.

## The builtin registry

`BuiltinConnectors.CreateRegistry()` wires the fifteen first-party connectors into the CLI's
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
