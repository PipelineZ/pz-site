---
title: "Connectors"
description: "This article explains the plugin architecture: how connector packages are hosted and isolated, the ABI they implement, how they're discovered and..."
---

This article explains the plugin architecture: how connector packages are hosted and isolated,
the ABI they implement, how they're discovered and version-checked, and how incremental
extraction with watermarks works. It was the hardest design problem in PipelineZ: independent
NuGet packages, discovered and executed by a CLI that has never seen them, safely and fast.

To *write* a connector, see [Author a connector](/how-to/author-a-connector/) — this page
is the why and the contract.

## Hosting model

Three options were ever on the table:

| | A. In-process, ALC per connector | **B. Out-of-process (Terraform/Airbyte style, Arrow IPC)** | C. Compile user project against connectors (dbt-Python style) |
|---|---|---|---|
| Data-plane cost | zero-copy Arrow | serialize to IPC (cheap but not free) + process mgmt | zero-copy |
| Isolation | dependency isolation via ALC; no crash isolation | full crash/security isolation, polyglot connectors | none |
| Complexity | moderate (ALC rules must be right) | high (protocol, lifecycle, packaging per RID) | pushes complexity onto users (SDK required, build step) |
| Startup | fast | process-per-connector spawn | slow (compile) |
| Determinism | lock file pins everything | same | MSBuild resolution variance |

**The decision is now B, mandatory, for every external connector.** v0.1 shipped A — one
collectible `AssemblyLoadContext` per connector package — with the ABI deliberately shaped so
B would be additive later: the contract was always "async streams of Arrow batches + JSON
config", which maps 1:1 onto Arrow IPC over a socket. Pre-1.0, with no published external
connectors yet, was the cheapest moment to actually make that move: **a restored package must
declare `runtime: "process"` in its manifest, or the registry refuses it (`PZ0360`)** —
`"dotnet"`, or shipping no manifest at all, is refused the same way. The in-process ALC
connector host is gone from the codebase, not merely deprecated. The reasoning: an ALC is a
dependency-versioning boundary, not a security one — code loaded into it runs with the
engine's full privileges (every connection's credentials, the state store, the staging DB
itself), which is a bad trade for third-party code the CLI has never audited. Process
isolation gets crash isolation and polyglot connectors for free, and the native scan/copy tier
(most of the data plane, in practice — see [The data plane](/concepts/data-plane/)) is
unaffected either way, since it never routed data through the connector's own process to begin
with.

**Builtins are the one exception, and they stay option A minus the ALC.** The nine first-party
connectors (`LocalFiles`, `Postgres`, `S3`, `SqlServer`, `AzureBlob`, `Http`, `MySql`,
`Sqlite`, `Sftp`) are project-referenced straight into `Pz.Cli` and compiled into the same
assembly as the host — there is no isolation boundary to speak of, because there is no
plugin-loading step at all: `BuiltinConnectors.CreateRegistry()` `new`s each one up directly.
That is also what makes them trusted: they ship from this repository, under the same review
and CI as the engine itself, not from an arbitrary NuGet feed.

## PCP: the out-of-process wire protocol

Every non-builtin connector is spawned as its own OS process and driven over **PCP** — a small,
language-neutral protocol: a control-socket handshake (identity, capabilities, protocol
version) followed by RPCs for validate/check/open/read/write, with the actual row data crossing
on a second, paired socket as raw Arrow IPC rather than serialized through the control channel.
Nothing above `ConnectorRegistry` — the planner, the engine, the ABI types the rest of this page
describes — can tell whether a given `ISourceConnector`/`ISinkConnector` instance is a builtin
or a shim proxying PCP calls to a child process; `ProcessSourceConnector`/`ProcessSinkConnector`
implement the same interfaces the builtins do, just by forwarding every method to the process
instead of running the logic locally.

- **Loading spawns nothing.** Registering a `runtime: "process"` package reads its manifest and
  resolves an entrypoint for the host's RID; the first call that actually needs a live
  connector (`OpenAsync`/`ValidateAsync`/`CheckConnectionAsync`) is what spawns the child. `pz
  compile`, which only reads identity and capabilities, never pays for a process.
- **One process per opened connection instance.** The engine opens each named connection
  instance exactly once per run, so process-per-open and process-per-instance coincide under
  the only caller there is.
- **The host owns every process it spawns.** Shutdown goes through a graceful cancel-then-kill
  ladder; a process that dies mid-operation surfaces as `PZ0358`, a protocol violation
  (malformed Arrow IPC, a reused write ticket) as `PZ0357`.

