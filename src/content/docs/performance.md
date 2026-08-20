---
title: "Performance"
description: "Performance is a measured property here, not a claim: a BenchmarkDotNet micro-benchmark suite (tests/Pz.Benchmarks), a fixed-dataset macro throughput..."
---

Performance is a measured property here, not a claim: a BenchmarkDotNet micro-benchmark suite
(`tests/Pz.Benchmarks`), a fixed-dataset macro throughput harness (`scripts/macro-bench.sh`), and a
static memory budget the planner prints and persists.

**Every number on this page is a baseline from one specific development machine, not a gate.** Numbers
recorded here are labeled with that machine's specs; re-run the harnesses on your own hardware before
comparing. Benchmarks are excluded from `dotnet test` deliberately: they measure a machine, not a
contract, and a slow runner must never fail the suite.

## Memory budget formula

`pz plan` prints, and plan.json's additive `memoryBudget` object records, a static memory budget
computed entirely from project config — no connection to DuckDB or the OS, so planning stays
side-effect-free and the number is available before any node runs (decision 8):

```
total = duckdb.memory_limit (parsed to bytes) + engine.threads * 6 * batch_bytes + 256MB fixed overhead
```

- **`duckdb.memory_limit`**: parsed from the project's `engine.duckdb.memory_limit` string (e.g.
  `1GiB`, `512MB`, a bare byte count). Decimal units (`KB`/`MB`/`GB`/`TB`, 1000-based) and binary units
  (`KiB`/`MiB`/`GiB`/`TiB`, 1024-based) are both accepted, case-insensitively.
  **When `memory_limit` is unset, or set to something that isn't a fixed byte size** (DuckDB itself also
  accepts a bare percentage like `80%` for this setting — its own internal default), the byte count
  can't be known deterministically: DuckDB's default is "80% of the machine's RAM," which depends on the
  machine that runs the query, and plan.json is supposed to be reproducible regardless of which machine
  generated it. In that case `duckdbBytes` is `null` and a `duckdbDisclaimer` string explains why; the
  disclaimed amount is treated as **0** in the total, so the number is a documented lower bound, never a
  guess dressed up as a fact.
- **`engine.threads * 6 * batch_bytes`**: an estimate of in-flight bounded-channel memory. 6 = the
  channel's capacity of 4 plus one batch being produced plus one being ingested/consumed, per thread of
  concurrency. `batch_bytes` is `engine.batch_bytes` if configured, else `BatchOptions.Default`'s 32MiB
  (`Pz.Connectors.Abstractions.ConnectorTypes.BatchOptions`).
- **256MB fixed overhead**: headroom for everything the formula doesn't itemize (connector/runtime
  bookkeeping, the .NET runtime itself, etc).

### What the total does NOT promise (2026-08-15)

The total is a **ceiling on what pz and DuckDB may hold**. It is not a promise that a given workload
fits inside `duckdb.memory_limit`. DuckDB's own floor for materializing a table scales with that
table's **column count times its thread count**, and neither appears in the formula. Measured: a
20,000-row x 1,000-column table exhausted a `memory_limit: 1GiB` (PZ0501) while `pz plan` printed
`memory budget: ~1.63 GB`; the same project succeeded, unchanged, with `engine.duckdb.threads: 1`.

Two things make that easy to walk into:

- **`engine.duckdb.threads` is a different key from `engine.threads`.** `engine.threads` sizes the
  channel term above and the dispatcher's concurrency; it never reaches DuckDB. `engine.duckdb.threads`
  is what DuckDB sees, and it is **unset by default**, so DuckDB uses the machine's core count — making
  the real floor machine-dependent even though every byte the formula prints is reproducible.
- **The formula cannot simply grow a column term.** A contract-less csv/json dataset has no declared
  schema at plan time (2026-08-12 schema-inference cycle), and planning stays side-effect-free, so the
  planner cannot open the file to count columns. A term present for declared contracts and silently
  absent for inferred ones would look authoritative exactly where it is blind.

So the budget states the caveat instead of guessing: when `engine.duckdb.threads` is unset,
`pz plan` prints a `note:` line and plan.json's `memoryBudget` carries a `duckdbThreadsDisclaimer`
string (null when the key is set). Set `engine.duckdb.threads` to make DuckDB's floor deterministic —
and if a wide-schema node hits PZ0501, lower it before raising `memory_limit`.

Implementation: `src/Pz.Engine/Planning/MemoryBudget.cs` (`MemoryBudget.Compute`); wired into
`ExecutionPlanner.PlanAsync` (an optional `EngineConfig?` parameter, additive — every existing call site
compiles unchanged) and rendered by both `PlanCommand` (the console line) and `PlanWriter` (plan.json).

### Worked example (`samples/hello-pz`: `threads: 2`, `duckdb.memory_limit: 1GiB`, default `batch_bytes`)

