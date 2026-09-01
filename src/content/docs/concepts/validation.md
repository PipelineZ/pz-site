---
title: "Validation and errors"
description: "This article explains how PipelineZ validates a project before data moves, and the error philosophy that governs everything user-facing: typed errors,..."
---

This article explains how PipelineZ validates a project before data moves, and the error
philosophy that governs everything user-facing: typed errors, aggregate reporting, engine-owned
retries, and the v0.3 rules that keep resilience knobs independent of data-plane tiers.

## The five validation tiers

Validation is tiered, cheapest first. Every tier reports **all** the errors it finds — never
fail-one-at-a-time — each with file/line, an error code (like `PZ0412`), and a remediation
hint.

| Tier | Name | Checks |
|---|---|---|
| 1 | Shape | YAML parsed against published JSON Schemas (also shipped for editor autocomplete via SchemaStore-style association): `project.yml`, sources, sinks, sidecars. A sink output's removed `input:` field is rejected here (`PZ0112`) — load is inline in the pipeline SQL now; see [Project structure](/concepts/project-structure/#loading-insert-into-sink). Sidecar check definitions (`checks:`) are validated in this same pass — unknown check type, per-type option shapes, and unknown option keys are all `PZ0113`, reported together per file; see [Project structure](/concepts/project-structure/#pipelinessql-and-sidecar-configs) |
| 2 | Semantic | refs resolve; no cycles; no duplicate names; single version per connector; every `sink()` call targets a declared output, is the pipeline's leading statement, and is unique per output (else `PZ0201`/`PZ0208`); no two pipelines claim the same output (`PZ0206`); declared vars used/typed; env vars referenced are declared; SQL-declared incremental `watermark()` comparisons are inferred and cross-checked (`PZ0224`–`PZ0227`, see [Incremental declaration in SQL](#incremental-declaration-in-sql-pz0224pz0227)) |
| 3 | Connector-static | each `connection:`/dataset block validated against the **connector-provided JSON Schema** (from the manifest — works offline, works for connectors the CLI has never seen), plus the connector's `ValidateAsync` for cross-field rules |
| 4 | SQL dry-compile | the engine creates the staging schema *empty* from declared source contracts, then runs `EXPLAIN`/`PREPARE` on every rendered pipeline against DuckDB — typos, missing columns, and type errors surface **before any data moves** |
| 5 | Connectivity (`pz validate --connect`) | opt-in online checks: `CheckConnectionAsync` per connection, schema drift detection against contracts, sink permission probes |

Tiers 1–4 run implicitly at the start of every `run`; a project that compiles is very likely
to execute.

> [!NOTE]
> Datasets without declared columns get their schema fetched during `--connect` validation
> and cached in `.pz/target/schemas.json`.

## Error philosophy

**Errors are values with taxonomy**, not strings:

| Exception | Meaning |
|---|---|
| `PzConfigException` | project/config errors |
| `PzValidationException` | aggregated validation failures |
| `PzConnectorException` | connector failure; `IsTransient` + optional `RetryAfter` drive the engine retry policy |
| `ConnectorHostException` | connector loading/process-hosting failures |
| `RestoreException` | lock/NuGet resolution failures |

The governing rules:

- **Fail fast before data moves; be resilient after.** Config and validation problems abort
  everything pre-plan. Runtime node failures follow policy: the default is *fail the node,
  skip its descendants, continue independent branches* (dbt semantics); `--fail-fast` cancels
  the world.
- **Retries are engine policy fed by connector classification**: exponential backoff plus
  jitter on `IsTransient`, per-node attempt caps, `RetryAfter` respected, every retry a
  logged event. Connectors never retry internally — double-retry is how you get 45-minute
  hangs. The policy is configurable via a `retry:` block (`max_attempts`, `base_delay`,
  `max_delay`; durations like `2s`/`5m`) at the source/sink instance level and/or per
  dataset/output, cascading nearest-wins per field onto the engine default (3 attempts, 1s
  base, 30s cap). `pz plan` prints the effective policy for everything that declares one.
