---
title: "Author a connector"
description: "This article shows you how to build, declare, and package a pz connector — a NuGet package with a source and/or sink implementation that pz loads at run..."
---

This article shows you how to build, declare, and package a `pz` connector — a NuGet package
with a source and/or sink implementation that `pz` loads at run time, including the pre-load
manifest handshake that lets the CLI reject an incompatible package before running any of its
code.

## Prerequisites

- Familiarity with the plugin architecture — hosting model, ALC isolation rules, ABI versioning
  policy: see [Connectors](/concepts/connectors/).
- A minimal working reference implementation lives at
  `tests/fixtures/connector-host/FakeSourceConnector`.

## Implement the ABI

1. Implement one or both of `ISourceConnector` / `ISinkConnector` from
   `Pz.Connectors.Abstractions`. The full interface listing (`IConnector`, `ISource`,
   `IDatasetPartition`, `ISink`, `ISinkWriteSession`) is in
   [Connectors](/concepts/connectors/#the-abi-surface).
2. Mark your entry point with the assembly attribute the host looks for:

   ```csharp
   [assembly: PzConnector("mysource", typeof(MySourceConnector))]
   ```

3. Run the acceptance suite in `Pz.Connectors.TestKit` against your implementation — it
   enforces the ABI contract, including the Arrow batch lifetime protocol.

> [!NOTE]
> **No universal path at all?** If your source (or sink) has no way to move data except the
> native scan/copy — a store fronted entirely by a DuckDB extension, say — implement the empty
> marker interface `INativeOnlySource` (or `INativeOnlySink` on the sink side) from
> `Pz.Connectors.Abstractions`. It tells the planner your connector has nothing to fall back to,
> so a dataset/output that conflicts with the native-only path (`engine.force_universal`,
> and — source-side only — `files_per_partition`) is refused at plan time (`PZ0312`) instead of
> planning "successfully" onto a `PlanReadAsync`/`BeginWriteAsync`
> that would only fail once the run actually reaches it. It's a **connector-level** marker: if
> only *some* formats on your connector are native-only (e.g. parquet native-only, csv
> dual-tier, on the same connector), don't implement it — keep the native-only format's
> `PlanReadAsync` throwing a named `PzConnectorException` in the `PZ0312` family instead, and
> that refusal stays run-time only for datasets using that format.

`ConnectorHost.LoadFromDirectory` resolves the connector into its own collectible
`AssemblyLoadContext`. Only a fixed shared-assembly list (`Pz.Connectors.Abstractions`,
`Apache.Arrow`, `System.*`, `Microsoft.Extensions.Logging.Abstractions`) unifies with the
host. Everything else your connector depends on — a driver library, a cloud SDK — stays
private to its own ALC, so two connectors can freely depend on different versions of the same
third-party library.

## Use the toolkit

`Pz.Connectors.Toolkit` is a NuGet package of shared connector mechanism — reach for it before
reimplementing any of the following from scratch:

| On the shelf | What it does |
|---|---|
| `TransientClassifier` (`Http`) | The canonical HTTP transient-status set (408/429/5xx) and `Retry-After` parsing, for feeding `PzConnectorException(isTransient, retryAfter)`. |
| Paging strategies (`Paging`) | `LinkHeaderStrategy` (RFC 8288 `Link` header), `PageParamsStrategy` (page-number query params), `CursorTokenStrategy` (opaque next-token in the response body) — all implement one small `IPageStrategy` interface. |
| Auth trio (`Auth`) | `Authenticators.TryCreate` builds an `IRequestAuthenticator` from an `auth:` config block for `api_key` (header or query param, with query-param redaction), `bearer`, and `basic`. |
| `BindingExpander` (`Bindings`) | Expands `{{ name }}` placeholders (e.g. `{{ watermark }}`) inside option strings against a typed binding map, with null-binding-means-omit semantics. |
| `ContractProjector` (`Formats`) | Projects a JSON record (or similar loosely-typed input) into a row against a declared `columns:` contract — extra keys ignored, missing/null → Arrow null, type mismatch fails loudly. Also builds the Arrow `Schema` from a `columns:` map. |
| `NdjsonWriteCodec` (`Formats`) | The go-forward NDJSON write surface (delegates to the frozen `Pz.Connectors.Abstractions.Formats.NdjsonCodec` so output stays byte-identical). |
| `JsonPointer` (`Json`) | RFC 6901 JSON pointer resolution, including the root pointer (`""`). |

Two things to keep in mind:

- **It's mechanism, never policy.** Everything on the shelf is a building block a connector
  composes however it likes — the toolkit has no opinion on your YAML shape, your retry
  behavior (the engine owns retry policy regardless), or which pieces you use. Nothing in it is
  required; the ABI works identically for a connector that never references the package.
- **It's an ordinary transitive dependency**, not on the ABI's shared-assembly list — it loads
  private to your connector's own `AssemblyLoadContext`, the same as any other third-party
  library you depend on.

`Pz.Connector.Http` (`connectors/Pz.Connector.Http`) is the toolkit's first and most complete
consumer — read it for a worked example of composing several of these pieces into one
connector. `Pz.Connectors.TestKit` also ships `StubHttpServer`, an in-proc scripted HTTP fixture
(exact-path routing, full request capture, no docker, no network) for testing any
HTTP-shaped connector against scripted responses.

## Handle setup statements

`ISource.TryGetNativeScan` / `ISink.TryGetNativeCopy` return a `NativeScan` / `NativeCopy`
record whose `SetupStatements` are SQL statements the engine runs on the run's DuckDB session
before the scan/copy statement itself. Use them for `CREATE SECRET`, extension
`INSTALL`/`LOAD`, and any other one-time-per-connector setup.

They are also the right vehicle for **extension-specific tuning knobs**. If the DuckDB
extension your connector wraps exposes a `SET <ext>_batch_size = ...`-style setting, that
setting is the *connector's* domain, not pz-core's. Expose it as a connector/dataset/output
option (`tuning: { batch_size: 4096 }` or similar, namespaced under your connector however you
like) and translate it into a `SET` statement in `SetupStatements`. Never propose an
extension-specific knob as engine/`project.yml` config: a pz-level knob like `retry:` or
`engine.breaker` expresses portable *intent* the engine enforces the same way regardless of
connector or tier; an extension tuning knob is *mechanism* specific to your extension, and
belongs inside your connector's own config surface.

> [!WARNING]
> `pz` runs exactly **one serialized DuckDB connection per run**, gated by a single semaphore —
> there is no per-node or per-connection isolation. `SET` is **session-scoped**, so a `SET` your
> `SetupStatements` emits for one node is still in effect for every later node
> in the same run that touches the same extension. If two outputs (or a source and a sink)
> want different values for the same setting, they silently share whichever one ran last —
> no error, just quietly wrong tuning on whichever node lost the race.

A connector that emits tuning `SET`s MUST do one of the following, and MUST say in its own
docs which one it does:

- **Set-and-reset.** Wrap your own statement: `SET <ext>_batch_size = <value>` before it and
  `RESET <ext>_batch_size` (or `SET` back to the extension's documented default) immediately
  after, so the setting never outlives the one statement it was meant for.
- **Verify and use a scoped form.** If the extension supports a per-statement or otherwise
  properly scoped setting — a pragma, a call-site parameter; check the extension's own docs —
  use that instead of a session-wide `SET`. DuckDB's own `SET` scope model is SESSION vs.
  GLOBAL, with no per-statement LOCAL scope, so it doesn't rescue you here: this is one shared
  session across the whole run.

This is not optional polish — a connector that emits a bare, unreset `SET` for a tuning value
is unsafe to run alongside any other node touching the same extension in the same `pz run`.

> [!IMPORTANT]
> The redaction rule for `SetupStatements` — never logged unredacted, since a setup statement
> may carry a credential (`CREATE SECRET ...`) — applies identically to tuning statements. A
> failed tuning `SET` surfaces through the same `PZ0311`/description-only path (first two
> tokens, uppercased, plus an ellipsis) as every other setup statement. Don't assume a tuning
> value is safe to log just because it looks like an innocuous number.

## Honor inclusive watermark bounds (`InclusiveWatermarkBound`)

Incremental extraction pushes a lower bound on the cursor column down to the source. A strict
bound (`cursor > <last watermark>`) is universal — every connector handles it, and its ABI is
unchanged. An **inclusive** bound (`cursor >= <value>`) is opt-in: a source receives one only if
it declares the `InclusiveWatermarkBound` capability and reads `DatasetSpec.WatermarkLowerInclusive`
when it builds its filter.

```csharp
public ConnectorCapabilities Capabilities =>
    ConnectorCapabilities.Merge | ConnectorCapabilities.InclusiveWatermarkBound;
```

> [!IMPORTANT]
> **The engine never under-extracts.** When an inclusive effective bound is computed for a
> connector that does *not* declare `InclusiveWatermarkBound`, the engine stamps **no bound at
> all** and emits a notice (`connector 'x' cannot honor an inclusive watermark bound; extracting
> unbounded — the pipeline filter applies the cut`). The connector over-extracts, and the
> pipeline's own `watermark()` predicate applies the exact cut downstream. Narrowing an inclusive
> request to a strict `>` bound would silently drop the boundary rows, so the engine refuses to
> hand a connector a bound it can't honor. Over-extraction is always safe — the pipeline filter
> is the backstop; under-extraction is a data-loss bug.

Inclusive bounds arise only from SQL-declared incrementality (`cursor >= {{ watermark(...) }}`,
including lookbacks — see [Incremental reads](/concepts/project-structure/#incremental-reads-watermark));
YAML-declared watermarks are always strict `>`. First-party `Pz.Connector.Postgres` and
`Pz.Connector.SqlServer` declare the capability and switch their generated `WHERE` between `>`
and `>=` accordingly.

## Support opaque sync-state datasets (`SyncState`)

Some APIs don't expose an ordered cursor column to filter on — instead they hand back an opaque
continuation token (a change-feed delta link, a resume cursor) that the caller stores verbatim
and replays on the next call. A dataset that works this way declares no `sync:` block at all (or
an explicit `mode: auto` — the two are equivalent) and leaves `mode: incremental`'s ordered-cursor
tracking out of the picture entirely; your connector tells the planner which one it actually got
by implementing `INaturalReadShapeSource.GetNaturalReadShape`, returning `NaturalReadShape.Feed`
for a dataset configured to use the token (e.g. a `delta_pointer`-style option is set) and `Full`
otherwise. The planner's resolved **feed** read shape is what the engine, the delivery-guarantee
matrix, and PZ0316 (below) key off — see [Delivery
guarantees](/concepts/delivery-guarantees/#declaring-how-data-is-read-and-written).

To support it, declare the `SyncState` capability and read/write the token through two ABI seams:

```csharp
public ConnectorCapabilities Capabilities =>
    ConnectorCapabilities.SyncState;
```

- **Reading the prior token**: the engine replays the stored token on `DatasetSpec.PriorSyncState`.
  It is `null` on the dataset's first run, or whenever the operator passes `--full-refresh` — both
  cases mean "start from the beginning," not "the token is the literal string null."
- **Handing back the next token**: implement `ISyncStatePartition` on your `IDatasetPartition`:

  ```csharp
  public interface ISyncStatePartition
  {
      bool TryGetSyncStateCandidate(out string? candidate);
  }
  ```

> [!IMPORTANT]
> **Lifetime rule.** The engine calls `TryGetSyncStateCandidate` **exactly once per run**, **after**
> `ReadAsync`'s enumeration has completed **cleanly** (no exception) — never mid-read, never on a
> failed or partial read. Returning `false` (or a `null` candidate) leaves the previously stored
> token **unchanged**; it does not clear it. This is the only channel a connector has to advance
> sync state — ordered-cursor watermarks never needed one, because the engine derives those from
> the rows that actually landed.

One structural rule the compiler/planner enforce so you don't have to: **single-partition only
(`PZ0316`)** — a dataset resolving to the `feed` read shape is refused at plan time if the same
connector also declares `PartitionedRead` or `StreamingPartitions` — one opaque token cannot
reconcile state across independent partitions. The old two-YAML-block "mutually exclusive with
ordered-cursor incremental" rule is gone: `sync:` is one block with one `mode` field
(`auto`/`incremental`/`cdc`), so declaring both an opaque token and an ordered cursor *in YAML
block form* isn't representable. One conflict the single block can't rule out survives, though:
declaring `sync: {mode: incremental}` (or a SQL `watermark()`) on a dataset whose connector manages
its own change feed for it — this `INaturalReadShapeSource` resolving `Feed` while a
`delta_pointer`-style connector option is set — pits the ordered cursor against the connector's
opaque token, both claiming to resume the read. That block-vs-connector-config conflict is refused
at plan time (`PZ0315`).

## Operation gate

The engine's unit of resilience is the node — a failed SourceLoad or SinkWrite retries in full.
For a connector whose unit of failure is finer-grained than that (one HTTP request out of a
500-page crawl; one blob copy-promote), declare `ConnectorCapabilities.GatedOperations` and
route every remote round-trip of your gated path through an engine-supplied `IOperationGate`, so
a transient failure on operation 499 retries operation 499, not the whole node — and so the
engine can pace your instance's requests against a `rate_limit:` budget (see
[Throttle a struggling source or sink](/how-to/throttle-a-source/#pace-requests-in-run-with-rate_limit)).

```csharp
public ConnectorCapabilities Capabilities =>
    ConnectorCapabilities.GatedOperations;
```

Implement `IOperationGateAware` on your `ISource` and/or `ISink` — whichever side has a gated
path:

```csharp
public interface IOperationGateAware
{
    void UseOperationGate(IOperationGate gate);
}
```

The engine calls `UseOperationGate` exactly once per opened `ISource`/`ISink`, after `OpenAsync`
returns and before any plan/read/write call. Store the gate and route **one gate call per remote
round-trip** — every network-shaped operation of your read/write path, never batch decoding,
local buffering, or stream plumbing:

```csharp
private IOperationGate? _gate;
public void UseOperationGate(IOperationGate gate) => _gate = gate;

// ...
var page = await _gate.ExecuteAsync("http.get_page", idempotent: true,
    innerCt => FetchPageCoreAsync(uri, innerCt), ct);
```

`opLabel` is a **static, connector-authored token** — `"http.get_page"`, `"azure.open_write"` —
never a URL, a parameter, or any value derived from config or payloads. The TestKit's
label-hygiene facts (below) enforce this mechanically.

### The idempotency promise

`ExecuteAsync`'s `idempotent` argument is a promise: repeating the operation observes no side
effects.

- **Source reads are idempotent by construction.** A dataset is a side-effect-free, repeatable
  extraction recipe (the ABI's own contract — see [Connectors](/concepts/connectors/)), so
  every source-side gated read may claim `idempotent: true`.
- **Sink-side, only discrete operations that are safe to repeat may claim it** — an
  overwrite-style open, a copy-promote over the same source, a delete-if-exists. A write that
  isn't safe to repeat (an append that isn't upsert-keyed, say) must not be gated as idempotent;
  most sink write paths simply don't expose a discrete op to gate at all (see streaming writes,
  next).

### Connectors never retry internally

This rule doesn't change: the gate **is** the sanctioned sub-node retry site, and it is engine
code. On a transient `PzConnectorException` with `idempotent: true` and attempts remaining, the
gate retries under the node's own resolved retry policy (same backoff, `Retry-After` handling,
and jitter as the node loop) — your connector code never loops, sleeps, or re-invokes itself.
Classify the exception (`IsTransient`, `RetryAfter`) exactly as you would for the node-level
path; the gate sees the same fully-classified `PzConnectorException` either way.

> [!IMPORTANT]
> **Streaming writes are not discrete operations.** A blob write stream held open across many
> batches, or any other operation spanning one open connection over multiple calls, must not be
> wrapped per-batch — it stays on the node-retry backstop. Gate only the discrete boundaries
> around it (open, commit, cleanup).

### Nested retry bounds

Two retry scopes now compose: the gate's op-level retry and the node's own backstop retry. Worst
case is `policy.MaxAttempts` op attempts × `policy.MaxAttempts` node attempts — bounded and
visible, never unbounded. Op exhaustion (the gate giving up and rethrowing the last transient
exception) always consumes exactly **one** node attempt, so a struggling instance can't silently
multiply its retry budget beyond that product. The circuit breaker only ever sees the node's
final, surfaced outcome — op-level failures inside the gate never record against it.

### TestKit expectations

`Pz.Connectors.TestKit` runs acceptance facts against any connector declaring
`GatedOperations` — skipped automatically (via `Skip.If`) for connectors that don't declare it,
so every existing subclass stays green with zero behavior change.

`SourceConnectorAcceptanceTests` (three facts, source side):

| Fact | Enforces |
|---|---|
| `Gated_connector_routes_reads_through_gate` | A declared-gated source actually calls the gate at least once — a connector that declares the flag but never routes an operation through it fails acceptance. |
| `Gated_connector_does_not_retry_outside_gate` | Injecting one transient failure through the gate surfaces it unchanged, after exactly one gate call — proving the connector performs no retry of its own outside the gate. |
| `Gated_op_labels_are_static_tokens` | Every observed `opLabel` is a static token — no `://`, no `?`, no whitespace — a mechanical guard for the no-secrets label rule above. |

`SinkConnectorAcceptanceTests` (two facts, sink side — same routing and label-hygiene checks,
naming the write path):

| Fact | Enforces |
|---|---|
| `Gated_connector_routes_writes_through_gate` | A declared-gated sink actually calls the gate at least once. |
| `Gated_sink_op_labels_are_static_tokens` | Same static-token check as the source-side fact, over write-path labels. |

> [!NOTE]
> There's no sink-side failure-injection twin: injecting a failure into an unknown first write
> op would leave commit-xor-abort undefined across arbitrary connectors, so the
> no-untracked-retry property is proven source-side only. `Pz.Connector.Http`'s `HttpGateTests`
> and the Azure docker-gated `AzureGateTests` cover the same properties end-to-end for the two
> first-party gated connectors, on top of the shared TestKit facts.

## Partition identity and checkpoints

Declare `StablePartitionIds` when every partition your source plans can carry a stable identity,
and implement `IIdentifiedPartition` on each planned partition:

- `PartitionId` is engine-opaque, non-empty, and unique within one plan.
- Stability is the contract: planning the same dataset again — a later attempt in the same run,
  or a later `pz retry` — must yield the same id for the same logical slice. A file path or a
  range key is a good id; a timestamp or random value is not.
- The reward is partition-scoped retry: on any retry, partitions that already landed are skipped
  (their rows persist in staging), so a transient failure re-reads only what failed.
- Ids never appear in events, errors, or logs — the engine reports counts only, and you must too.

Declare `CheckpointableReads` (always together with `StablePartitionIds` — the planner refuses
the combination otherwise, PZ0319) when a partition can resume mid-read from an opaque token,
and implement `ICheckpointingPartition`:

- `TryGetCheckpoint` is called by the engine only after every row you have yielded so far is
  durably staged. Return a token covering exactly those rows (for a paged API: the continuation
  link, once the page's rows have been fully yielded). Return each new token once.
- Align your batches to your tokens: flush your batch builder at each position a token covers
  (the first-party http connector flushes at every page boundary), rather than letting a
  byte-sized batch span several positions. A token may only be offered when the yielded row
  count lands exactly on its coverage — with misaligned batches that rarely happens, and a
  connector that dutifully computes tokens still never gets to offer one.
- `TryResumeFrom` is called before `ReadAsync` on a retry. Returning true commits you to yielding
  only rows strictly after the token's coverage; return false (never throw) when the token is no
  longer usable — the engine restarts the partition from scratch.
- Tokens are persisted only inside the run's staging database, never logged. Do not log them
  yourself either — a continuation link can embed server-side state or query-string secrets.
- The TestKit enforces the contract: override `CheckpointDataset` (and `CheckpointKeyColumn` if
  your row identity is not the first column) in your `SourceConnectorAcceptanceTests` subclass.

## Sink modes, abort semantics, and delivery checkpoints

Three sink-side capability axes let the planner refuse a write mode
your connector doesn't actually support, and let the engine report failures honestly instead of
implying cleanup that didn't happen.

**Declare only what's true.** Modes and behaviors are capability-gated; the planner refuses a
mode at compile/plan time (`PZ0228`/`PZ0324`) rather than letting a connector fail — or silently
degrade — at run time:

```csharp
public ConnectorCapabilities Capabilities =>
    ConnectorCapabilities.Merge |            // BeginWriteAsync accepts mode: merge
    ConnectorCapabilities.ReplaceWrites |    // BeginWriteAsync accepts mode: replace
    ConnectorCapabilities.Transactional |    // commit is atomic (temp-swap or equivalent)
    ConnectorCapabilities.CheckpointableWrites | // write sessions implement ICheckpointingSinkSession
    ConnectorCapabilities.ColumnPartitionedWrites; // the DESTINATION records its own partitioning
```

`ColumnPartitionedWrites` is what a table format declares — Delta, Iceberg, Hive-layout parquet —
when `partition_by:` names the columns and the store, not pz, lays the partitions out. It is the
counterpart to `PathTemplating`, which says the connector renders pz's calendar tokens into a path
instead. `path:` decides which of the two an output needs, and the planner refuses a connector
missing the one it needs with `PZ0314`; see
[Write partitioning](/concepts/connectors/#date-partitioned-paths).

`append` needs no capability flag — every sink supports it. Declaring `Merge`/`ReplaceWrites`
without actually handling `spec.Mode == "merge"`/`"replace"` in `BeginWriteAsync` is a connector
defect the TestKit's mode-honesty fact (below) exists to catch.

**Declare `AbortSemantics` honestly.** The default (no override) is `DiscardsAll` — the historical
implicit contract every owned-destination sink has always had. Override it when that's not true
for your destination:

```csharp
public AbortSemantics AbortSemantics => AbortSemantics.None;
```

Use this decision guide:

- **You own the destination and commit via a temp-write + atomic swap** (a temp file promoted
  over the final path, a staging table swapped into place) ⇒ `DiscardsAll` — abort discards the
  temp artifact and nothing else is ever visible.
- **Cleanup is a best-effort delete that can itself fail independently of the write** (e.g.
  deleting rows already flushed to a destination that doesn't support atomic rollback) ⇒
  `BestEffort` — some written data may remain visible after abort.
- **Your destination has side effects with no undo** (an HTTP POST, a message queue publish, any
  API call the destination has already acted on) ⇒ `None` — abort cleans up nothing, and the
  engine's failure report says so (`delivery stopped: up to N row(s) already visible...`) instead
  of implying the write unwound.

See [Delivery guarantees: Abort semantics](/concepts/delivery-guarantees/#abort-semantics) for
the full vocabulary and the presence rule for the `delivery` field.

**Implement `ICheckpointingSinkSession` for `CheckpointableWrites`.** The engine drains your
input in a content-deterministic order and, after every batch, asks how many rows you've durably
confirmed — never buffered, never merely sent, only rows the destination has actually
acknowledged:

```csharp
public interface ICheckpointingSinkSession : ISinkWriteSession
{
    bool TryResumeFrom(long acknowledgedRows);
    bool TryGetAcknowledgedRows(out long acknowledgedRows);
}
```

- **Acknowledge only what the destination confirmed.** `TryGetAcknowledgedRows` must count rows
  in engine drain order, starting from row zero of that order — never rows you've merely sent
  over the wire. Over-reporting risks the engine trusting a prefix that was never truly durable.
- **A resumed prefix folds into your own commit totals.** When `TryResumeFrom` accepts an
  acknowledged count, the engine delivers only the rows strictly after it — your session's
  `WriteResult.RowsWritten` at commit must still count the full logical output, resumed prefix
  included, since the engine never re-derives that number itself.
- **Returning `false` from `TryResumeFrom` is always safe.** The engine falls back to a full
  re-drain from row zero — declining a resume is never a correctness bug, only a missed
  optimization. Never throw from either method.

**TestKit hooks to wire.** `SinkConnectorAcceptanceTests` (in `Pz.Connectors.TestKit`) exercises
these capabilities through virtual, defaulted-to-null hooks, so existing subclasses compile and
stay green unchanged:

| Hook | Wire it when | What it drives |
|---|---|---|
| `MergeOutput` | Your connector declares `Merge`. | A mode-honesty fact commits a session in `mode: merge` against your fixture dataset. |
| `ReplaceOutput` | Your connector declares `ReplaceWrites`. | The same mode-honesty fact, for `mode: replace`. |
| `CheckpointOutput` | Your connector declares `CheckpointableWrites`. | Delivers some batches, captures `TryGetAcknowledgedRows`, opens a new session, calls `TryResumeFrom`, and verifies the second session delivers exactly the post-prefix suffix with no gap and no re-delivery. |

An abort-honesty fact runs unconditionally after delivering at least one batch: `AbortAsync` must
never throw; for a `DiscardsAll` connector the fixture also verifies nothing committed remains
visible.

## Declare the connector in a project

A project references your package the same way it references a builtin, via `project.yml`'s
`connectors:` list. Feeds are host configuration, not project authoring: `pz restore --feeds
<url-or-path>` (repeatable) wins, else the `PZ_FEEDS` environment variable (a `;`-separated
list), else nuget.org. Declaring `feeds:` in project.yml fails the load with PZ0352:

```yaml
connectors:
  - package: MyCompany.Pz.Connector.MySource
    version: 1.0.0
```

`pz restore` resolves non-builtin packages against the host feeds, materializes them under
`.pz/packages`, and writes `pz.lock.json`; `pz run` and `pz validate` load from the lock file
thereafter.

> [!NOTE]
> Builtin packages — `Pz.Connector.LocalFiles`, `Pz.Connector.Postgres`,
> `Pz.Connector.S3`, `Pz.Connector.SqlServer`, `Pz.Connector.AzureBlob`, `Pz.Connector.MySql`,
> `Pz.Connector.Http`, `Pz.Connector.Sqlite` — skip restore entirely, since they ship inside
> the `pz` tool itself. For the same reason they are not published to nuget.org: nothing could
> install and use one, because the host that loads a connector ships inside `pz` too. Read them
> as reference implementations in `connectors/` in the repository rather than as packages. Your
> own connector is a normal published package and takes the restore path above.

## Ship the manifest

A connector package may ship a `pz.connector.json` file at the root of its package. Schema
(v1):

```json
{ "name": "fakesource", "protocolMajorMin": 1, "protocolMajorMax": 1, "capabilities": ["source"] }
```

- `name` and `capabilities` are informational only in v1 (not yet consulted by the host).
- `protocolMajorMin` / `protocolMajorMax` declare the inclusive range of
  `Pz.Connectors.Abstractions` protocol majors (`ProtocolVersion.Major`) the connector
  supports.
- `projectDirectoryAnchor` (optional, default `false`) asks pz to resolve this connector's
  relative paths against the **project directory**:

  ```json
  { "name": "deltalake", "protocolMajorMin": 1, "protocolMajorMax": 1,
    "capabilities": ["source", "sink"], "projectDirectoryAnchor": true }
  ```

  Without it, a connector receives relative paths with no anchor and its only correct options are
  to refuse them or to demand absolute ones. It is **opt-in** rather than universal because every
  connection's config is validated against that connector's `ConnectionConfigSchema` with
  `additionalProperties: false` — injecting the option into a connector that does not expect it
  would fail its own validation. The manifest is read straight off disk, before any ALC exists,
  because the anchor has to be applied before the connector registry is built.

> [!NOTE]
> The manifest exists so `ConnectorHost.LoadFromDirectory` can read a small, untrusted JSON
> file and reject an incompatible package **before creating an ALC or loading any assembly at
> all** — previously, incompatibility was only detected after arbitrary package code had run.
> The full rationale is in [Connectors](/concepts/connectors/).

What the host does with it:

| Manifest state | Behavior |
|---|---|
| Present, compatible (host's `ProtocolVersion.Major` inside `[protocolMajorMin, protocolMajorMax]`) | Load proceeds normally |
| Present, incompatible | `ConnectorHostException` `PZ0306` before the package's assembly is loaded, naming the connector's supported range and the host's major, with the hint "upgrade pz, or pin an older connector version" |
| Present but malformed (invalid JSON, or `protocolMajorMin > protocolMajorMax`) | Also `PZ0306` — a present-but-broken manifest signals a broken package, so this fails loud rather than silently falling back to the no-manifest path |
| Absent | `LoadFromDirectory`'s optional `warn` callback notes the missing handshake and the load proceeds as before; the post-load check against the instantiated connector's `ConnectorInfo.ProtocolMajor` remains the second line of defense |

Pack the manifest at the root of the nupkg, copying it to the output directory so
package-in-place and test fixtures also see it:

```xml
<ItemGroup>
  <None Include="pz.connector.json" Pack="true" PackagePath="" CopyToOutputDirectory="PreserveNewest" />
</ItemGroup>
```

`tests/fixtures/connector-host/FakeSourceConnector` (see its `.csproj` and
`pz.connector.json`) is the reference packaging example used by the restore/host test suites.

## Two host facts you cannot discover from the ABI

Both are deliberate engine behaviour with good reasons, and neither is visible from the interfaces
you implement. A connector that does not know them ships a real defect that a green `pz run` will
not catch.

### `PzConnectorException.Message` is published verbatim

The message you throw is written **unaltered** into `run_results.json`, onto the NDJSON event
stream, and into a `retry_scheduled` reason. There is no redaction layer between your connector and
those artifacts.

The trust is deliberate — a storage failure naming neither bucket nor path is undiagnosable — and it
is **total**. A connector wrapping a third-party client owns redacting that client's message, which
means owning the shapes it answers in. A `name=value` scrub is not enough: object stores answer in
XML, and an S3 `SignatureDoesNotMatch` body carries the access key id in an `<AWSAccessKeyId>`
element and a signing preimage in `<StringToSign>` — neither of which is a `name=value` pair.

`ErrorRedactionContractTests` in the TestKit is the acceptance suite for exactly this. Subclass it,
point `RedactErrorText` at your redactor, and it feeds you an S3 XML 403, an Azure
`AuthorizationFailure`, a connection string and a `name=value` pair, requiring the credential gone
and the diagnosis intact.

Note also what survives redaction and *should*: bucket or container, object path, endpoint host and
port. Run artifacts therefore name where the data lives, which is worth knowing before shipping them
to a log aggregator or a support thread.

### The write schema is all-nullable, and narrower than you think

The `Schema` handed to `BeginWriteAsync` arrives with **every field `IsNullable = true`**, whatever
the source declared — pz does not propagate source nullability onto the write side. So a sink's
per-column non-nullable guards are unreachable through pz, and a green `pz run` is not coverage of
them. Test them directly.

The v0 type matrix is also narrower than Arrow's: `Float` (32-bit) is not in it, so a `float`
branch in your writer is likewise never exercised by a pz-driven run.

### `OutputSpec.Attempt`: which attempt at which write

An `OutputSpec` reaching the universal write path carries `Attempt` — `Node`, `Run`, `Ordinal`. If
your destination can record a durable progress marker transactionally with the data (a Delta commit
property, an application id, a ledger row), stamp it on commit and read it back at the start of the
next attempt to skip work already committed. That makes a **within-run** retry effectively-once.

It is `null` on the native-copy path, where there is no write session to carry a marker, and it does
**not** span runs. See
[Write attempt identity](/concepts/delivery-guarantees/#write-attempt-identity).

## Publish so people can find it

A connector is an ordinary NuGet package; two conventions make it discoverable:

- **Tag it `pipelinez-connector`** in `<PackageTags>`. This is the ecosystem's ratified
  discovery tag — searching that tag on nuget.org enumerates every published connector, and
  future `pz connector search` tooling will query it.
- **Name it under your own prefix** (`MyCompany.Pz.Connector.MySource` is idiomatic). The
  bare `Pz.*` prefix is reserved for first-party packages — nuget.org will reject unsigned
  `Pz.`-prefixed IDs from other accounts once prefix reservation is in place.

## Next steps

- [Connectors](/concepts/connectors/) — hosting model, ALC rules, ABI versioning,
  watermarks.
- [The data plane](/concepts/data-plane/) — the batch ownership rules your connector must
  respect.