The manifest gains two fields for a process package, alongside the fields every connector
already declares (see [Discovery, packaging, and restore](#discovery-packaging-and-restore)
below):

- **`runtime: "process"`** — required for every external package.
- **`entrypoints`** — a RID → package-relative binary path map, e.g. `{"linux-x64":
  "runtimes/linux-x64/native/pz-mysink", "win-x64": "runtimes/win-x64/native/pz-mysink.exe"}`,
  resolved with `RuntimeIdentifierGraph` fallback (a package shipping only `linux-x64` is still
  reachable from `linux-musl-x64`) and rejected if a path would resolve outside the package
  directory.

| Code | Meaning |
|---|---|
| `PZ0354` | No usable entrypoint for this host: unknown `runtime`, no `entrypoints` (or none reachable for this RID), an entrypoint path missing or outside the package directory, or a `runtime: "process"` manifest with no `name`. |
| `PZ0355` | The connector executable failed to spawn. |
| `PZ0356` | Handshake failed: timeout waiting for `Hello`, a malformed `Hello`, or a capability/name mismatch against the manifest. |
| `PZ0357` | Protocol violation during data-plane operations. |
| `PZ0358` | The connector process died unexpectedly mid-operation. |
| `PZ0360` | An external connector package declares runtime `"dotnet"` (or ships no manifest) — external connectors are hosted out of process only. |

`pz connector test <entrypoint-or-package-dir> [--config file.yml]` runs black-box PCP protocol
conformance checks against one out-of-process connector, independent of any pz project — the
tool an author uses to verify a built binary speaks the protocol correctly before publishing it.

**Authoring one today is not yet a turnkey path.** `Pz.Connectors.Abstractions` (the ABI below)
and `Pz.Connectors.Toolkit` are for in-process builtins only — there is no published C# library
that wraps `ISourceConnector`/`ISinkConnector` into a spawnable PCP binary. A Rust SDK exists
in-tree (`rust/pz-connector`: `SinkConnector`/`Sink`/`WriteSession` traits plus a `serve_sink()`
entry point) but isn't published to crates.io yet; anything else means implementing the wire
protocol directly, in whatever language, the way the repo's own conformance fixture
(`tests/fixtures/PcpFakeConnector`) does. If you're building a connector for your own use today,
[open an issue](https://github.com/PipelineZ/pz/issues) describing what you need — the protocol
is stable, but the authoring ergonomics are still catching up to it.

## The ABI surface

The ABI is small, async, Arrow-native, and capability-based:

```csharp
namespace Pz.Connectors.Abstractions;

public interface IConnector
{
    ConnectorInfo Info { get; }                    // name, semver, supported protocol range
    ConnectorCapabilities Capabilities { get; }    // feature flags: ColumnPruning, PredicatePushdown, etc.
    string ConnectionConfigSchema { get; }         // JSON Schema — lets the CLI validate
    string DatasetConfigSchema { get; }            //   configs for connectors it's never seen
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

    // Fast path: hand DuckDB a native scan (SQL fragment + secret/extension setup).
    bool TryGetNativeScan(DatasetSpec spec, [NotNullWhen(true)] out NativeScan? scan);

    // Universal path: plan 1..N partitions for parallel extraction.
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
    bool TryGetNativeCopy(OutputSpec spec, [NotNullWhen(true)] out NativeCopy? copy);
    ValueTask<ISinkWriteSession> BeginWriteAsync(OutputSpec spec, Schema schema, CancellationToken ct);
}

public interface ISinkWriteSession : IAsyncDisposable
{
    ValueTask WriteBatchAsync(RecordBatch batch, CancellationToken ct);   // engine owns batch until return
    ValueTask<WriteResult> CommitAsync(CancellationToken ct);             // all-or-nothing where the
    ValueTask AbortAsync(CancellationToken ct);                           //   destination allows it
}
```

Notes on the shape:

- **`ReadHints` carries pushdown**: requested columns, an optional predicate expression tree,
  a limit. Connectors ignore what they can't push. The declared `ConnectorCapabilities` flags
  (`ColumnPruning`, `PredicatePushdown`, `PartitionedRead`, `NativeScan`, `Merge`,
  `Transactional`) let the planner know what to expect, and the plan output show what was
  pushed vs. filtered in DuckDB.
- **Native scan/copy records** (`NativeScan`, `NativeCopy`) carry: `SqlFragment` /`CopySql` —
  the actual SQL DuckDB executes; `SetupStatements` — statements run first (`CREATE SECRET`,
  extension INSTALL/LOAD), never logged unredacted; `Mechanism` — a short user-facing label
  (e.g. "read_csv") surfacing only in planner Reason strings; and `Finalizations`
  (NativeCopy) — `FileMove` records for filesystem atomic moves applied after a successful
  COPY (empty for object stores).
- **Write sessions are transactional in intent**: sinks write to a temp location or table and
  swap on `Commit` where the destination supports it (`replace` becomes atomic); `Abort`
  cleans up. The engine guarantees `Commit` xor `Abort` is always called; abort must never
  follow an attempted commit.
- **Error classification lives in the ABI**: `ConnectorException.IsTransient` and the
  optional `RetryAfter` drive the engine's retry policy — the connector knows whether a 429
  is retryable; the engine knows the policy. Connectors never retry internally.
- **Watermark fields ride the `DatasetSpec`**, not a separate `GetStateAsync`:
  `WatermarkCursor`/`WatermarkValue` (lower bound, v0.2) and `WatermarkUpperBound`
  (bounded-window upper bound, v0.3) are additive, execution-only properties a connector MAY
  read during `TryGetNativeScan`/`PlanReadAsync`. Ignoring them is always correct for the
  unbounded case — a `merge` sink's key-based upsert absorbs re-extraction — but load-bearing
  for a `BoundedWindow`-declaring connector.

### Pz.Connectors.Toolkit

`src/Pz.Connectors.Toolkit` is a NuGet package of shared connector *mechanism* for **builtin**
connectors — not part of the ABI, an ordinary transitive dependency of whichever builtin
project references it, the same as any other third-party library. It exists because the ABI's
job is to
define the contract, not to hand every connector author the same building blocks over again:
transient-status classification, the three HTTP paging strategies, the `api_key`/`bearer`/
`basic` auth trio, `{{ binding }}` expansion for query-string templating, JSON-pointer
resolution, contract-mode row projection, and the NDJSON write codec. A connector picks up what
it needs and ignores the rest — nothing in the toolkit is required, and the ABI works
identically for a connector that never references it. `Pz.Connector.Http` is built on it
end-to-end; `Pz.Connector.AzureBlob`'s NDJSON write path was converged onto the toolkit's
`NdjsonWriteCodec` with zero behavior change, as a second caller proving the extraction was
policy-free.

## File formats

File-based datasets/outputs declare `options: { format: <parquet|csv|json> }`. **parquet and
csv** are supported across all of the file connectors — `localfiles`, `s3`, and
`azureblob`. **json (NDJSON) is implemented in `azureblob` and (since the 2026-08-14 format-parity
cycle) `localfiles`**; `s3` supports csv/parquet only and rejects `format: json`. For `localfiles`
and `s3`, all formats a given connector supports are available on both data-plane tiers — native
scan/copy (DuckDB reads/writes the bytes directly) and the universal Arrow-stream path (the
connector reads/writes bytes itself) — with two localfiles *read* exceptions: parquet reads (no
managed parquet reader in v0, see [validation](/concepts/validation/)) and json reads (`JsonSource`
mirrors that same native-only shape via `read_json`; there is no managed NDJSON read tier) both
run the native tier exclusively, and refuse `engine.force_universal` with the same PZ0312-style
error. localfiles json *writes* run both tiers like csv/parquet: NDJSON via the toolkit's
`NdjsonWriteCodec` universally, `COPY … (FORMAT json)` natively. **`azureblob`'s reads are
entirely native-only** (an
`INativeOnlySource` — see [Many small files](#many-small-files-streaming-and-files_per_partition)
below) — every format it reads goes through the DuckDB `azure` extension exclusively, with no
universal-tier read fallback; only its *writes* still run the universal tier (`partition_by`
fan-out). The remaining difference across formats: `parquet`'s embedded schema needs no contract, full
stop. csv and json datasets (sources) may declare a `columns:` contract; as of the 2026-08-12
schema-inference cycle, a full contract is no longer required for `localfiles` csv/json or
`azureblob` csv/json — only `s3` csv still requires one. The mechanism is DuckDB's own `auto_detect`, run as
part of the real native-scan read (`read_csv`/`read_json` with `auto_detect = true`) rather than a
separate sampling pass — there is no schema known before the read, because native scan no longer
needs one to succeed. This is a strict two-state model, for both formats identically (final
whole-branch review Fix A): with **no** declared `columns:` at all, `auto_detect = true` with no
`columns=` map lets DuckDB infer the whole schema from the file. With **any** declared `columns:`
— partial or full, native scan has no way to tell them apart without reading the file, which it
deliberately never does — the fragment reverts to `auto_detect = false, columns = {...}`: DuckDB
reads *only* the named columns, exactly as it always did before the 2026-08-12 cycle (the class
doc comment on `CsvSource` calls this "contracts prune on read"). There is no partial-declare-plus-
inference middle case: declaring even one column means the declared set alone governs the read,
not a starting point DuckDB fills in the rest of. (A same-day, since-reverted excursion briefly had
csv combine DuckDB's `types = {...}` override with `auto_detect = true` for a declared contract —
verified to work, but it silently widened the read to keep every column in the file instead of
confining it to what's declared, a real regression for a project with a pre-existing contract; Fix
A reverted it, so csv and json now use the identical two-state shape.) Whatever is left undeclared
— up to and including the entire dataset — gets whatever type DuckDB's sniffer assigns it; an
ambiguous or all-null column has no dedicated pz error code, it is simply DuckDB's call (typically
`VARCHAR`) — a one-line `columns: { <col>: <type> }` override fixes a wrong guess. DuckDB's
sniffer also only samples a bounded prefix of the file by default, not the whole thing — a
contract-less dataset whose real shape changes further into the file than that sample window can
still surface a genuine cast/parse error mid-run, fixable with the same one-line `columns:`
override. `pz validate` (tier 4, no
`--connect`) reports a contract-less csv/json dataset as `undeclared` and skips dry-compiling any
pipeline that depends on it, same as before this feature existed — a graceful, non-failing skip.
`pz validate --connect` (tier 5) is a different story: `ConnectivityValidator` still calls
`ISource.GetSchemaAsync` to fetch a schema for every dataset regardless of contract, and that
method is the unchanged universal-tier path, which unconditionally requires a full `columns:`
contract for csv/json — so `--connect` actually **fails** with `PZ0330` for a contract-less
csv/json dataset (accepted per decision 7, not fixed: tier 5 gives up pre-flight validation for
this case rather than gaining a graceful skip of its own). A project that wants `pz validate
--connect` to succeed still needs either a declared `columns:` contract on every csv/json dataset,
or to skip `--connect` and rely on a real `pz run` to surface any real problem.

`engine.force_universal` and partitioned (non-native) reads on a contract-less csv/json dataset
still require a full `columns:` contract — the universal tier reads bytes itself rather than going
through DuckDB, so it has no auto-detect to lean on. **Known limitation:** a bounded-window incremental (`initial`/`max_window`/`until`,
`PZ0213` below) on an otherwise contract-less dataset still needs a hand-written `columns:`
contract for the cursor — `PZ0213` is a compile-time check with no schema to inspect before the
read happens at all under this mechanism. Plain contract-less reads and plain incrementals (no
bounded window) are unaffected.
**Sinks/outputs do not require a `columns:` contract** — a sink derives its schema from the
upstream Arrow batch, not from a declared option.

The canonical `columns:` contract type vocabulary (shared by csv, json, and every other place a
contract type is checked — `Pz.Engine.Validation.ContractTypes`, `AzureTypeNameMap`, and
`NdjsonCodec`): `int`, `bigint`, `double`, `decimal`, `varchar`, `boolean`, `date`, `timestamp`.

### JSON (NDJSON)

`format: json` is **newline-delimited JSON (NDJSON)** — one JSON object per line, not a
top-level JSON array. When `columns:` is declared, only those keys are projected out of each
line; extra JSON keys are ignored, and a declared column absent from a line (or explicit JSON
`null`) yields an Arrow null — parity with csv's contract-pruning behavior. A contract-less
dataset instead gets whatever shape DuckDB's own JSON auto-detection assigns from the file
itself.

- **Native tier**: reads via DuckDB's `read_json(<url>, columns = {…} | auto_detect = true,
  format = 'newline_delimited')` — that mode expects line-delimited objects, not a top-level
  array — writes via `COPY … TO '<url>' (format json)`. `azureblob` is the only connector that
  reads json, and its reads are native-only (see above). See [File formats](#file-formats) above
  for the declared/undeclared two-state fragment json and csv now both use identically.
- **Universal tier**: the shared, connector-agnostic `NdjsonCodec`
  (`Pz.Connectors.Abstractions.Formats`) implements both directions — a top-level JSON array is
  rejected here with a named format error — but only its write half (`NdjsonCodec.WriteAsync`)
  has a first-party caller today, and no longer directly: `azureblob`'s universal-tier json
  **write** session (`AzureJsonWriteSession`) calls the toolkit's `NdjsonWriteCodec`
  (`Pz.Connectors.Toolkit.Formats`), which delegates straight through to `NdjsonCodec.WriteAsync`
  — output stays byte-identical, but callers migrate onto the toolkit's surface rather than
  Abstractions' directly, since azure reads now go through the native tier exclusively.
  `localfiles`' universal-tier json write session (`NdjsonSinkWriteSession`, 2026-08-14
  format-parity cycle) is a second toolkit-surface caller of the same codec; its json *reads*
  are native-only, so like azure it never calls the read half. `NdjsonCodec.ReadAsync` remains
  a published ABI helper with no first-party caller; `s3` doesn't use the codec at all. Timestamps are invariant-culture ISO-8601 UTC
  (`yyyy-MM-ddTHH:mm:ss.ffffffZ`), dates are `yyyy-MM-dd`, matching the byte-stable-writer
  convention used everywhere else in the repo.
- Partitioned writes (`partition_by` + date-templated `path`, see
  [Date-partitioned paths](#date-partitioned-paths) below) work the same way for json as for csv
  and parquet — partitioned write is universal-tier only regardless of format.

> [!WARNING]
> **Non-finite doubles (`NaN`/`+Infinity`/`-Infinity`) are handled DIFFERENTLY by the two tiers.**
> DuckDB's native `read_json`/`COPY … (FORMAT json)` round-trip these as bare `NaN`/`Infinity`/
> `-Infinity` tokens — a non-standard-JSON extension DuckDB accepts on both read and write. The
> universal tier's `NdjsonCodec` cannot do this (`System.Text.Json`'s `Utf8JsonWriter` has no
> bare-NaN/Infinity literal and throws on an attempt to write one), so it serializes a non-finite
> `double` as JSON `null` instead — a deliberate, lossy-but-valid encoding rather than a crash.
> **Consequence:** a json file written by the native tier that contains non-finite doubles is
> not valid NDJSON (the bare tokens aren't standard JSON) and is not readable by the universal
> tier. If your data can contain `NaN`/`Infinity` values, either accept the universal tier's
> null-collapsing on write, or stay on the native tier for both write and read consistently —
> don't mix tiers for a dataset with non-finite doubles.

## Where a connector is told to look

A connector that addresses a location takes `root:` on the connection. `localfiles` resolves it
against the project directory (or takes it absolute); `s3` reads it as `<bucket>[/<prefix>]`. An
entity with no `path:` of its own resolves to `<root>/<entity>.<format>` for a read and
`<root>/<entity>/` for a write, so a project that names its entities well need not name paths at all.

> `root:` shipped in `localfiles`' declared connection schema from v0.1 and was read by nothing until
> the 2026-07-28 connections spec's step 6 — a project setting it was accepted by every validation
> tier and then ignored.

## What a connector is told to read or write

The engine hands a connector the entity's own name — `DatasetSpec.Dataset` on a read,
`OutputSpec.Output` on a write — and the connector resolves it the way its system does. For the
relational connectors that means splitting `schema.table` on its dot and defaulting an
unqualified name to `public` (postgres) or `dbo` (SQL Server); a three-part name is refused
rather than quoted as one identifier, since `"db.raw"."orders"` would silently read nothing.
`mysql` differs: MySQL has no separate per-connection schema concept the way Postgres/SQL Server
do — the connection's `database` already plays that role — so the entity name maps straight to a
table with no dot-split at all.

pz owns no vocabulary here beyond the name's shape (see
[Project structure](/concepts/project-structure/#the-dataset-key-names-the-object)). It has no `schema:`
or `table:` option to pass through, and a connector never has to reconcile a name with an option
that disagrees with it.

Read and write options reach a connector the same way whichever surface declared them — an
`entities: <e>: read:` block and a `source()` keyword argument produce the identical `DatasetSpec`,
and pz refuses to let both exist for one entity-side. A connector cannot tell them apart, and must
not try.

## Discovery, packaging, and restore

A connector NuGet package contains the connector assembly, marked with
`[assembly: PzConnector("postgres", typeof(PostgresConnector))]`, and an embedded
`pz.connector.json` manifest (connector name, protocol version range, capabilities).

The repo's first-party connectors — `LocalFiles`, `Postgres`, `S3`, `SqlServer`, `AzureBlob`,
`MySql`, `Sqlite`, and `Http` — all package this way. `sqlserver` (`connectors/Pz.Connector.SqlServer`) is a useful example
because it implements both directions of the ABI: as a source it pushes column pruning,
predicate/watermark/bounded-window filters, and equal-width range-partitioned reads down to
SQL Server through a typed, boxing-free Arrow reader; as a sink it drives `SqlBulkCopy` for all
three write modes — `append` bulk-loads the target directly (`TABLOCK` by default), `replace`
runs a transactional `TRUNCATE` (falling back to `DELETE` in the same transaction when a
pre-check finds FK references or missing permissions — `TRUNCATE`'s failure mode can't be
caught and retried mid-transaction), and `merge` stages rows into a keyed `#temp` table and
finalizes with one set-based `MERGE WITH (HOLDLOCK)`, resolving duplicate staged keys
last-writer-wins per the engine's standard merge contract rather than failing loudly. Stored
procedures are extracted through the same `query:` mode as any other source SQL (`query: "exec
dbo.my_proc @p = 1"`), and the schema probe (`CommandBehavior.SchemaOnly`, i.e. SQL Server's
legacy `SET FMTONLY ON`) happily describes procedures built from dynamic SQL against real
tables with no extra hint needed — the one caveat is a procedure that stages its result in a
`#temp` table or table variable, which FMTONLY can't see through (the `CREATE TABLE` never
runs) and which an explicit `WITH RESULT SETS` clause on the `EXEC` does not rescue either;
such procedures aren't usable in `query:` mode. Query-mode SQL never receives watermark or
predicate pushdown, regardless of whether the query is a plain `select` or an `exec` — the
connector never rewrites the user's SQL text. `partition_column`/`partitions` DO apply to
`query:` datasets, though: the query is wrapped as a derived table for both the min/max probe
and the per-partition reads, parity with the Postgres connector. The one place that wrapping
can't work is `exec ...` query text — `EXEC` can't appear inside a derived table — so a
partitioned `exec` dataset fails loudly at the min/max probe rather than silently ignoring the
partition options. A `procedure:`
dataset is a first-class mode alongside `query:` (and alongside the default -- read the entity
the dataset key names): it runs
`CommandType.StoredProcedure` with typed `SqlParameter`s rather than a hand-built `EXEC` string,
and its `parameters:` map accepts the sentinel values `"$watermark"`/`"$watermark_upper"`, which
bind the engine's canonical cursor value and window upper bound (`NULL` before the first run or
outside a window — procedures must treat a `NULL` bound as unbounded) — the proc becomes the
pushdown itself, with no additional `WHERE` applied by the connector. Partitioned reads are
rejected for `procedure:` datasets. Schema still comes from the `SchemaOnly`/FMTONLY probe by
default, but a `procedure:` dataset may also declare a `columns:` contract, which is used to build
the schema *without probing at all* — the escape hatch for exactly the `#temp`-staging procedures
the paragraph above says FMTONLY can't describe — and the actual result schema is verified against
that contract at read time. There is no escape from the sentinel itself: a `parameters:` entry
whose value is literally the string `"$watermark"` or `"$watermark_upper"` is always bound as the
watermark cursor or window upper bound, never passed through as that literal string.

