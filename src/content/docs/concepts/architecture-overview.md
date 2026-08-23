---
title: "Architecture overview"
description: "PipelineZ is a CLI-first, batch-oriented ETL framework for .NET that applies dbt's philosophy to data movement, not analytics modeling. This article is the..."
---

PipelineZ is a CLI-first, batch-oriented ETL framework for .NET that applies dbt's philosophy
to **data movement**, not analytics modeling. This article is the hub for the concept pages:
it covers the design principles, how the pieces fit together, and the decisions that shaped
them.

![Overview: hub-and-spoke with DuckDB as the hub](/diagrams/01-overview.png)

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
out. The CLI process hosts everything; connectors are loaded in-process from NuGet packages.

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
| `Pz.PackageManagement` | NuGet resolution, lock file, connector materialization | Abstractions |
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

## Decision log

The load-bearing decisions, and why they went the way they did. Don't undo these casually.

| # | Decision | Chosen | Over | Because |
|---|---|---|---|---|
| 1 | Transformation hub | DuckDB disk-backed staging DB | in-memory DB, custom operators | out-of-core for free; spill managed by the best buffer manager available |
| 2 | Canonical data format | Arrow RecordBatch | IDataReader/DataTable/rows | zero-copy DuckDB boundary, off-heap pooled buffers (no LOH churn), industry interchange |
| 3 | Data plane | two-tier: native scan/copy + arrow stream | one universal path | DuckDB's own readers beat any generic path; universality preserved |
| 4 | Plugin hosting | in-proc, ALC per package | out-of-proc, compile-time | zero-copy + dependency isolation; ABI shaped so out-of-proc is additive later |
| 5 | Package restore | in-proc NuGet client + lock file | shell out to dotnet restore | no SDK requirement, better errors, deterministic |
| 6 | Templating | sandboxed Scriban, whitelisted fns | full Jinja parity, hand-rolled | dbt ergonomics without dbt's non-determinism footguns |
| 7 | DAG inference | from ref()/source() at render time | SQL parsing | simple, exact, dbt-proven; DuckDB still validates the SQL — one scoped exception covers incremental *config* (never edges), inferred from DuckDB-parsed `watermark()` comparisons whose recognized shape is total-or-error |
| 8 | Batch sizing | byte-targeted (~32 MB) adaptive | fixed row counts | wide/narrow tables both hit the amortization sweet spot |
| 9 | Concurrency | channels + async + DAG limit; DuckDB self-parallel | custom thread pools | backpressure and bottleneck metrics for free; no lock-based data path |
| 10 | Observability | typed events → console/NDJSON/OTel renderers | printf logging | one truth, many views; OTel is wiring not surgery |
| 11 | Connector trust | JSON-Schema self-description + TestKit | central connector registry | CLI validates configs for connectors it has never seen; quality enforced by contract tests |
| 12 | Host distribution | framework-dependent dotnet tool, R2R | Native AOT | plugins need the JIT; startup mitigated by ReadyToRun |
| 13 | Retry + delivery guarantees | staged-data reuse, carried-forward sinks, provenance-gated advancement | re-extract on retry; sink-side slice ledger | the flaky source is never re-contacted for data it already delivered; the watermark only advances for slices every sink actually received; the ledger stays an additive future ([delivery guarantees](/concepts/delivery-guarantees/)) |
| 14 | Flow addressing & multi-flow invocation | independent flow = connected DAG component, computed on demand; `pz run <name>` = both-direction `+name+` closure; PZ0215 gates bare `run` on 2+ flows (`--all` is the explicit whole-project spelling); names/`--select`/`--all` mutually exclusive (PZ0216) | flow YAML or folder conventions; silently running everything by default | zero new config; selection rides the existing `--select` subset path (watermarks, retry, plan.json full-coverage all unchanged); running everything should be said out loud once a project holds more than one flow |
| 15 | Azure Blob/ADLS connector | first-party builtin `azureblob` connector (native `azure`-extension scan/copy + full-fidelity universal tier over the Azure Storage SDK), retiring the earlier "`azure://` deferred" position | leaving `azure://` permanently backlogged behind the S3-only `objectstore` sink | Azure is one of the two Microsoft-centric connectors the SQL Server design named (2026-07-12 design); two ratified judgment calls ship with it — no `PredicatePushdown` capability on the universal tier (an in-process parquet/csv reader can't honestly push a `WHERE` into a byte stream; that stays a native-tier property) and `abfss://` (ADLS Gen2) ships accepted/validated/unit-tested only, with the Azurite e2e round-trip gap documented (Azurite's Gen2 hierarchical-namespace emulation isn't faithful enough to test against) |
| 16 | Date-partitioned paths | calendar tokens (`{yyyy}/{MM}/{dd}/{HH}/{mm}`) in a shared, connector-agnostic `PathTemplate` (ABI helper); read pruning requires a bounded incremental window (PZ0217/PZ0218/PZ0221), write fan-out via `partition_by` is universal-tier only and per-partition atomic (PZ0219) | run-date/logical-date token expansion; numeric/arbitrary-key partitioning; all-or-nothing promote across partitions | watermark-window-driven pruning composes with existing bounded windows instead of a new run-date concept; per-partition atomic write matches how object-store partitioned writers actually behave and avoids false atomicity across N independent blob promotes (2026-07-13 design) |
| 17 | JSON (NDJSON) as a third format | shared `NdjsonCodec` (ABI, Arrow ↔ NDJSON) + native `read_json`/`COPY … (FORMAT json)`, wired in the **azureblob** connector; requires a declared `columns:` contract on the source side, same as csv (no inference) | per-connector JSON codecs; schema-inferring JSON reads | one shared codec other connectors can adopt instead of each rolling its own; consistent with csv's contract-required precedent (2026-07-13 design) — known caveat: non-finite `double`s (NaN/±Infinity) round-trip as literal tokens on the native tier but as JSON `null` on the universal tier (`System.Text.Json` has no bare-NaN literal), so a native-written file with non-finite doubles isn't readable by the universal tier — see [connectors.md](/concepts/connectors/#json-ndjson) |
| 18 | Watermark-scale hardening (many small files) | additive `IStreamingSource`/`ConnectorCapabilities.StreamingPartitions` drain (partitions yielded lazily under the existing bounded-channel gate, memory bounded to one listing page) + opt-in `files_per_partition` coalescing on the universal tier (`PZ0222` on non-positive/non-integer); native tier already avoids per-file objects and stays the preferred path for scale | a hard file-count ceiling with silent truncation; always one partition per file | bounds memory over millions of files without a new run-date concept or planner change; coalescing amortizes per-file dispatch/stream-open overhead on the universal fallback only, where native isn't available (2026-07-13 design) |
| 19 | Pipeline SQL expresses the whole load | inline `INSERT INTO {{ sink(...) }}` (scalar or array, for fan-out) is the **sole** load mechanism; sink outputs are a pure connection/dataset registry entry, never a producer binding | the YAML `input:` field on sink outputs (removed; a leftover `input:` is `PZ0112`) | one artifact — the pipeline SQL — names extract, transform, *and* load; keeps DAG-edge inference uniform (decision #7) across `source()`/`ref()`/`sink()`; declared-but-unbound output is now a non-blocking `PZ0207` warning, not a compile error, so a work-in-progress project still runs (2026-07-14 design) |
| 20 | Azure reads are native-only | reads ride the DuckDB `azure` extension exclusively, with no universal fallback; `INativeOnlySource` (mirroring `INativeOnlySink`) lets the planner refuse `engine.force_universal`/`files_per_partition` on it at plan time (`PZ0312`) | the universal *read* half of decision 15's dual-tier connector (`AzureCsvReader`, the batch half of `AzureParquetReader`, `AzureBlobPartition`/`AzureCoalescedPartition`, streaming enumeration) — it existed "so that `max_rows_per_second` pacing and `engine.force_universal` work against Azure storage" (2026-07-12 design §Tier 2) | a dual-maintained .NET reader per format for a knob built to protect struggling databases, not blob storage — no real workload needs a forced-universal blob read; the universal tier stays write-only (`partition_by` fan-out), and `GetSchemaAsync`'s SDK schema peek is untouched (2026-07-15 design) |
| 21 | Remove `max_rows_per_second` | throttling is duty-cycle (`max_window` + run spacing + `max_concurrency`) plus DB-side resource limits; `pacedMs` removed from the events wire (sanctioned pre-release break) | keep-for-databases-only; chunked native pacing; `pacedMs: 0` forever | pacing only ran on the universal tier, so every connector had to implement-or-reject it (the 2026-07-15 azure cycle deleted a ~600-line read stack that existed only for it); DB pacing was never integration-tested (2026-07-16 design) |
| 22 | Operation gate + request pacing (2026-07-20) | engine-owned `IOperationGate`/`IOperationGateAware` boundary a connector wraps each remote operation in — retry delays, jitter, pacing, and breaker state stay engine-side; a per-instance shared token bucket (`rate_limit:`) + proactive budget hints (`ReportBudget`) pace the operation, not the row; adopted by `http` (reads) and `azureblob`'s universal writes (`open_write`/`commit_copy`/`delete_temp`) only | connector-side retry loops per operation; a second, dataset-level rate limit; retrofitting `s3` | generalizes resilience to the operation boundary without breaking single-retry-owner or breaker semantics — the breaker still sees only the node's final outcome, and op exhaustion always consumes exactly one node attempt (bounded at `MaxAttempts` op × `MaxAttempts` node); a mid-crawl 429 now retries just the failed request instead of the whole node; `s3` has no universal write path (native-only `COPY` over httpfs) and its HTTP traffic happens inside DuckDB, out of .NET's reach by design — nothing to retrofit (2026-07-20 design) |
| 23 | Partition-scoped retry + intra-partition checkpoints | completed partitions' rows persist across attempts, accounted in a `pz_meta` ledger inside `staging.duckdb` updated atomically with the data; checkpoint tokens commit in the same transaction as the rows they cover | a dedicated partition-level retry loop | no new retry loop — partition failures aggregate into one transient node failure driving the existing attempt loop, and `pz retry` partial-reuses a failed SourceLoad's completed partitions through the same ATTACH machinery (2026-07-21 design) |
| 24 | Sink semantics | declared `AbortSemantics` surfaced on failure, compile/plan-time write-mode refusal (`PZ0228`/`PZ0324`), engine-owned delivery-checkpoint ledger in `pz_meta` with content-fingerprint guards; HTTP sink v1 is the driving consumer | letting a failed write imply cleanup it never did; letting a connector's mode declaration go unenforced until it throws at run time; a sink-side idempotency ledger for every connector | an honest abort story needs the connector's own declaration, not an assumption; mode refusal at compile/plan time turns a run-time surprise into a validation error; the delivery ledger is engine-owned so any `CheckpointableWrites` connector gets resumable delivery for free, while connector-side exactly-once `append` stays deferred (2026-07-21 design) |
| 25 | Unified sync/write declaration surface | two consolidated blocks — dataset `sync: { mode: auto\|incremental\|cdc }` (read) and output `write: { strategy, keys, duplicates, on_delete }` (write) — plus a compile/plan-time (read shape × write strategy) pairing matrix (`PZ0335` new-refuses `incremental`×`replace`; `PZ0214`'s consent becomes the matrix's `consent` cells); the pre-cycle per-dataset ordered-cursor block, the HTTP opaque-token marker block, and the loose top-level strategy/keys/consent output keys are all retired as compile errors (`PZ0332`/`PZ0333`) naming the exact rewrite; the connector ABI (`OutputSpec`, `DatasetSpec`) is untouched | per-cycle bolt-on keywords (a fourth read shape would have been a fourth top-level block); flow-level read/write intent instead of per-dataset/per-output declarations | one vocabulary each for "how is this read" and "how is this written", with pair legality stated once instead of scattered per-connector checks; CDC slots in as a matrix row/mode, never new keywords (2026-07-24 design) |
| 26 | Batch CDC for Postgres and SQL Server | `sync: {mode: cdc}` rides the existing run-to-completion engine — a bounded poll per `pz run` (pgoutput logical replication / native cdc change tables), landed raw into `<staging>__changes`, collapsed to last-event-per-key upserts (`ConnectorCapabilities.ChangeCapture`, `IChangeCapturePartition`) plus a net-deletes side table drained through `on_delete: delete\|soft\|ignore` (`ConnectorCapabilities.ApplyDeletes`, `IDeleteApplyingWriteSession`); the opaque log position (LSN) reuses the sync-state seam (commit-gated advancement, replay-from-last-committed-token) rather than a new state kind; `pz`-owned slot/capture-instance lifecycle inspectable/removable via `pz cdc status`/`drop` (`IChangeCaptureAdmin`) | a streaming/daemon consumer; a parallel CDC-specific state store; auto-enabling server-side prerequisites (wal_level, publications, `sp_cdc_enable_*`) | no cursor column required and deletes become representable, without a second execution model — the engine, retry-reuse, and delivery-guarantee machinery (decisions 13/25) apply unchanged; server-side setup stays the DBA's call, pz only validates and instructs (2026-07-24 design) |

| 27 | External-connector installability (2026-08-23) | `pz.lock.json` schema **v2** records each asset as (file name, **archive path**), and `PackageMaterializer` extracts by that recorded path; native assets select through a portable **RID graph** (`linux-musl-x64` reaches `linux-x64`) taking only the most specific match; a transitive package's `native/` flattens onto the connector's probe path the way `lib/` already did; a duplicate file name across two packages is `PZ0325` | re-finding an asset in the archive by file name under a `lib/`/`runtimes/` prefix; vendoring the SDK's `PortableRuntimeIdentifierGraph.json`; upgrading a v1 lock in place | a lock holding only file names discards the target framework and RID the resolver already chose, so a multi-targeted, multi-RID package silently installs whichever build comes first in the zip — a `net472` assembly on a .NET 10 host, an `arm64` native library on x86-64; both are files of the right name, so nothing looks wrong until a `MissingMethodException` or a wrong-architecture `dlopen`. The RID graph is derived structurally from one OS-ancestry table rather than vendored, which would need a third-party notices file; a v1 lock names no archive paths to upgrade *from*, so it is diagnosed (`PZ0321`) and regenerated (2026-08-23) |
| 28 | `partition_by` names columns; `path` says who lays them out (2026-08-23) | one meaning for the option — the columns an output is partitioned by, a name or a list — with calendar tokens in `path:` selecting **pz-rendered** layout (`PathTemplating`) and their absence selecting **destination-owned** layout (`ColumnPartitionedWrites`, new); `PartitionColumns` is the single parser, `DagCompiler` keeps only the connector-agnostic declaration checks (`PZ0219`), and the capability refusal is the planner's `PZ0314` | overloading `partition_by` to mean two different things per connector; letting each connector invent its own spelling for column partitioning; refusing `partition_by` without date tokens | a table format (Delta, Iceberg, Hive-layout parquet) partitions by column value with no path to route into, so the old "tokens required" rule made it undeclarable and any table written through pz unpartitioned; splitting on `path:` keeps one vocabulary while letting the two layouts stay distinct capabilities, and the compiler/planner split matches the existing source-side precedent (`PZ0313`) — only the planner holds the connector instance (2026-08-23) |
| 29 | Write attempt identity (2026-08-23) | `OutputSpec.Attempt` (`Node`, `Run`, `Ordinal`) stamped on the universal write path, additive on the ABI, so a sink whose destination holds a durable marker can skip work a previous attempt committed | a cross-run dedupe primitive; a connector-side slice ledger for every sink | closes the duplicate window `append` actually suffers — a commit that reached the destination and then failed to be reported back — within one run, which is where it happens; cross-run identity would need an origin run id threaded through `run_results.json` and every artifact backend, and a primitive silently unreliable in one backend is worse than one whose limit is stated on the type (2026-08-23) |

## Evolution path

The architecture grows toward these without a rewrite, because the contracts — Arrow batches,
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
- **Out-of-proc / polyglot connectors** — an adapter connector that speaks Arrow IPC over
  stdio to a child process, implementing the existing ABI (decision #4 was made to keep this
  additive).
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
