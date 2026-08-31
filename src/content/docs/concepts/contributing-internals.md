---
title: "Contributor internals"
description: "This article is for people working on PipelineZ itself, not using it: the performance and memory strategy, the testing strategy, and the solution layout...."
---

This article is for people working on PipelineZ itself, not using it: the performance and
memory strategy, the testing strategy, and the solution layout. Users can skip it.

## Performance and memory strategy

The levers, in impact order:

1. **Don't move the bytes through .NET at all** — the native scan/copy tier delegates to
   DuckDB's parallel readers/writers with pushdown.
2. **Zero-copy at the DuckDB boundary** — Arrow C Data Interface for ingest and egress; no
   per-value marshaling anywhere in the core path.
3. **Columnar batches, byte-targeted** — ~32 MB default, configurable via
   `engine.batch_bytes` (1MB..512MB): amortized dispatch, vectorized conversion at row-based
   edges only.
4. **Overlap everything** — extract ∥ ingest ∥ transform ∥ load across the DAG via async +
   bounded channels; throughput approaches max(stage) rather than sum(stages).
5. **Partitioned parallel extraction/loading** where connectors declare support.
6. **DuckDB owns big memory** — disk-backed staging + `memory_limit` + spill dir; out-of-core
   operators handle larger-than-memory joins/sorts. The host never buffers a dataset.

On the .NET side:

- **Arrow buffers live in native memory** via a pooling `MemoryAllocator` (power-of-two size
  classes over `NativeMemory`); batches are recycled after the ingest/write acknowledges. GC
  sees almost nothing; the LOH sees nothing. The C# Arrow implementation defaults to managed
  buffers — the allocator seam is ours; buffers crossing the C Data Interface are inherently
  pinned-native.
- **The lifetime protocol is explicit in the ABI**: a `RecordBatch` handed to
  `WriteBatchAsync` is engine-owned and valid until the call returns; batches produced by
  connectors are engine-disposed. The TestKit enforces this contract, because ownership bugs
  in a pooled system are the worst bugs.
- **A global memory budget ties it together**: `duckdb.memory_limit` + (channels × batch
  bytes × active nodes) + fixed overhead is computed and printed at plan time, so "how much
  RAM does this run need" has a static answer. The formula and measured baselines are in
  [Performance](/performance/).
- Benchmarks gate regressions; the internal North-star metric is **rows/sec/core at bounded
  RSS**, tracked per release.

## Testing strategy

- **Engine unit tests** — compiler, planner, selector parsing, dispatcher (simulated
  clocks/nodes), channel pipelines, memory pool (including hostile lifetime misuse).
- **Golden-file tests** — sample projects in-repo; `compile` output (rendered SQL, manifest,
  plan) snapshot-compared. Any behavior change is a visible diff in review — this is the
  determinism regression net.
- **DuckDB integration tests** — real in-proc DuckDB: ingest/egress round-trips across the
  full Arrow type matrix (decimals, nested types, timezones — where interop bugs actually
  live), spill behavior under tiny `memory_limit`.
- **`Pz.Connectors.TestKit`** — the ecosystem's keystone, like Airbyte's acceptance suite: a
  NuGet package of contract tests every connector author runs against their implementation
  (schema fidelity, cancellation honoring, batch lifetime rules, transactional commit/abort,
  transient-error classification, partition correctness). Ships with an in-memory reference
  connector as the executable specification.
- **End-to-end** — sample projects run against Testcontainers (Postgres, MinIO) in CI;
  assertions on `run_results.json` and destination contents.
- **Performance** — BenchmarkDotNet micro-benchmarks (batch builder, pool, interop boundary)
  plus a macro throughput harness with fixed datasets; results tracked across releases with
  regression thresholds.
- **Chaos-lite** — fault-injecting test connectors (fail at batch N, hang, return garbage
  schemas) to prove engine policies actually engage.

> [!NOTE]
> Two repo-wide test conventions: suites that need Docker must SKIP cleanly without it (never
> fail), and no test may sleep on the wall clock — determinism comes from gates and injected
> `TimeProvider`.

## Solution layout

```
pz/
├── Pz.slnx                          # solution file (not .sln)
├── src/
│   ├── Pz.Cli/                       # dotnet tool; verbs, console renderers
│   ├── Pz.Core/                      # project model, compiler, DAG, validation
│   ├── Pz.Engine/                    # dispatcher, node executors, retries, artifacts
│   ├── Pz.DuckDb/                    # C-API interop: arrow ingest/export, queries
│   ├── Pz.PackageManagement/         # NuGet resolve, lock file, out-of-process connector host (PCP)
│   ├── Pz.Connectors.Abstractions/   # THE contract (tiny; Apache.Arrow only)
│   ├── Pz.Connectors.TestKit/        # acceptance suite for connector authors
│   └── Pz.Diagnostics/               # events, ActivitySource, meters, renderer glue
├── connectors/                          # first-party reference connectors (separate
│   ├── Pz.Connector.LocalFiles/      #   release cadence, but in-repo initially to
│   ├── Pz.Connector.Postgres/        #   keep the ABI honest)
│   ├── Pz.Connector.S3/              # S3-compatible object storage (native COPY sink)
│   └── Pz.Connector.AzureBlob/       # Azure Blob Storage / ADLS Gen2, native
│                                      #   azure-extension + universal Azure SDK tiers
├── tests/
│   ├── Pz.Core.Tests/  Pz.Engine.Tests/  Pz.DuckDb.Tests/
│   ├── Pz.EndToEnd.Tests/            # Testcontainers
│   ├── Pz.TestSupport/               # shared test utilities
│   └── Pz.Benchmarks/
├── templates/                           # `pz init`'s five built-in starting points; real,
│                                     #   in-place-runnable projects, embedded into Pz.Cli
│                                     #   and bound to TemplateCatalog by set-equality tests
├── samples/                             # golden-file projects; double as docs
└── docs/
```

Dependency direction is strictly downward, with `Abstractions` at the bottom carrying
near-zero dependencies. `Pz.DuckDb` isolates the riskiest code (native interop) behind an
interface the engine consumes, so a DuckDB.NET-based implementation and a direct-P/Invoke
implementation can be swapped and benchmarked. Target: current LTS (net10.0 today), C#
latest, nullable enabled, `InternalsVisibleTo` only for test projects.

## Next steps

- [Performance](/performance/) — budget formula, benchmark suites, measured baselines.
- [Architecture overview](/concepts/architecture-overview/) — the decision log behind these choices.
- `CONTRIBUTING.md` — workflow, commit conventions, release process.