### SQL Server — connection options

#### Entra ID / managed identity

On an Azure VM (or any host with an Entra identity), omit `password` and set
`authentication` — the value is passed through to SqlClient verbatim:

```yaml
connection:
  host: myserver.database.windows.net
  database: mart
  authentication: Active Directory Managed Identity   # system-assigned
```

For a **user-assigned** identity, add its client id as `user`:

```yaml
connection:
  host: myserver.database.windows.net
  database: mart
  authentication: Active Directory Managed Identity
  user: <client-id-guid>
```

Any SqlClient-documented mode works the same way (e.g. `Active Directory Default`,
which also picks up Azure CLI credentials for local development). The database user
must be created from the external identity (`CREATE USER [identity-name] FROM
EXTERNAL PROVIDER`) and granted the needed roles.

### SQL Server — write column types

Every Arrow `String` column defaults to `nvarchar(max)` on create, which forces `SqlBulkCopy` onto
the LOB/PLP path. A `columns:` write option (`write:` block or `sink()` kwarg — never both,
`PZ0341`) gives columns real, sized T-SQL types, resolved per column through a hierarchy:

| Order | Source | Rule |
|---|---|---|
| 1 | Declared | a `columns:` entry, parsed against a whitelisted type grammar (`int`, `bigint`, `float`, `bit`, `date`, `datetime2(0..7)`, `decimal(p,s)`, `nvarchar(1..4000\|max)`, `varchar(1..8000\|max)`) and re-rendered — never interpolated raw into DDL |
| 2 | Derived | string columns with no declared entry: the engine measures the staged relation's `max(length())` per column (`ConnectorCapabilities.TextLengthStats` + additive `OutputSpec.MaxTextLengths`) and rounds up to the smallest bucket in `{16, 32, 64, 128, 256, 512, 1000, 2000, 4000}` that is ≥ 2× the observed length; an observation over 4000 resolves to `nvarchar(max)` rather than truncating real data to fit a bucket |
| 3 | Fallback | `nvarchar(4000)` when nothing was observed (no rows, or an all-null column) |