```
memory budget: ~1.63 GB (duckdb 1.00 GB + channels 0.38 GB + overhead 256MB)
note: engine.duckdb.threads is not set (it is a different key from engine.threads, ...)
```

The `note:` line is present because `hello-pz` does not set `engine.duckdb.threads`; setting that key
drops the line and nulls the field below.

```json
"memoryBudget": {
  "duckdbBytes": 1073741824,
  "duckdbDisclaimer": null,
  "channelBytes": 402653184,
  "fixedOverheadBytes": 268435456,
  "totalBytes": 1744830464,
  "duckdbThreadsDisclaimer": "engine.duckdb.threads is not set ..."
}
```

`1073741824 (1GiB) + 402653184 (2 threads * 6 * 32MiB) + 268435456 (256MB) = 1744830464 bytes ≈ 1.625GiB`.

### plan.json golden regeneration (sanctioned, additive-only)

`memoryBudget` is appended as the **last** top-level key, after `nodes` — every byte before it in
plan.json is unchanged from the pre-Task-4 shape. Every test literal that changed only added this one
object:

- `tests/Pz.Engine.Tests/Artifacts/PlanWriterTests.cs`: `Plan_json_field_order_and_final_newline`'s
  expected string gained the `memoryBudget` block (5 fields, matching the JSON shown above) after the
  existing `nodes` array — nothing before it changed.
- No other golden fixture files exist for plan.json (there is no standalone `plan.json` fixture on
  disk); `HelloRunTests`/`PlanCommandTests` parse plan.json structurally (`JsonDocument`, property
  lookups) rather than comparing literal text, so they were unaffected by the addition.

## Micro-benchmarks (`tests/Pz.Benchmarks`)

Console app, `IsTestProject=false` / `IsPackable=false`, listed in `Pz.slnx` but **never** run by
`dotnet test` (verified: the full-suite `dotnet test Pz.slnx` run below never even attempts to load
`Pz.Benchmarks.dll` — it isn't a test-SDK project, so the `dotnet test` MSBuild target skips it
entirely). Run it directly:

```bash
dotnet run -c Release --project tests/Pz.Benchmarks -- --filter '*'          # full run
dotnet run -c Release --project tests/Pz.Benchmarks -- --job short --filter '*BatchBuilder*'   # smoke mode
```

Stability settings (decision 7): fixed seeds (`BenchData.GenerateRows`, `Random(42)` by default),
pre-generated in-memory row data, `[MemoryDiagnoser]` on every class, and a raised `MinIterationCount`
(10) for the cheap micro-benchmarks so BenchmarkDotNet's pilot stage doesn't stop sampling too early
(`MicroBenchmarkConfig`). The two DuckDB round-trip benchmarks (ingest/egress) use a separate config
(`MacroishBenchmarkConfig`, `RunStrategy.Monitoring`, 1 invocation/iteration, 3 iterations) since a
single invocation already moves 1M rows — BenchmarkDotNet's default multi-invocation unrolling would
blur one run's cost across several DB operations. `--job short` (BenchmarkDotNet's built-in `ShortRun`
preset) is the smoke-mode entry point CI calls; no custom argument parsing was needed.

### Baseline (this machine)

Intel Core i7-8665U CPU @ 1.90GHz (Coffee Lake), 8 logical / 4 physical cores, 15GiB RAM, Arch Linux,
.NET SDK 10.0.203, `dotnet run -c Release`, 2026-07-04.

| Benchmark | Mean | Allocated (managed) | Notes |
|---|---|---|---|
| `BatchBuilderBenchmarks`: append 100k rows (pooled allocator, default 32MiB batch size) | 37.4 ms | 7.16 MB | ~2.67M rows/sec constructing batches; all 100k rows fit in one batch at this schema's byte density, so this is pure append + one `Build()`/`Flush()`. |
| `AllocatorBenchmarks`: rent+return 64KB, unpooled (`Apache.Arrow.NativeMemoryAllocator`) | 4.45 μs | 50 B | Baseline: a fresh `NativeMemory.AlignedAlloc`/free pair every call. |
| `AllocatorBenchmarks`: rent+return 64KB, pooled (`PooledNativeAllocator`, warm pool) | 2.32 μs | 48 B | **~1.9x faster** than unpooled at this size. |
| `AllocatorBenchmarks`: rent+return 1MiB, unpooled | 76.3 μs | 88 B | |
| `AllocatorBenchmarks`: rent+return 1MiB, pooled (warm pool) | 48.6 μs | 48 B | **~1.6x faster** than unpooled at this size; managed allocation is a flat ~48B regardless of request size (pooled) vs growing with size (unpooled). |
| `IngestBenchmarks`: ingest 1M rows (build batches + `DuckSession.IngestArrowAsync`) | 1.240 s | 9.19 MB | ~806,000 rows/sec. |
| `EgressBenchmarks`: egress 1M rows (`DuckSession.QueryArrowAsync` draining the full result) | 1.042 s | 116.0 MB | ~960,000 rows/sec. Egress allocates more (managed) than ingest because every row's values are boxed on the way out of the DuckDB reader before being handed to `ArrowBatchBuilder.AppendRow`. |