- **Sinks fail atomically where the destination allows**: temp-write + commit-swap means a
  failed run never leaves a half-replaced table. Where the destination can't (append to a
  queue), the docs and capability flags say so honestly, and `run_results.json` records
  exactly how many batches committed.
- **Every user-facing error names the file/node, the cause, and a next step.** Error-message
  quality is a review criterion, not an afterthought.

## Incremental declaration in SQL (PZ0224–PZ0227)

Declaring a source dataset incremental in pipeline SQL with `{{ watermark(...) }}` (see
[Incremental reads](/concepts/project-structure/#incremental-reads-watermark)) is inferred and
validated at compile time via DuckDB's own parser — and, like every tier, reports **all**
violations at once, each naming the pipeline or dataset, the cause, and a next step. The four
reserved codes:

| Code | Name | Fires when | Next step |
|---|---|---|---|
| `PZ0224` | Unrecognized watermark expression | A `watermark()` call is not a recognized lower-bound comparison: an upper bound (`<`/`<=`), `=`/`!=`, a function or expression on the cursor side, a column on the value side, a `watermark()` outside a comparison, an unqualified cursor when the query has multiple base tables, a cursor column that traces to a different dataset than the call names, or a `watermark()` for a dataset the pipeline never `source()`s | Rewrite as `<cursor column> > / >= <expression containing {{ watermark(source, dataset) }}>`, or add the missing `source()` call |
| `PZ0225` | Conflicting incremental declaration | A dataset is declared incremental in **both** YAML (`sync: { mode: incremental }`) and SQL (`watermark()`); or a `watermark()` targets a windowed dataset (windowed backfill is YAML-only); or two pipelines infer different cursor columns for the same dataset | Pick one route — YAML `sync: { mode: incremental }` **or** SQL `watermark()`; use YAML for windowed backfill; make every `watermark()` for a dataset use the same cursor column |
| `PZ0226` | Inconsistent incremental consumers | A dataset is SQL-declared incremental by at least one pipeline while another pipeline `source()`s it with no recognized `watermark()` filter — that consumer would silently read a delta | Add a `watermark()` comparison to the non-compliant pipeline's read, or move the declaration into the dataset's YAML `sync: { mode: incremental }` config |
| `PZ0227` | Watermark cursor undeclared | The inferred cursor column is absent from the dataset's `columns:` contract, or declared with a type outside the allowed set (`int`, `bigint`, `decimal`, `date`, `timestamp`) | Add or fix the `columns:` entry with an allowed cursor type |

All four are compile-phase, aggregate errors that abort before any data moves. They are gated
in order — `PZ0226` only fires for datasets that survived `PZ0225`/`PZ0227` — and they never
change what a YAML-declared or non-incremental project does.

## Non-blocking warnings

Not everything a compile notices is a reason to refuse the run. A structured
validation-*warning* channel — same `PZ####` discipline as errors (code, file/node, cause, next
step), but reported through `CompiledDag.Warnings` instead of thrown — covers work-in-progress
project states that are legitimate, not broken:

| Code | Name | Fires when | Next step |
|---|---|---|---|
| `PZ0223` | Dead-leaf pipeline | A non-ephemeral pipeline has no `INSERT INTO` **and** is consumed by no `ref()` — it computes a result nothing uses | Add an `INSERT INTO {{ sink(...) }}` or a `ref()` consumer, or leave it if this is temporary (e.g. inspecting intermediate data) |

Warnings are printed as `warning: PZ#### ...` lines by `pz validate`, `pz plan`, and `pz run`,
aggregated alongside (but kept distinct from) the error list — never fail-one-at-a-time, same
as errors. The distinguishing property: **warnings never change the exit code and never block a
run.** A project with only warnings still compiles, plans, and executes normally, exiting `0`.
This is deliberate — during development it's normal to leave an intermediate with no sink just
to inspect its data, and that should not force a broken build.

An **intermediate pipeline** — no `INSERT INTO`, but consumed by at least one `ref()` — is not a
warning at all; it's a completely ordinary, silent, valid pipeline.

## Circuit breaking

Circuit breaking is engine-owned and per-instance (v0.3). An optional `engine.breaker:` block
(`failure_threshold`, `cool_down`; `PZ0120` on malformed config) tracks CONSECUTIVE transient
failures per source/sink instance — the same `source:<name>`/`sink:<name>` granularity
`max_concurrency` uses, so every dataset/output sharing one instance shares one breaker.

- `failure_threshold` transient failures in a row trips Closed → Open. An attempts-exhausted
  retry counts the same as any other transient failure.
- Once `cool_down` elapses, exactly one Half-Open probe is admitted — success closes the
  breaker, failure reopens it for a fresh cool-down.
- Waiting for an Open breaker costs wall-clock time but never consumes the waiting node's own
  retry attempts. The executor gate bounds total open-wait to a small, fixed number of
  cool-down cycles before giving up with a retryable `PZ0506` — never fatal, so `pz retry`
  picks the node back up once the instance recovers.
- A connector-reported `RetryAfter` floors the cool-down, so the breaker never reopens sooner
  than the connector itself said to wait.
- Every transition publishes a `BreakerStateChangedEvent` — see [Run events](/events/).

## Tier adaptation: intent stays tier-independent

The resilience knobs (`retry:`, `engine.breaker`) and bounded windows are configured purely as
user *intent* — their docs never require you to know which [data-plane tier](/concepts/data-plane/) a
node lands on. That independence is enforced, not just phrased, by three
mechanisms:

### Native-only conflicts are refused at plan time

When a connector has no universal route for an edge — an `INativeOnlySink` (e.g. the
object-store sink) or an `INativeOnlySource` (e.g. the `azureblob` connector, whose reads are
all native-only) — configuration that requires the universal tier is refused with a `PZ0312`
(`NativePathRequired`) error at plan time rather than silently ignored: `engine.force_universal`
on either side, and `files_per_partition` (a source-side option only) on such a source. A
native-only *format* on an otherwise dual-tier connector (LocalFiles' parquet and json reads,
which share their connector with csv) can't carry the marker, so `engine.force_universal` there
surfaces as the same PZ0312 at run time instead, when that dataset's own extraction starts.

### Native-tier transients are classified from a closed list

`DuckTransientErrors.IsTransient` matches only enumerated, case-insensitive shapes — DuckDB
httpfs `500`/`502`/`503`/`504`/`408`/`429` immediately adjacent to an `HTTP` token, plus
`"connection refused"`, `"connection reset"`, `"connection error"`,
`"could not establish connection"`, `"timed out"`, and `"timeout"` — against the
pre-`LINE`-context summary of a native scan/copy/setup-statement failure, never the raw
message, which can embed a URL or filename that collides with the same substrings. Anything
unmatched stays `isTransient: false` by construction.

This feeds the same `retry:`/`engine.breaker` machinery the universal path's
connector-reported `PzConnectorException.IsTransient` already drives — so a flaky database
behaves identically under `retry:` and `engine.breaker` no matter which tier reached it.

### Windowed staging gets a universal-path backstop

A windowed dataset's native-path extraction is already bounded by the capable connector (the
`PZ0313` gate in [Connectors](/concepts/connectors/)). The universal path can't lean on connector
cooperation alone, so `SourceLoadExecutor` follows a successful `IngestArrowAsync` with one
`DELETE` trimming staging to `(lower, upper]` before watermark capture runs. That closes the
gap left by a bound-ignoring connector or a `force_universal` tier flip — without any
connector-side change. The window-scoped `MAX` and candidate-cap rules stay in
place as defense-in-depth for the watermark *value*; this backstop is what makes staging
*content* correct.

## Next steps

- [Inspect and validate a project](/how-to/inspect-and-validate/) — running the tiers.
- [Tune retries per database](/how-to/tune-retries/) and
  [Throttle a struggling source or sink](/how-to/throttle-a-source/) — the knobs, from
  the user's side.
- [Run events](/events/) — retry and breaker events on the wire.