The resolved type feeds `CREATE TABLE` for a missing target, the merge staging `#temp` table
(string columns there mirror the *existing* target's actual types when the target already exists,
so a hand-sized or previously pz-created table governs bulk-load cost), and the `fail_on_change`
column check — a declared column still needs an exact type match, but an undeclared string column
now accepts any `nvarchar`/`varchar` width on the target, so both old pz-created `nvarchar(max)`
tables and hand-sized tables keep passing. Derived sizes apply only when `pz` creates the table;
an existing table is never `ALTER`ed for sizing. A value that doesn't fit at write time (a
too-narrow column, or a declared type incompatible with the data) fails the write loudly — SQL
Server truncation error 2628/8152 or a conversion error, wrapped with a hint to widen the column or
declare a larger type in `columns:` — never a silent truncation. This is a SQL Server–specific
optimization: Postgres `text` has no equivalent penalty, so it's not part of the general ABI. See
[`connectors/Pz.Connector.SqlServer/README.md`](https://github.com/PipelineZ/pz/blob/main/connectors/Pz.Connector.SqlServer/README.md#write-column-types)
for the option syntax.

### MySQL connector

`mysql` (`connectors/Pz.Connector.MySql`) is the repo's native-path-only experiment: DuckDB's own
`mysql` extension is the *entire* data plane on both sides, and the connector ships with **zero
.NET MySQL driver dependency** — it generates SQL fragments only, never touching the universal
Arrow-stream tier. As a source, every read is a `mysql_query('<alias>', '<SELECT …>')` native scan
(never a bare attached-table scan), so a declared `columns:` contract's projection, the plain
incremental watermark, and a bounded window's upper bound all execute inside MySQL itself —
unlike the file connectors, the *unwindowed* watermark is pushed down too here, since re-scanning
a whole production table (not just re-reading a file) defeats the point of incremental extraction.
As a sink, `append` is a `create table if not exists … as select … limit 0` + `insert` batch (so a
first run needs no pre-created table) and `replace` is `create or replace table … as select …`;
`merge` is not supported (the DuckDB `mysql` catalog has no upsert, `PZ0324`), and `replace`'s
swap is not atomic on the MySQL side (`OR REPLACE` is drop-then-create and MySQL DDL commits
implicitly), so `Transactional` is deliberately not declared. Both directions implement
`INativeOnlySource`/`INativeOnlySink` (the `S3`/`AzureBlob` precedent) — `engine.force_universal`
fails at plan time (`PZ0312`) rather than falling back to a driver that doesn't exist. The
connector's honest cost is confined to the control plane: `CheckConnectionAsync` is a raw TCP
handshake-packet probe (reachability and the MySQL server version, without a driver and without
credentials — actual credentials are verified only at run time, through the native scan/copy
itself), and `GetSchemaAsync` (used only by `pz validate --connect`'s drift precheck) can answer
only when the dataset declares a `columns:` contract — without one it throws a clear, permanent
error naming the fix. See
[`connectors/Pz.Connector.MySql/README.md`](https://github.com/PipelineZ/pz/blob/main/connectors/Pz.Connector.MySql/README.md) for the
full connection/read/write reference.

### SQLite connector

`sqlite` (`connectors/Pz.Connector.Sqlite`) is the second connector on the native-path-only
pattern, and the simpler one: DuckDB's `sqlite` extension is the entire data plane, there is no
server and no credential (the connection is a file path, resolved against the project directory),
and there is only one SQL dialect — every fragment is parsed by DuckDB itself. Reads are
self-contained `sqlite_scan('<path>', '<table>')` scans (no attach, no alias) with contract
pruning and watermark/window pushdown; writes are one rw attach plus the same append/replace
batch shapes as MySQL (`merge` refused, `PZ0324`). The scanner types columns by the sqlite
schema's *declared* types (`DATE`/`DATETIME` surface as real DuckDB `DATE`/`TIMESTAMP`), while
tables *created by a pz sink* store dates/decimals as TEXT — values round-trip losslessly, only
the declared type flattens. `CheckConnectionAsync` is a real local check (the 16-byte SQLite
header magic, with a missing-file "will be created on first write" note), and under `pz mcp` the
connection `path:` joins the `PZ0606` project-containment guard exactly like a localfiles root.
See [`connectors/Pz.Connector.Sqlite/README.md`](https://github.com/PipelineZ/pz/blob/main/connectors/Pz.Connector.Sqlite/README.md)
for the full reference.

### S3 connector

`s3` (`connectors/Pz.Connector.S3`) is native-only in both directions and deliberately
**SDK-free**: DuckDB's `httpfs` extension is the entire data plane, with one scoped
`CREATE SECRET` per connection-direction (hash-suffixed names, so distinctly-named connections
never collide onto one secret). Writes are a `COPY … TO 's3://…'` (parquet/csv/NDJSON json);
reads — added in the 2026-08-19 s3-source cycle — are `read_parquet`/`read_csv`/`read_json`
native scans with the same two-state contract model as localfiles/azureblob (a declared
`columns:` contract prunes the read; contract-less csv/json auto-detect and get the
schema-inference warnings), glob paths, windowed-dataset wrapping, and the date-token
watermark-window cover emitting a URL list literal. Dataset location composes from the
connection `root:` exactly like the sink (`path:` optional — a read with none is
`<root>/<entity>.<format>`). The SDK-free control-plane cost follows the MySQL/sqlite
precedent: `pz validate --connect`'s schema fetch answers only from a declared `columns:`
contract, and `CheckConnectionAsync` reports verified-at-run-time. GCS works through the
`endpoint` override — see [Use Google Cloud Storage](/how-to/gcs/).

### HTTP connector

`http` (`connectors/Pz.Connector.Http`) is a `GET`-only source (plus a sink, below) for
JSON REST APIs. Its dataset options are a small recipe for one endpoint — `path`, `query`, a
`pagination:` block, and an optional `items` pointer to the array inside the response — rather
than a table/query name, since an HTTP endpoint is the closest thing this connector has to a
"table". It declares `Capabilities = BoundedWindow | SyncState`: `BoundedWindow` lets it run
windowed/incremental extraction (`PZ0313` no longer refuses it), and `SyncState` lets it run in
delta-link mode — replaying an opaque connector-issued token (e.g. a Microsoft Graph
`@odata.deltaLink`) verbatim instead of filtering on an orderable cursor, for APIs that hand back
a "call this URL next time" pointer rather than a queryable date/id field. A dataset configured
for delta-link mode (no `sync:` block, or an explicit `mode: auto`) resolves to the **feed** read
shape and is always single-partition and opaque to the engine (see
[Delivery guarantees](/concepts/delivery-guarantees/#sync-state-another-commit-gated-state-kind)); it
declares no native-scan capability, so honestly everything still moves through the universal
Arrow-stream tier — there is no DuckDB native scan for an arbitrary REST API the way there is for
`httpfs`-backed file formats.

It lands data one of two ways: a **raw envelope** (`payload`/`pz_page`/`pz_fetched_at`, JSON
text + page index + fetch time, so downstream SQL shapes the response with DuckDB's JSON
functions) or a typed **`columns:` contract** (typed at extraction time via the shared
`ContractProjector`, the same drift rules — extra keys ignored, missing/null → Arrow null, type
mismatch fails loudly — as csv/json). Its sink posts/puts/patches rows to an endpoint —
`append` (chunked, at-least-once) and single-key `merge` (keyed `PUT`/`PATCH`, effectively-once);
`replace` is refused at plan time (`PZ0324`), and abort semantics are `none` (see
[Delivery guarantees: HTTP sink](/concepts/delivery-guarantees/#http-sink)). Full option reference and a
worked example, both directions: [Extract from an HTTP API](/how-to/extract-from-http-api/).

Incremental extraction is the one place raw mode needs an extra option pair: the planner probes
a dataset's schema with a watermark-free `DatasetSpec` (so the schema must be identical at
planning and execution time), which means the connector can't see `sync.cursor` while
building the raw envelope's schema. Raw mode therefore declares the cursor's name a second time
as the `cursor:` dataset option (alongside `cursor_type:`, which types the extracted column) —
at execution time this is cross-checked against `sync.cursor` and a mismatch is a named
permanent error. It's a one-line duplication in exchange for a zero-engine-change connector;
contract mode doesn't need it, since the cursor is just another `columns:` entry with a type
already attached.

Delta-link mode is the sync-state counterpart: the `delta_pointer` dataset option is a JSON
pointer into the response body (e.g. `/@odata.deltaLink`) naming where the connector's next-run
token lives. The dataset declares no `sync:` block (or an explicit `mode: auto`) — the connector's
`GetNaturalReadShape` reports this dataset as a **feed** whenever `delta_pointer` is set, and
`auto` resolves to whatever the connector reports. Full walkthrough:
[Extract from an HTTP API](/how-to/extract-from-http-api/#sync-state-delta-link--change-feed-apis).

The manifest is readable **without spawning the connector**. That matters because before it
existed, an incompatible connector was only detected *after* it had already been loaded and
instantiated — by which point arbitrary package code had already run. With the manifest,
`ProcessConnectorHost.LoadFromDirectory` reads a small, untrusted JSON file and rejects an
incompatible package, or one with no usable `runtime: "process"` entrypoint for this host,
before spawning anything. The manifest states and error codes are in
[Author a connector](/how-to/author-a-connector/#ship-the-manifest).

`pz restore` turns declarations into pinned assemblies:

1. Reads `connectors:` from `project.yml`.
2. Resolves each package plus its transitive closure **using NuGet client libraries
   in-process** (`NuGet.Protocol`/`NuGet.Resolver`) against configured feeds — no .NET SDK or
   MSBuild required, only the runtime the CLI already needs. Managed assemblies are picked by
   nearest target framework; native assets by **RID compatibility**, not exact match, so a package
   shipping only `linux-x64` is reachable from `linux-musl-x64` and a `win-x64` package from
   `win10-x64`. Only the most specific matching RID is taken — never a union of several. A
   `runtimes/` tree that matches nothing this host can use is reported, naming the RIDs the package
   *does* ship.
3. Writes `pz.lock.json` (**schema version 2**): exact versions, per-package content hashes
   (SHA-512), and each asset as a **pair** — the file name it materializes under, and the exact
   **archive path** it came from. **Committed to the repo.**
4. Materializes assemblies into a **global content-addressed cache** (`~/.pz/cache`) with
   per-project links under `.pz/packages`, extracting each asset **by the archive path the lock
   records**. A transitive package's `native/` assets are flattened into the connector package's
   own `native/` directory, alongside its `lib/` — the layout a process package's `entrypoints`
   paths (below) resolve against.

> [!IMPORTANT]
> **The archive path is the load-bearing half.** A lock recording only file names forces extraction
> to re-find each name in the archive by prefix, which discards the target framework and the RID the
> resolver already chose — on a multi-targeted, multi-RID package that silently installs whichever
> build happens to come first in the zip: a `net472` assembly on a .NET 10 host, an `arm64` native
> library on x86-64. Both are files of the right name, so neither the restore nor the lock looks
> wrong; the failure surfaces much later as a `MissingMethodException` or a `dlopen` of the wrong
> architecture.
>
> A **version 1 lock is not upgraded in place** — it records no archive paths to upgrade *from*. `pz`
> reports it as `PZ0321` naming the version it found, and `pz restore` regenerates it.
>
> Two packages in one closure that provide the same `lib/` or `native/` file name are refused with
> **`PZ0325`** rather than one silently overwriting the other by enumeration order.

`pz run` and `pz validate` verify the lock file against `project.yml` and refuse to run on
drift (`--no-lock-check` exists for emergencies, loudly). CI is therefore byte-for-byte
reproducible.

> [!NOTE]
> The alternative — generating a synthetic csproj and shelling out to `dotnet restore` — was
> rejected: it requires an SDK install, makes error surfaces MSBuild-shaped, and adds seconds
> of overhead. In-proc NuGet is more work once, better forever. A `RestoreStrategy` seam
> remains so an MSBuild fallback can exist for exotic feed setups.

## ABI versioning

- `Pz.Connectors.Abstractions` follows strict semver. The host embeds one **protocol major
  version** and refuses — with a clear remediation message — connectors declaring an
  incompatible range.

> [!IMPORTANT]
> Growth is additive-only. `ISourceConnector2`-style interfaces are banned; growth happens
> through **new optional capability interfaces** (like `ISupportsMerge`, discovered via type
> checks) and through the capability flags — existing connectors never break by omission.

- A published compatibility policy: within a major, the host loads any connector built
  against an equal-or-older minor of Abstractions.

## Incremental extraction and watermarks

A dataset opts into incremental extraction with `sync: { mode: incremental, cursor: <column> }`
(the `columns:` contract, when declared, types the cursor). Each run:

1. Reads the stored watermark from `.pz/state/watermarks.json`
   (`Pz.Engine/State/WatermarkStore`).
2. Asks the connector to apply `cursor > watermark` during extraction. Ignoring it is always
   correct — a non-pushing connector just re-reads everything, and a `merge` sink's key-based
   upsert absorbs the duplication.
3. After every downstream SinkWrite for that dataset commits, captures a new candidate
   watermark — `MAX(cursor)` over the landed staging rows — and persists it.

Advancement is strictly commit-gated: if any downstream sink fails, the stored watermark is
untouched, so a retried run re-extracts exactly the same slice. See
[Delivery guarantees](/concepts/delivery-guarantees/) for how `pz retry` now carries forward
already-committed sinks so a fully successful retry can still advance the watermark, instead of
leaving it blocked and forcing a re-extract-and-redeliver on the next `pz run`.

> [!WARNING]
> **Late-arriving data.** The watermark is a HIGH-water mark, not a guarantee that every row
> up to it has been seen. A row inserted or updated with a cursor value below the
> already-advanced watermark (out-of-order writes, replica lag) will never be picked up by a
> later run — the next extract starts strictly after the stored value. A source that
> genuinely writes out of cursor order needs either a cursor with a safety buffer (extract
> `cursor > watermark - grace_period`, accepting some re-processing that `merge` absorbs) or
> a different extraction strategy entirely; PipelineZ does not solve this for you.

### Bounded windows

Bounded windows (v0.3: `max_window`/`initial`/`until` alongside `cursor:`) extract an
explicit `(lower, upper]` slice every run instead of an unbounded `cursor > watermark` read —
for a source that can't tolerate one huge catch-up extract. Each run computes:

```
lower = stored watermark, or `initial` on the dataset's first run
upper = min(AddWindow(lower, max_window), until)   -- until is optional; omitted, upper = AddWindow(lower, max_window)
```

`AddWindow` and the comparisons operate on the cursor's canonical string form (int/bigint/
decimal digits; `yyyy-MM-dd` date; `yyyy-MM-ddTHH:mm:ss.ffffff` timestamp) via
`Pz.Core.Incremental.WindowMath` — the same canonicalization the unbounded case already used.
A connector opts in by declaring `ConnectorCapabilities.BoundedWindow` and applying
`cursor <= upper` (alongside the existing `cursor > lower`) during extraction; the planner
refuses (`PZ0313`, below) to run a windowed dataset on a connector that doesn't.

The window rules, each load-bearing:

- **Empty-slice advancement.** If a computed window's extract lands zero rows, the watermark
  still advances to `upper` — the window was legitimately exhausted. This is materially
  different from the unbounded case's "nothing new yet", where an empty extract leaves the
  watermark untouched (there is no window boundary to advance to). Without this rule, a
  windowed backfill would stall forever at the first gap in the source's cursor values wider
  than one window.

  > [!WARNING]
  > This sharpens the late-arriving-data caveat: a window the engine judged empty and
  > advanced past can later receive a row whose cursor falls inside that now-permanently
  > skipped range — and unlike the unbounded case, there is no catching up later, because the
  > next window starts strictly after the advanced watermark. Choose `max_window` wide enough
  > (or a cursor/write pattern conservative enough) that this is acceptable.

- **Candidate capping.** A non-empty extract's candidate watermark is
  `min(MAX(landed cursor), upper)`, never the raw landed max. A connector that ignores or
  misapplies `WatermarkUpperBound` (over-extracts past the window) can still land the extra
  rows, but can never advance the stored watermark past the window the engine computed. This
  is what makes `BoundedWindow` a correctness contract, not merely an optimization hint.

- **Caught-up semantics.** Once `upper <= lower` — a zero-or-negative-width window, reachable
  only once `until` is set and the watermark has caught up to it — the dataset is caught up:
  extraction still runs the now-empty-by-construction query, the run logs
  `note: source '<src>.<dataset>' is caught up (watermark ... has reached until ...)` and
  exits 0, and — regardless of what the connector actually lands, even a misbehaving one that
  returns rows anyway — capture returns NO candidate. A caught-up dataset's watermark can
  therefore never advance past `until`, and never regress either; this is checked
  unconditionally, before the row-count/empty-slice logic ever runs.

Window validation is split across three codes, by when the problem is detectable:

| Code | When | Catches |
|---|---|---|
| `PZ0213` | compile time (`DagCompiler`) | malformed window config: `initial` without `max_window`; non-canonical `initial`/`until` for the declared cursor type; `until <= initial`; a windowed dataset on a `query:`-mode source (query mode ignores pushdown, so it would silently extract everything); a cursor absent from a declared `columns:` contract (bounds must be computable before the first extraction) |
| `PZ0313` | plan time (`ExecutionPlanner`) | a dataset that compiled cleanly but names a connector that doesn't declare `BoundedWindow` |
| `PZ0505` | run time only | the cursor column's ACTUAL landed type disagreeing with its declared `columns:` type (e.g. declared `timestamp`, landed `DATE`) — checked once per run, right after extraction, before any bound arithmetic depending on that type runs again |

### Date-partitioned paths

A file-based dataset's `path` may embed calendar tokens — `{yyyy}`, `{yy}`, `{MM}`, `{dd}`,
`{HH}`, `{mm}`, all zero-padded — so it reads or writes one folder per calendar bucket, e.g.
`events/{yyyy}/{MM}/{dd}/{HH}*.parquet`. Tokens must appear coarse→fine and contiguous
(`{yyyy}` before `{MM}` before `{dd}` …; a gap like `{yyyy}/{dd}` with no `{MM}` is a compile
error) — the finest token present sets the pruning/partitioning granularity. The grammar and
cover algorithm live in the shared, connector-agnostic `Pz.Connectors.Abstractions.Paths.PathTemplate`.
Today the `azureblob` connector is the one that calls it, on both the read and write side; `localfiles`
and `s3` are designed to adopt the same read-side helper later (same algorithm, wired
per-connector), but that adoption hasn't landed yet.

**Read pruning.** A dataset whose `path` has date tokens **and** declares an incremental
date/timestamp `cursor` with a [bounded window](#bounded-windows) (`initial` +
`max_window`/`until`) has its listing pruned to the watermark window's **minimal aligned prefix
cover** — whole aligned sub-ranges collapse to a single coarser glob (a whole day →
`.../2026/07/12/*.parquet`, a whole month → `.../2026/07/*/*.parquet`), so a wide window still
produces few list prefixes instead of one per leaf bucket. For example, the window
`2026-07-11 10:00 → 2026-07-13 12:00` over `{yyyy}/{MM}/{dd}/{HH}*.parquet` covers with 28
prefixes (14 ragged hours on the 11th + 1 whole day for the 12th + 13 ragged hours on the 13th)
instead of 50 per-hour globs. The cover only narrows *which folders are listed*; the existing
window predicate (`cursor > lower and cursor <= upper`) still trims to exact rows, so pruning is
a planning-time optimization, not a correctness mechanism — and it assumes a row's cursor time
matches the folder it lives in (a late-arriving row written into an already-passed folder needs
a `max_window` look-back or a periodic reprocess; pruning does not solve that on its own).

> [!TIP]
> **`max_window` is also the pruning switch.** On a date-templated path, window-cover pruning
> needs both watermark bounds, which only a windowed dataset (`incremental` + `max_window`)
> has — a date-templated path with no bounded window is a compile error (`PZ0221` below), not a
> silent full scan. A plain incremental dataset on a glob **without** date tokens scans the full
> glob every run and relies on downstream merge dedup — correct, but the read cost grows with
> total history. If your layout is date-partitioned, declare `max_window`: each run reads only
> the window's minimal cover.

A date-templated `path` without a usable window is a compile error rather than a silent full
scan:

| Code | When it fires |
|---|---|
| `PZ0217` | the dataset has no `sync.cursor` (`mode: incremental`), or the cursor's declared type isn't `date`/`timestamp` |
| `PZ0218` | the path's tokens are malformed — out of order, gapped, or an unknown token (source or sink) |
| `PZ0221` | the cursor is a valid date/timestamp but the dataset declares no bounded window (`initial` + `max_window`) |

**Write partitioning (`partition_by`).** `partition_by` names the columns an output is
partitioned by — a single name, or a list:

```yaml
partition_by: event_time        # one column
partition_by: [region, dt]      # several
```

**`path` decides who owns the layout.** That is the whole rule, and it is what keeps one option
from meaning two things:

| `path:` | Who lays the partitions out | Capability the connector must declare |
|---|---|---|
| carries calendar tokens (`{yyyy}/{MM}/{dd}`) | **pz** renders one folder per distinct value | `PathTemplating` |
| carries no tokens (or is absent) | **the destination** records its own partitioning | `ColumnPartitionedWrites` |

*pz-rendered* is the object-store case — one timestamp/date column fanned out into per-day
folders, one object written per distinct folder:

```sql
INSERT INTO {{ sink('lake', 'curated', strategy: 'replace', container: 'lake', path: 'curated/{yyyy}/{MM}/{dd}/', format: 'parquet', partition_by: 'event_time') }}
```

*Destination-owned* is the table-format case — Delta, Iceberg, Hive-layout parquet — where the
store holds the partition columns in its own metadata and there is no path to route into:

```sql
INSERT INTO {{ sink('lake', 'orders', strategy: 'merge', keys: 'id', partition_by: ['region', 'dt']) }}
```

**What is refused, and where.** `PZ0219` at compile time covers the declaration alone, because
the compiler has no connector instance: a malformed `partition_by` (blank, empty list, a
non-string entry, a repeated column), calendar tokens with no `partition_by` to substitute from,
and calendar tokens with more than one column — pz renders from exactly one timestamp column and
several leave it no way to choose. `partition_by` *without* tokens is **not** refused there; it
is correct as written for a store that partitions itself.

Whether the target connector can honour what was declared is a capability question, so it is the
planner's `PZ0314`, raised before the run rather than mid-write, naming whichever of the two
capabilities is missing. Whether `partition_by` names a real column can't be checked until the
upstream pipeline's schema is known, so that stays a runtime failure naming the output and
column.

Native `COPY` is declined once pz owns the fan-out — writing one object per distinct per-row
value isn't expressible in one `COPY` statement. A destination that partitions itself is under
no such constraint; its connector decides.

See [Delivery guarantees](/concepts/delivery-guarantees/#partitioned-output-per-partition-atomic)
for what guarantee a partitioned write provides on commit/crash.

### Many small files: streaming and `files_per_partition`

Two additional, independent levers exist in the ABI to keep a universal-tier read over a very
large file set cheap on memory and per-file overhead, complementing [date-partitioned
pruning](#date-partitioned-paths) above (see [Performance: Many small
files](/performance/#many-small-files) for when to reach for each). **Neither has a
first-party implementor today**: the `azureblob` connector, previously the only builtin to wire
either up, now reads exclusively through the native tier, which hands DuckDB the whole matched
file list/glob in one `read_parquet([...])`/`read_csv([...])` call and needs no engine-side
coalescing or lazy enumeration.

- **Streaming partition enumeration** — a source that advertises
  `ConnectorCapabilities.StreamingPartitions` yields partitions lazily as it enumerates, instead
  of materializing the full list up front, so memory stays bounded to one listing page no matter
  how many files match. There is no dataset option for this; it remains a published ABI
  capability a third-party connector's universal read path can implement, even though no builtin
  connector declares it after azure's read stack moved fully native.
- **`files_per_partition: <int>`** (source dataset option, default `1`) — on a connector with a
  universal partitioned read, groups that many consecutive matched files into a single partition
  read sequentially, instead of one partition per file — e.g. `files_per_partition: 512` over
  3,000,000 matched files yields `ceil(3_000_000 / 512)` ≈ 5,860 partitions instead of
  3,000,000, cutting per-file dispatch/stream-open overhead. It's a universal-tier-only knob:
  meaningless on a native scan, which already hands DuckDB the file list in one call. Setting it
  on a connector-level native-only source — `azureblob` is the one first-party example — is a
  plan-time error (`PZ0312`, naming the option, dataset, and connector) rather than a silent
  no-op. Where the option does apply, the value itself must be a positive integer; anything else
  (non-positive, non-integer, or unparsable) is `PZ0222` at compile time, naming the source,
  dataset, and offending value.

### One large file: split csv reads

The mirror image of the section above. Where `files_per_partition` groups many small files into
fewer partitions, a *single* large csv on `localfiles` is cut the other way — into several byte
ranges read concurrently on the universal tier, since the engine starts every planned partition at
once. There is no dataset option: it is decided per file, from its size and the machine's core
count, and it is invisible below 64 MiB.

The cut has to be exact. A byte offset chosen blind can land inside a quoted field, where a newline
is data rather than a record terminator, and splitting there drops or duplicates rows without
anything failing. So the connector walks the file once up front, tracking quoted-field state by the
same rules the csv reader parses by, and **declines to split rather than guess** whenever it cannot
prove the file safe:

- the file is under 64 MiB (two partitions' worth), so the scan would not pay for itself;
- the header line is not exactly its own field names joined with commas. That equality is the only
  available proof that the delimiter is a comma, and without knowing the delimiter there is no way
  to tell a quote that opens a quoted field from one that is literal data. A semicolon- or
  tab-delimited export therefore reads on one core;
- the scan reaches end-of-file still inside a quoted field, which means the bytes did not parse the
  way the scanner assumed and none of its boundaries can be trusted.

Each range is then read through a stream that splices the file's header in front of it, so every
partition runs an ordinary headed reader: it resolves its own column ordinals and sees the same
header for delimiter detection, which is what keeps a split read from drifting from an unsplit one.

> [!IMPORTANT]
> A split read lands rows in **non-deterministic order** — the partitions race through the one
> bounded channel into the one serialized ingest. Cross-partition order has never been guaranteed
> (and DuckDB's parallel `read_csv`, this dataset's other tier, behaves the same way), but an
> unsplit csv read did land rows in file order in practice. If a downstream pipeline depends on
> that, order it explicitly in SQL.

## Operation gate and request pacing

The engine's baseline unit of resilience is the **node**: a failed SourceLoad or SinkWrite
retries in full, under `retry:`/`engine.breaker`. The operation gate generalizes that resilience to the
**operation boundary** — one HTTP request, one blob copy-promote — while preserving the
single-retry-owner principle unchanged: **policy, delays, jitter, and breaker state stay
engine-side; the connector contributes only the operation boundary and an idempotency
declaration.** A connector opts in by declaring `ConnectorCapabilities.GatedOperations` and
implementing `IOperationGateAware` on its `ISource`/`ISink`; the engine hands it an
`IOperationGate` after `OpenAsync`, and every gated round-trip runs through
`IOperationGate.ExecuteAsync`. See [Author a connector](/how-to/author-a-connector/#operation-gate)
for the authoring contract.

Two things the gate does NOT change:

- **The connector still never retries internally.** The gate is engine code and the only
  sanctioned sub-node retry site — exactly the same rule that already governed node-level
  retries, just applied one layer finer. A gate exhaustion (the last transient failure, after
  the op's own attempts run out) rethrows and surfaces as ONE ordinary transient node failure;
  the node loop retries or fails it exactly as it always has.
- **The circuit breaker sees node outcomes only.** Op-level failures inside the gate never call
  `RecordTransientFailure` — only the node's final, surfaced result feeds the breaker. This keeps
  breaker threshold semantics identical whether or not an instance happens to be gated.

Pacing is a second, independent feature riding the same boundary: an instance-level `rate_limit:`
block (`requests_per_minute`, `burst`) becomes a per-instance token bucket, shared across every
node/partition/attempt of that instance for the whole run — see
[Throttle a struggling source or sink](/how-to/throttle-a-source/#pace-requests-in-run-with-rate_limit).
`rate_limit:` on an instance whose connector doesn't declare `GatedOperations` is refused at plan
time (`PZ0317`) rather than silently never pacing, mirroring the `BoundedWindow`/`PZ0313` and
`PathTemplating`/`PZ0314` capability gates above. Today `http` (source reads) and `azureblob`
(sink universal writes — `open_write`/`commit_copy`/`delete_temp`) adopt the gate; `s3` has
nothing to retrofit, since both its reads and writes are native-only and its HTTP traffic never
leaves DuckDB.

## Next steps

- [Author a connector](/how-to/author-a-connector/) — the procedural guide.
- [The data plane](/concepts/data-plane/) — the two tiers a connector feeds.
- [Backfill in bounded slices](/how-to/backfill-in-slices/) — bounded windows from the
  user's side.