Raw BenchmarkDotNet reports (`*-report-github.md`/`.csv`/`.html`) land in `BenchmarkDotNet.Artifacts/`
(gitignored) next to wherever you invoke `dotnet run` from.

## Macro throughput harness (`scripts/macro-bench.sh`)

```bash
scripts/macro-bench.sh [row_count]     # default 1,000,000
```

`set -euo pipefail`. Builds Release, generates a deterministic CSV (every value is a pure function of
the row index and a fixed seed via `awk` arithmetic — no `rand()`, so the file is byte-identical on
every machine and every run), then runs `pz run` twice against the identical data: once with the
engine's default native path (LocalFiles' `native_scan`/`native_copy`), once with
`engine.force_universal: true` (the `arrow_stream` universal path) — printing rows/sec for each so the
two tiers documented as behaviorally interchangeable can also be compared for throughput.
A third leg times the passthrough floor: `scripts/passthrough-floor-probe.cs` executes the one
fused statement a native-fusion planner would emit (`COPY (SELECT * FROM read_csv(...)) TO ...`)
through the production `DuckSession`, and the harness prints `max fusion win vs native` — the
upper bound on what a pass-through fast path could save for a pure-EL flow.

### Baseline (this machine, 1,000,000 rows, same hardware as above; re-measured 2026-08-13, median of three runs)

| Path | Wall time (incl. `dotnet run` CLI startup) | Rows/sec |
|---|---|---|
| Native (`native_scan` + `native_copy`) | 1.8613 s | ~537,258 |
| Universal (`engine.force_universal: true`, `arrow_stream`) | 4.8721 s | ~220,906 |

> Superseded for the universal leg: see "Universal-tier text encoding (2026-08-16)" below — the same
> harness now measures ~1.9× on this hardware. The reasoning in this section still holds; the number
> does not.

Native is **~2.6x** the universal path's throughput here — expected, since the universal path pays for
an Arrow round-trip (CSV → Arrow batches → DuckDB ingest → DuckDB query → Arrow batches → CSV) that the
native path skips entirely (DuckDB's own `read_csv`/`COPY` do the whole edge in one native call). Wall
time includes `dotnet run`'s own CLI/JIT startup cost for each invocation, so per-row throughput in a
long-lived process (or `pz` invoked as a published binary) is higher than these numbers suggest; they're
reported as measured, not adjusted, per decision 7's "labeled as such" rule. Re-measured 2026-08-13
(median of three back-to-back runs; the 2026-07-31 numbers were a single run on the same hardware and
sit inside this spread — same character, same conclusions).

### Pure-EL staging floor (this machine, 1,000,000 rows, same hardware as above)

| Path | Wall time | Rows/sec |
|---|---|---|
| Native (staged: land -> staging.duckdb -> drain) | 1.8613 s | ~537,258 |
| Universal (`arrow_stream`, `engine.force_universal: true`) | 4.8721 s | ~220,906 |
| Fused floor (`COPY (SELECT * FROM read_csv(...)) TO ...`, one statement) | 0.4102 s | ~2,437,835 |

**Max fusion win vs native: 78%.** The floor excludes all pz orchestration (CLI startup,
compile, plan, staging) while the native leg includes them, so this overstates what a real
in-engine fused path would save — a fused `pz run` would land between the two rows.

Reading, against thresholds fixed before the benchmark ran:
< 20% — drop the fast-path idea; >= 40% — a native-tier fusion fast path is justified;
20–40% — judgment call. **Measured: 78% — >= 40%, a native-tier fusion fast path is justified.**
`scripts/macro-bench-mssql.sh` is out of scope: SQL Server's native sink is
SqlBulkCopy + `MERGE`, not DuckDB `COPY`, so fusion as measured here does not apply to it.

### Universal-tier text encoding (2026-08-16)

The 2026-08-15 stress harness's finding F4 measured the universal csv sink at ~7.7× DuckDB's native
`COPY` and attributed it to per-cell string building. Fixing that (`CsvWriteCodec` formatting straight
into a pooled UTF-8 buffer from pinned Arrow buffers, `CsvArrowReader` parsing out of Sylvan's char
buffer, `NdjsonCodec` reusing one `Utf8JsonWriter` per batch) moved the tier, so the ratios above are
older than the code. A/B on one machine, same data, minutes apart — 5M rows, csv → csv,
`engine.force_universal`, node durations from `run_results.json`:

| | before | after | native tier (unchanged) |
|---|---|---|---|
| SourceLoad | 5003 ms | 4162 ms | 1249 ms |
| SinkWrite | 5773 ms | **2763 ms** | 873 ms |
| wall | 12.2 s | **8.6 s** | 4.7 s |

The universal sink node went from 6.6× the native tier to 3.2×, and a whole universal run from 2.6× to
1.9×. The same A/B through `macro-bench.sh` (1M rows, so CLI startup is a large share of wall):
universal 6.33 s → 5.40 s against an unchanged native 2.9 s. Both legs of that harness ran ~50% slower
than the 2026-08-13 table above on the same hardware, so read its *ratio* (2.16× → 1.93×), not its
absolute seconds, against that table.

What remains is largely inherent to the format rather than to pz's plumbing: formatting a `double`
round-trip ("R") costs ~340 ns and parsing one ~184 ns, which dominates both directions on any table
with a float column. Allocation is no longer a factor in either direction (the csv write path allocates
nothing per batch; NDJSON went from ~650 MiB per million rows to ~0). `scripts/stress/csv-write-probe.cs`
and `csv-read-probe.cs` split these costs apart per column type.

### Universal-tier csv reads, split across cores (2026-08-16)

The section above left the universal read at ~3.3× the native tier and named two candidates for the
rest. Both were built; only one mattered, which is worth recording because the estimate that motivated
the other was wrong.

A/B on one machine, minutes apart, 5M rows csv → csv, `engine.force_universal`, SourceLoad node duration
from `run_results.json`. **This machine is running ~1.7× faster today than during the section above**
(its native control moved 1249 ms → 706 ms with no code change between), so compare ratios across
sections and absolute numbers only within one:

| SourceLoad, 5M rows | duration | vs native control (706 ms) |
|---|---|---|
| before both changes | 2540 ms | 3.6× |
| \+ builder-free column writers | 2369 ms | 3.4× |
| \+ concurrent byte-range partitions | **1864 ms** | **2.6×** |

**Splitting the file is what moved it.** `CsvSplitPlanner` walks the file once (~120 ms for 146 MB) and
hands back byte ranges the engine reads concurrently, which takes the node from reader-bound to
ingest-bound — its bottleneck hint flips to "ingest-bound — reader idle 65%". Past that point the node
is waiting on `IngestArrowAsync`, so further reader optimization has no wall-clock effect at all; the
Arrow-ingest floor measured in the section above is now the thing in the way.

**Arrow's array builders were not the ~30–60 ns/cell the section above assumed.** Replacing them with
hand-written column writers (`CsvColumnWriter`, laying values into Arrow's memory layout directly) is
worth ~5%, not the 0.6–1.2 s that estimate implied — on a clean A/B of the reader alone, 1820 ms → 1740
ms for 20M cells, i.e. ~4 ns/cell, not 40. The change is kept because it also removes CPU that would
otherwise contend with the ingest thread and the other readers, but as a wall-clock lever it is noise
next to the split. What actually dominates the remaining reader time is `double.TryParse`.

One caveat that is a real behaviour change: **a split read lands rows in a non-deterministic order.**
The partitions race through one bounded channel. This dataset's other tier (DuckDB's parallel
`read_csv`) already behaves that way and the engine has never guaranteed cross-partition order, but an
unsplit csv read did land rows in file order in practice. Files below 64 MiB are never split, so every
fixture, sample and golden file keeps its old ordering.

## Macro throughput harness — SQL Server (`scripts/macro-bench-mssql.sh`)

```bash
scripts/macro-bench-mssql.sh [row_count]     # default 1,000,000
```

Quantifies SQL Server → SQL Server throughput end to end through
`pz run`, mirroring `scripts/macro-bench.sh`'s conventions (`set -euo pipefail`, deterministic seed data,
rows/sec report) but standing up a real `mcr.microsoft.com/mssql/server:2022-latest` container via plain
`docker run` (not Testcontainers, so it runs outside the test harness) and seeding it with `sqlcmd`.
SKIPs cleanly (exit 0, `SKIP: docker not available`) when docker isn't present. Three scenarios against
the same seeded `dbo.src` table, each a fresh `pz run --all` over a generated `connections.yml` project
using the `sqlserver` connector (builtin — no `connectors:`/package restore needed), each verified to
have landed exactly the seeded row count in the target table before its time is reported:

1. **Read ×1 partition, append** — `read: { partition_column: id, partitions: 1 }`, sink
   `write: { strategy: append }`.
2. **Read ×4 partitions, append** — same, `partitions: 4` (parallel partitioned read).
3. **Read ×1 partition, merge** — `partitions: 1`, sink `write: { strategy: merge, keys: [id] }`
   (stages into a `#temp` table, then one set-based `MERGE`).

A fourth, optional leg is the **raw-DuckDB yardstick**: when the `duckdb` CLI is on PATH and the
community `mssql` extension installs, the same seeded table is read (`CREATE TABLE ... AS FROM
ms.dbo.src` into a disk-backed DuckDB file — the analogue of pz's SourceLoad into staging.duckdb) and
written back (CTAS into SQL Server over the extension's parallel-BCP path) through DuckDB alone, no pz
orchestration. That is the "how close to raw DuckDB are we" number; the leg SKIPs cleanly without the
CLI or offline. (2026-08-13: the harness was migrated off the retired `sources/`/`sinks/` surface to
`connections.yml`, and grew the row-count verification and this yardstick leg, in the same change.)

### Baseline (this machine, 1,000,000 rows — median of three back-to-back runs; re-measured 2026-08-13)

Intel Core i7-8665U CPU @ 1.90GHz (Coffee Lake), 8 logical / 4 physical cores, 15GiB RAM, Arch Linux,
.NET SDK 10.0.203, Docker 29.6.2, `mcr.microsoft.com/mssql/server:2022-latest`, DuckDB CLI v1.5.4 +
community `mssql` extension, 2026-08-13 — after sized text DDL for SQL Server sink string
columns landed on `main`.

| Leg | Wall time (median; min–max over 3 runs) | Rows/sec (median) |
|---|---|---|
| pz: read ×1 partition, append | 10.5 s (8.7–13.7) | ~95,238 |
| pz: read ×4 partitions, append | 10.7 s (9.4–12.6) | ~93,458 |
| pz: read ×1 partition, merge | 16.3 s (13.9–17.4) | ~61,350 |
| DuckDB ext: read (CTAS `ms.dbo.src` → local file) | 3.1 s (3.1–3.2) | ~322,581 |
| DuckDB ext: write (CTAS local → `ms.dbo.ext_out`) | 13.1 s (12.1–15.2) | ~76,336 |

Wall time includes each invocation's process startup (`dotnet` CLI/JIT for the pz legs, `duckdb` CLI +
`ATTACH` for the extension legs), so per-row throughput in a long-lived process is higher than these
numbers suggest; they're reported as measured, not adjusted. Run-to-run spread on this laptop-class
machine is large (±25%, thermal), hence the median-of-three convention for this table.

**Reading the yardstick.** End to end (read + write of the same 1M rows), the DuckDB extension's
roundtrip is 3.1 + 13.1 ≈ 16.2 s against pz's 10.5 s — the staged `pz run` now moves SQL Server →
SQL Server ~1.5× faster than raw DuckDB's own mssql extension does, because pz's `SqlBulkCopy` sink
outruns the extension's BCP write by more than the extension's faster read saves. That flipped with the
sized-text-DDL cycle: before it, string columns landed as `nvarchar(max)` (LOB/PLP path) and the pz
sink alone ran ~5× slower than the same rows into sized columns; now created tables get engine-measured
sizes (e.g. this dataset's `status` lands as `nvarchar(32)`, verified via `sys.columns`), and the
append node reports sink-bound with the writer idle ~60% — the write is no longer the bottleneck.
On the read side alone the extension remains ~3× faster than pz's universal Arrow path (both are
single-stream TDS; pz's read is ingest-bound behind the run's one serialized DuckDB connection), which
is why ×4 read partitions no longer help once the write is fast: the whole pipeline's remaining cost is
read-side ingest, not extraction.

Merge is slower than append, as expected: merge stages every row into a `#temp` table (mirroring the
target's — now sized — types), clusters it on the merge keys, then runs a set-based
`MERGE WITH (HOLDLOCK)` against the target, vs. append's direct `SqlBulkCopy` straight into the
destination table.

The earlier 2026-07-15 baseline (100k rows, ~32k rows/sec append) predates both the sized-text-DDL
cycle and the harness's migration off the retired `sources/`/`sinks/` surface, and is superseded by
the table above.

## Macro throughput harness — Postgres (`scripts/macro-bench-postgres.sh`)

```bash
scripts/macro-bench-postgres.sh [row_count]     # default 1,000,000
```

Same conventions and scenario set as the SQL Server harness (docker `postgres:16-alpine`, seeded
`public.src`, per-scenario row-count verification, an optional raw-DuckDB yardstick — here DuckDB's
own `postgres` extension, which reads and writes over binary `COPY`).

### Baseline (this machine, 1,000,000 rows — median of three back-to-back runs, 2026-08-13, post universal-path optimization)

Same hardware/software stack as the SQL Server baseline above; DuckDB CLI v1.5.4 + core `postgres`
extension. This baseline includes the same-day postgres-universal-perf changes (append COPYs directly
into the target; typed `DataReaderSource`; sync importer writes) — the pre-optimization append median
was 6.3 s (3.3× the extension roundtrip).

| Leg | Wall time (median; min–max over 3 runs) | Rows/sec (median) |
|---|---|---|
| pz: read ×1 partition, append | 4.9 s (4.8–4.9) | ~204,082 |
| pz: read ×4 partitions, append | 5.4 s (4.9–5.4) | ~185,185 |
| pz: read ×1 partition, merge | 18.2 s (17.8–18.4) | ~54,945 |
| DuckDB ext: read (CTAS `pg.public.src` → local file) | 0.6 s (0.6–0.6) | ~1,666,667 |
| DuckDB ext: write (CTAS local → `pg.public.ext_out`) | 1.3 s (1.1–1.3) | ~769,231 |

**Reading the yardstick.** Postgres is where the raw-DuckDB gap is real: the extension's binary-`COPY`
roundtrip is 0.6 + 1.3 ≈ 1.9 s against pz's 4.9 s — **pz is ~2.6× slower end to end** (3.3× before the
2026-08-13 optimization), the largest gap of any connector pair on this page. A layer-isolation probe
(same table, same machine, warm) decomposes it:

| Mechanism (1M rows, Npgsql 10) | Time |
|---|---|
| Npgsql `SELECT` read, typed getters | 1.2 s |
| Npgsql binary-`COPY` read (`COPY TO STDOUT`) | 1.3 s |
| Npgsql binary-`COPY` write → temp table | 1.5 s |
| server-side `INSERT target ← temp` (the old sink finalize) | 2.2 s |
| Npgsql binary-`COPY` write → target directly | 1.8 s |

Two conclusions fell out. First, the win that shipped: the sink's temp-table indirection was a
server-side **double write** (COPY into a WAL-free temp + INSERT into the target ≈ 3.7 s vs 1.8 s
copying straight in), so append now COPYs directly into the target inside the same transaction —
that's the 6.3 → 4.9 s. Replace deliberately keeps the temp path (truncate-early + direct COPY would
block concurrent readers for the whole load instead of showing them the old rows until COMMIT), and
merge needs the staged rows for its dedup + `ON CONFLICT` statement. Second, the negative result,
recorded so nobody re-litigates it: replacing the boxed row pivot with typed column plans and the
per-cell awaits with sync importer writes changed end-to-end time by **zero** in an interleaved A/B —
and the probe explains why: the Npgsql driver floor is ~1.2 s per direction *regardless of
mechanism* (`SELECT` and binary `COPY` read within 5% of each other), so per-cell CPU in .NET was
never the bottleneck. pz's append is now essentially at the universal-tier floor: ~1.2 s read +
~1.8 s write + ~0.3 s pipeline + ~1.4 s fixed CLI/compile/finalize ≈ 4.9 s observed. The residual
per-row gap (~3.0 s vs the extension's ~1.9 s, → ~1.6× at scale as fixed costs amortize) is C++ vs
.NET driver efficiency, and only a native tier over DuckDB's own `postgres` extension closes it —
parked for now; unlike SQL Server there is no protocol
asymmetry for pz to win back, since DuckDB speaks Postgres' wire format natively. Merge (18.2 s) pays
for `ON CONFLICT` upsert row processing on top of the same write path. Numbers are remarkably stable
here (±2%) — the variance in the SQL Server table is the SQL Server container, not the harness.

## Macro throughput harness — S3/MinIO (`scripts/macro-bench-s3.sh`)

```bash
scripts/macro-bench-s3.sh [row_count]     # default 1,000,000
```

LocalFiles CSV (native scan, declared contract) → s3 sink, against a docker MinIO. The s3 sink is
native-only — every output is a DuckDB `COPY` over httpfs with a scoped `CREATE SECRET` (decision
10) — so the pz legs measure that `COPY` plus pz's orchestration around it, and the yardstick legs
run the *same* `COPY` statement through the `duckdb` CLI alone. Row counts verified through an
independent httpfs read after every leg.

### Baseline (this machine, 1,000,000 rows — median of three back-to-back runs, 2026-08-13)

Same stack; `minio/minio:RELEASE.2025-09-07T16-13-09Z`, DuckDB CLI v1.5.4 + `httpfs`.

| Leg | Wall time (median; min–max over 3 runs) | Rows/sec (median) |
|---|---|---|
| pz: csv → s3 csv (replace) | 1.6 s (1.6–1.7) | ~625,000 |
| pz: csv → s3 parquet (replace) | 1.4 s (1.4–1.5) | ~714,286 |
| DuckDB: same COPY, csv | 0.8 s (0.8–0.9) | ~1,250,000 |
| DuckDB: same COPY, parquet | 0.5 s (0.5–0.6) | ~2,000,000 |

The data plane is identical by construction, so the difference — a flat ~0.8–0.9 s regardless of
format — is pz itself: CLI/JIT startup, compile/plan/validate, the staged materialize into
staging.duckdb between scan and copy, and finalize. That fixed cost shrinks proportionally as rows
grow, and is the same "max fusion win" territory the pure-EL staging floor above measures for local
files.

## Macro throughput harness — Azure Blob/Azurite (`scripts/macro-bench-azureblob.sh`)

```bash
scripts/macro-bench-azureblob.sh [row_count]     # default 1,000,000
```

LocalFiles CSV ↔ Azure Blob against a docker Azurite (3.35.0, `--skipApiVersionCheck` for newer az
CLIs; the az CLI is required for container creation — the harness SKIPs without it). The azureblob
connector is native-tier both ways here (read: native-only scan over the DuckDB `azure` extension;
non-partitioned write: native `COPY` over the same extension), so as with s3 the yardstick runs the
same statements through the `duckdb` CLI alone. Blob row counts verified through independent azure
reads; the download leg's local file is line-counted.

### Baseline (this machine, 1,000,000 rows — median of three back-to-back runs, 2026-08-13)

Same stack; `mcr.microsoft.com/azure-storage/azurite:3.35.0`, DuckDB CLI v1.5.4 + core `azure`
extension.

| Leg | Wall time (median; min–max over 3 runs) | Rows/sec (median) |
|---|---|---|
| pz: csv → az csv (replace) | 1.1 s (1.1–1.2) | ~909,091 |
| pz: csv → az parquet (replace) | 1.0 s (1.0–1.1) | ~1,000,000 |
| pz: az csv → local csv | 1.4 s (1.4–1.4) | ~714,286 |
| DuckDB: same COPY, csv up | 0.8 s (0.7–0.8) | ~1,250,000 |
| DuckDB: same COPY, parquet up | 0.5 s (0.5–0.5) | ~2,000,000 |
| DuckDB: same COPY, csv down | 0.6 s (0.6–0.6) | ~1,666,667 |

Same reading as s3: identical data plane, so the delta (~0.3–0.8 s flat) is pz's fixed orchestration
cost around the native statements.

## How close is pz to raw DuckDB? (cross-connector summary, 1M rows, 2026-08-13)

The recurring question behind all four yardsticks, in one table — "raw DuckDB" is the closest
pure-DuckDB equivalent of the same end-to-end movement (extension CTAS roundtrip for the databases,
the same native COPY via the CLI for the object stores, the fused floor for local files):

| Edge | pz (median) | raw DuckDB | pz / DuckDB |
|---|---|---|---|
| SQL Server → SQL Server (append) | 10.5 s | ~16.2 s | **0.65× — pz is faster** (sized-DDL `SqlBulkCopy` beats the extension's BCP) |
| Postgres → Postgres (append) | 4.9 s | ~1.9 s | 2.6× (was 3.3× before the 2026-08-13 direct-COPY append; now at the .NET universal-tier floor — residual is driver C++-vs-.NET, ~1.6× at scale) |
| CSV → S3 (csv / parquet) | 1.6 / 1.4 s | 0.8 / 0.5 s | 2.0× / 2.8× wall, but the delta is a flat ~0.8 s of orchestration around an identical COPY |
| CSV ↔ Azure Blob | 1.0–1.4 s | 0.5–0.8 s | 1.4–2.3× wall; flat ~0.3–0.8 s delta, same shape |
| Local CSV → CSV (native) | 1.86 s | 0.41 s (fused floor) | 4.5× vs a floor that skips all orchestration; the staged-vs-fused question, decision recorded above |

Fixed per-run costs (CLI/JIT startup, compile/plan, staging, finalize) dominate every ratio except
Postgres — at 10M+ rows the object-store and local ratios converge toward 1; the Postgres gap is
per-row and converges only toward ~1.6× (the Npgsql-vs-C++ driver floor measured in the probe
above), with the native-tier idea as the recorded path past it.

## Controller-routed addendum: DuckSession gate serialization cost

The ledgered follow-up from the race fix (`DuckSession._gate`'s doc comment): a single
`DuckDBConnection` isn't safe for concurrent statement execution, so every operation that touches it
(ingest, egress, scalar/execute) is serialized behind one `SemaphoreSlim(1,1)`, held for the *entire*
streaming duration of ingest/egress — not just around individual native calls. That's a correctness fix,
and a known, flagged performance cost: two concurrent nodes that both touch DuckDB get zero real overlap
between them, no matter how many CPU cores are free.

`scripts/gate-serialization-probe.cs` (a .NET 10 file-based app, `#:project`-referencing
`Pz.DuckDb`/`Pz.Connectors.Abstractions` directly — no test doubles) quantifies this against real
production `DuckSession` code. It runs three operations — two source-style ingests (200k rows each) and
one deliberately slow sink-style egress query (a `WHERE hash(i) % 1000000 = 0` clause over 200M rows,
which forces real per-row computation DuckDB can't constant-fold away) — twice, back to back against the
same already-warmed `DuckSession` (a throwaway warm-up pass first equalizes JIT/plan-cache/buffer-pool
state so the two measured runs are apples-to-apples):

1. **Sequential**: the three operations awaited one at a time, in order.
2. **Concurrent**: the same three operations issued together via `Task.WhenAll` — the same shape
   `RunOrchestrator`'s concurrent node dispatch uses in a real multi-node run.

If the gate produces zero real overlap, concurrent elapsed ≈ sequential elapsed: asking for concurrency
bought nothing.

```bash
dotnet scripts/gate-serialization-probe.cs
```

### Baseline (this machine)

| Run | Elapsed |
|---|---|
| Sequential (one at a time) | 5.12 s |
| Concurrent (`Task.WhenAll`) | 4.81 s |

Concurrent / sequential ratio: **0.94** (two independent runs measured 1.00 and 1.04 — all three cluster
tightly around 1.0). Requesting concurrency bought effectively nothing: the gate serializes real DuckDB
work almost perfectly regardless of how many independent tasks ask for it at once, confirming the doc
comment's claim directly rather than by inspection.

**Follow-up, probed:**
connection-per-operation was probed and benchmarked directly against real `DuckSession` code. The naive
shape (each operation independently opens `:memory:` + `ATTACH`) is unsafe — a reproducible
catalog-staleness bug, not just a performance question. The safe shape (`DuckDBConnection.Duplicate()`
from one already-attached root, sharing one `duckdb_database` instance) is correct but measured the same
0.85–0.94 ratio as the gate — no real speedup, because DuckDB's own concurrency model (not the C#
`SemaphoreSlim`) is the actual limiter for this workload. The gate ships unchanged. Only the
per-*operation* shape was measured — a persistent per-node connection, reused across that node's
several operations, has a different overhead profile and is not ruled out by this number.

## Many small files

A file source over a large, ever-growing prefix (millions of tiny blobs) is expensive on every
incremental run independent of how few rows are new: the universal tier lists and opens one file
at a time, so wall-clock and per-file overhead scale with file count. Three levers address this —
prefer them in this order:

1. **Date-partitioned layout + native tier (the biggest lever).** A date-templated `path:` paired
   with a bounded incremental window prunes listing to the watermark window's minimal aligned
   prefix cover — a date-partitioned source touches only the window's folders, not history. See
   [Date-partitioned paths](/concepts/connectors/#date-partitioned-paths) and decision-log row 16
   (`docs/concepts/architecture-overview.md`). Prefer the native tier wherever it's available
   (parquet always; csv/json with a `columns:` contract): DuckDB receives the pruned cover as a
   list literal and scans in-engine, never building per-file .NET partition objects.
2. **Streaming partition enumeration (automatic, no config; a capability without a first-party
   implementor today).** A source that advertises `ConnectorCapabilities.StreamingPartitions`
   yields partitions lazily instead of materializing the full list, so the engine drains them
   under the existing bounded-channel concurrency gate with memory bounded to one listing page
   regardless of file count. `azureblob` was the only builtin connector to wire this up; its
   read side is now native-only, so lever 1 above applies to it instead whenever the layout is
   date-partitioned. The capability stays published on the ABI for a third-party connector's
   universal read path.
3. **`files_per_partition` coalescing (opt-in, universal-tier only; same capability gap).** On a
   connector with a universal partitioned read, set `files_per_partition: <int>` on the dataset
   to group that many consecutive matched files into one partition read sequentially — e.g.
   3,000,000 tiny files at `files_per_partition: 512` become ~6,000 partitions, cutting per-file
   scheduling/stream-open overhead roughly proportionally. Default is `1` (one partition per
   file). Meaningless on a native scan, which already hands DuckDB the whole file list in one
   call — setting it on a connector-level native-only source (`azureblob` is today's one
   first-party example) is a plan-time error (`PZ0312`) rather than a silent no-op. See
   [connectors.md](/concepts/connectors/#many-small-files-streaming-and-files_per_partition) for the
   option and its value validation (`PZ0222`).

**No silent caps.** v1 sets no hard file-count ceiling — streaming and coalescing keep an
unbounded file count memory-safe, so wall-clock over a very large set is the user's to manage via
prefix-pruning, partitioning, or the native tier. If a future version bounds coverage, that bound
must be logged, never silently truncated.

This section is guidance, not a measured baseline — no benchmark numbers are claimed for these
levers; the Memory budget formula above and the micro/macro benchmarks remain the numbers to
re-run on your own hardware and file counts.

## Re-running these baselines

```bash
dotnet build Pz.slnx -c Release
dotnet run -c Release --project tests/Pz.Benchmarks -- --filter '*'
scripts/macro-bench.sh 1000000
scripts/macro-bench-mssql.sh 1000000
scripts/macro-bench-postgres.sh 1000000
scripts/macro-bench-s3.sh 1000000
scripts/macro-bench-azureblob.sh 1000000
dotnet scripts/gate-serialization-probe.cs
```

`dotnet test Pz.slnx` remains unaffected by any of the above — it does not build or run
`tests/Pz.Benchmarks`, and the two `.cs` scripts under `scripts/` are not part of any test project.
