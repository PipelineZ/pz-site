---
title: "Delivery guarantees"
description: "This article states, as a stability contract, what guarantee each (read shape, write strategy) pair actually provides when data is replayed — by a crash, a..."
---

This article states, as a stability contract, what guarantee each (read shape, write strategy)
pair actually provides when data is replayed — by a crash, a `pz retry`, or a re-run — and how
`pz retry` avoids manufacturing the duplicates that guarantee allows. If you're deciding between
`merge`, `replace`, and `append` for an incremental or feed-shaped dataset, or you've hit
`PZ0214`/`PZ0335`, start here.

## Declaring how data is read and written

A pipeline developer declares two intents, in one vocabulary each — see [Project
structure](/concepts/project-structure/) for the full YAML shapes and [Connectors](/concepts/connectors/) for how
connectors implement them:

- **How data is read** — a dataset's `sync:` block. `mode: incremental` is engine-owned,
  ordered-cursor tracking (`cursor`, plus the optional `max_window`/`initial`/`until` window
  keys). `mode: cdc` is database-log change capture (Postgres pgoutput / SQL Server native cdc
  tables) — see [Capture changes with CDC](/how-to/capture-changes-with-cdc/). `mode: auto`
  is the default — the whole block may be omitted — and means *the connector's natural read*: a
  stateless dataset re-reads fully, and a connector-managed change feed (an HTTP delta-link
  dataset, say) resumes its opaque token.
- **How data is written** — an output's `write:` block: `strategy: replace|append|merge`, `keys:`
  (required for `merge`), `duplicates: accept` (the append consent below), and `on_delete:
  delete|soft|ignore` (cdc-fed merge outputs only — how a deleted source row is applied at the
  destination; see the how-to above).

At plan time every dataset resolves to exactly one **read shape** — `full`, `feed`, `incremental`,
or `cdc` — printed per `SourceLoad` in `pz plan` Reason strings (`read=incremental
cursor=<column>`, `read=feed`, `read=full`, `read=cdc`; never connection/secret content). Declared
modes resolve to themselves; `auto` resolves to `full` or `feed` by asking the connector for its
natural read shape (a connector that doesn't answer defaults to `full`) — so `auto` never hides
what will actually happen. The compiler and planner validate every (read shape, write strategy)
pair against the matrix below.

## The pairing matrix

| read shape ↓ / write → | `replace` | `append` | `merge` |
|---|---|---|---|
| `full` | ✓ effectively-once | ✓ at-least-once | ✓ effectively-once |
| `feed` | ✗ refused (`PZ0335`, until a snapshot-declaring feed capability exists) | consent required — `write: { duplicates: accept }` (at-least-once) | ✓ effectively-once |
| `incremental` | ✗ refused (`PZ0335`) | consent required — `write: { duplicates: accept }` (at-least-once) | ✓ effectively-once |
| `cdc` | ✗ refused (`PZ0335`) | ✗ refused (`PZ0335`) | ✓ effectively-once (`on_delete: delete`\|`soft`); ✓ effectively-once upserts, deletes not propagated (`on_delete: ignore`) |

This table is a **stability contract**: the guarantee a cell provides today is the guarantee it
will keep providing, and every ✗ or unmet-consent cell is a `PZ`-coded, aggregate-reported compile
error naming the dataset, the output, and the fix. `merge` is safe to replay by construction —
a keyed upsert makes "the same slice landed twice" indistinguishable from "it landed once" — and
so is `replace` when it's legal: a full overwrite means last write wins. `append` has no such
protection, whichever read shape feeds it.

- **`incremental` × `replace` is a new refusal** (`PZ0335`, previously silently legal): each run
  would replace the target with only the newest slice, discarding everything an ordered-cursor
  read relies on staying put across runs. The matrix makes this bug unrepresentable.
- **`feed` × `replace` is refused at plan time** (`PZ0335`): a connector-managed feed's read is
  not guaranteed to be a complete snapshot — replace would discard previously delivered rows. The
  refusal is unconditional this cycle; a future snapshot-declaring feed capability (a
  `ConnectorCapabilities` flag by which a full-snapshot feed says "every read is complete") would
  let such a feed legally replace. `ExecutionPlanner` raises it, because only the planner holds the
  opened connector and the dataset's resolved read shape.
- **`cdc` × `replace`/`append` is refused** (`PZ0335`, `DagCompiler`): a change-capture read is a
  stream of individual row events, not a re-readable full snapshot — `replace` would discard every
  row not touched by the current window, and `append` would materialize raw change events (inserts
  *and* updates *and* deletes) as if they were all new rows. `merge` is the only legal write
  strategy for a `cdc`-synced dataset, and it must declare `on_delete` — see
  [Capture changes with CDC](/how-to/capture-changes-with-cdc/#the-yaml-surface).
  `on_delete: delete`/`soft` route the source table's deletes to the destination (effectively-once:
  the merge is a keyed upsert, and a deleted key is either physically removed or timestamp-marked,
  either way idempotent under replay). `on_delete: ignore` is upsert-only — a source-side delete
  never reaches the destination, so the destination accumulates rows the source no longer has; it's
  still effectively-once for the rows it does write, but it is not a correctness-preserving mirror
  of the source table.
- **The `consent` cells are `PZ0214`** (below): at-least-once replay into `append` requires
  `write: { duplicates: accept }`, whether the at-least-once read behind it is an explicitly
  declared `sync: { mode: incremental }` dataset or an implicit `mode: auto` dataset that resolves
  to `feed`.

Below, the duplicate windows that make `append` at-least-once — real, reachable situations, not a
hypothetical edge case:

- **`pz run` after a partial failure, instead of `pz retry`.** An operator who re-runs the whole
  project (rather than resuming with `pz retry`) re-extracts and redelivers to every sink,
  including ones that already committed.
- **A failed watermark persist.** Watermark advancement is commit-gated (see
  [Connectors](/concepts/connectors/#incremental-extraction-and-watermarks)) — if the store write itself
  never lands, the next run re-extracts the same slice.
- **A partial `--select` that omits a sink.** Selecting a subset of the DAG can re-run a
  SourceLoad without re-running every sink that depends on it, or vice versa, depending on what's
  in scope.
- **A reuse-fallback retry.** When `pz retry`'s staging reuse (below) falls back to re-extraction
  for a SourceLoad, its downstream `append` sinks receive a freshly-extracted slice that may not
  be byte-identical to the one already committed.

None of this makes `append` wrong — an append-only destination (an event log, a queue) may have
no other option, and a source with reliable pushdown filtering makes duplicates rare in practice.
It means `append` is at-least-once, and PipelineZ makes you say so.

## Abort semantics

`AbortAsync` means different things for different destinations. A sink declares which one is true
for it (`ISink.AbortSemantics`), and the engine surfaces that declaration on failure instead of
leaving an operator to assume the historical "everything unwound" behavior:

| Value | What it means |
|---|---|
| `discards_all` | Abort removes every trace of the session's writes (temp-write + discard-on-failure). This is the historical implicit contract every owned-destination sink has always had — every first-party sink that writes to a destination it owns (LocalFiles, S3, AzureBlob, Postgres, SqlServer) is `DiscardsAll`. |
| `best_effort` | Abort attempts cleanup but cannot guarantee it (independent deletes can fail); some written data may remain visible downstream. |
| `none` | Abort cleans up nothing — every delivered row is already visible downstream. `Pz.Connector.Http` is `None`: you cannot un-POST a request that already returned 2xx. |

**The presence rule.** A failed `SinkWrite` whose connector is *not* `DiscardsAll` reports a
`delivery` block instead of the plain failure message that used to imply cleanup happened:

```
delivery stopped: up to 340 row(s) already visible at the destination (abort: none)
```

A `DiscardsAll` failure needs no such note — nothing survived the abort, so the plain node-failure
message already tells the whole story. See [Run events](/events/#node_completed) for the
`delivery` field's full shape in `run_results.json`/NDJSON.

**`RowsVisible` is attempt-scoped.** It counts only what this one attempt exposed at the
destination, not the destination's cumulative state across every attempt so far: after a
scratched or declined resume on a non-`DiscardsAll` sink (the fingerprint mismatch and
decline-resume paths in [Delivery checkpoints](#delivery-checkpoints) below), a later attempt
redelivers from row zero, so the rows an *earlier* attempt already left visible at the
destination are not reflected in the number this attempt reports — cumulative destination
exposure across attempts can exceed it.

Abort semantics are an orthogonal axis to the pairing matrix above, not a replacement for it:
`merge`/`replace`/`append`'s guarantees are per-strategy and unchanged by what a failed attempt's
abort does or doesn't clean up.

## Partitioned output: per-partition atomic

An output combining a date-templated `path` with `partition_by` (see
[Write partitioning](/concepts/connectors/#date-partitioned-paths)) fans rows out into one blob per
partition folder instead of the single temp-blob promote a plain output uses. This section is about
that shape only — the one **pz** lays out. An output that declares `partition_by` with no calendar
tokens in `path` is partitioned by its *destination* (`ColumnPartitionedWrites`), and what a commit
there is atomic over is that store's business, not pz's: for a table format like Delta or Iceberg it
is normally the whole commit, which is a stronger guarantee than anything below. Each partition
folder promotes atomically and independently, so the write as a whole is **not** all-or-nothing
across the partition set: a run that fails partway through a partitioned write can leave a
*subset* of partitions committed and others not yet written; a re-run or `pz retry` reconciles
the rest. This composes with the matrix above rather than replacing it — each partition still
gets its folder's own write-strategy guarantee (`replace` overwrites that folder atomically,
`append` is at-least-once for it) — so the write is at-least-once **at the partition-set level**,
the same "a slice may be revisited" shape as the `append` column above, one level up.

Staging every partition's temp blob and promoting the whole set together was considered and
rejected: "promote N blobs" is not itself atomic on an object store, so an all-or-nothing scheme
would still leave a partial set observable to a crash mid-promote, and would need its own
manifest/marker to make that set self-describing — more machinery for a guarantee it can't
actually deliver. Per-partition atomic is simpler and matches how other object-store partitioned
writers (Spark/Hive-style) behave in practice.

## PZ0214: incremental/feed → append requires consent

Compilation and planning refuse an `incremental`- or `feed`-shaped dataset feeding a
`write.strategy: append` output, unless the output opts in — the matrix's two `consent` cells.
The check is split by which phase can see which case: an explicitly declared
`sync: { mode: incremental }` dataset is caught at compile time (`DagCompiler`, over the **full**
compiled DAG, never a `--select`-filtered subset, because the risk is a property of the project,
not of one run); an implicit `mode: auto` dataset that a connector resolves to `feed` can only be
known once the planner has the connector's answer, so that case is caught at plan time
(`ExecutionPlanner`). Both report the same error, aggregated (never fail-one-at-a-time), naming
both ends and the file:

```
error PZ0214: sink 'lake.events_raw' has write.strategy: append and is fed by incremental dataset
'crm.events' -- delivery is at-least-once, so a retried or replayed slice can duplicate
rows
hint: use write.strategy: merge (with keys:) or write.strategy: replace, or set
write:
  strategy: append
  duplicates: accept
on the output to accept at-least-once delivery
```

Fix it by switching to `merge`/`replace`, or by declaring the reserved sub-key that records the
decision was made on purpose:

```sql
-- pipelines/stg_events.sql
INSERT INTO {{ sink('lake', 'events_raw', strategy: 'append', duplicates: 'accept') }}
```

The consent sits on the load statement itself, so the pipeline and the guarantee it accepts are
read together.

`duplicates` only accepts the literal `'accept'`; anything else is a shape error at compile time
(a typo here should be loud, not silently ignored). Non-incremental, non-feed (`full`-shaped)
datasets are unaffected: a full re-extraction into `append` is a deliberate, visible-in-YAML
pattern with different semantics, not the case this rule targets.

> [!NOTE]
> Compilation separately emits a non-fatal advisory notice for an explicit `sync: { mode: auto }`
> dataset reaching a non-`merge` sink without consent — including a `replace` sink. It cannot fire
> for an `incremental` dataset: `PZ0335` refuses `replace` and `PZ0214` refuses unconsented
> `append` first, so an incremental read never reaches a non-`merge` sink. The notice predates this
> page's doctrine and speaks only in terms of "non-merge", so it flags a `replace`-fed `auto`
> dataset even though `replace` is effectively-once per the matrix above; treat it as a coarse
> legacy nag, not a correctness signal. `write: { duplicates: accept }` silences it the same way
> it silences `PZ0214` — consent given once shouldn't be nagged about twice.

## PZ0335: incremental × replace is refused

Compilation refuses an explicitly declared `sync: { mode: incremental }` dataset feeding a
`write.strategy: replace` output outright — there is no consent escape hatch, because there's no
sense in which the pairing is ever intentional: each run would replace the target with only the
newest slice, discarding the whole point of tracking a cursor across runs.

```
error PZ0335: output 'lake.orders_curated': write.strategy 'replace' fed by incremental dataset
'crm.orders' would discard previously loaded rows each run.
hint: use write.strategy: merge (effectively-once), or remove the dataset's sync block for a full
re-read
```

Like `PZ0214`, this runs over the full compiled DAG. It's narrower than the matrix's full
`incremental` × `replace` cell on paper — Pz.Core has no connector-capability access at compile
time, so an implicit `mode: auto` dataset that might resolve to `feed` is left to the planner,
which holds the opened connector and the resolved shape and refuses `feed` × `replace` with this
same code (see the matrix bullet above).

## Sync state: another commit-gated state kind

Watermarks aren't the only state a source can carry across runs. A **feed-shaped** dataset — no
`sync:` block, or an explicit `mode: auto`, resolved by the connector to `feed` (see
[Connectors](/concepts/connectors/#http-connector)) — carries an **opaque token** instead of an orderable
cursor — a connector-issued "call this next time" pointer (a delta link, a change-feed cursor)
that the engine stores and replays verbatim without ever inspecting or comparing it. Sync state
shares the watermark model's core discipline and its limits:

- **Commit-gated advancement.** The token only advances to `.pz/state/sync-state.json` after every
  downstream sink for that dataset has committed — the same rule `WatermarkAdvancement` applies to
  watermarks; `SyncStateAdvancement` and `WatermarkAdvancement` are thin wrappers over the one
  shared commit-gated walk (`CommitGatedAdvancement`), so the two state kinds can never drift
  apart on this rule.
- **At-least-once on replay.** A retried or replayed run resumes from the last committed token,
  which can re-deliver rows the token's server already returned once. It carries the exact same
  `PZ0214` consent requirement as an incremental dataset: pair a feed-shaped dataset with `merge`
  (effectively-once) or declare `write: { duplicates: accept }` on an `append` output.
- **Expiry is a distinct failure shape watermarks don't have.** An orderable cursor never goes
  stale on its own; an opaque token can be expired server-side (e.g. HTTP 410 on a delta link).
  That's a permanent error naming `--full-refresh` — which, for a feed-shaped dataset, means
  discarding the stored token and restarting the feed from its beginning, the sync-state
  equivalent of discarding a watermark.
- **Single-partition, opaque to the engine.** Because the engine never parses the token, it can't
  merge or reconcile it across partitions the way it can compare cursor values — a feed-shaped
  dataset is always single-partition (`PZ0316`). There's no separate mutual-exclusion rule to
  state here: `sync:` is one block with one `mode`, so a dataset can never resolve to both
  `incremental` and `feed` at once.

## SQL-declared incremental datasets and `>=` re-reads

A dataset declared incremental in pipeline SQL with `{{ watermark(...) }}` (see
[Incremental reads](/concepts/project-structure/#incremental-reads-watermark)) carries the **exact same**
delivery semantics as a YAML-declared one — the `watermark()` form moves the *declaration* into
the SQL, not the machinery. The `PZ0214` gate above applies identically: an SQL-declared
incremental dataset feeding a `write.strategy: append` output is a compile error unless the output
sets `write: { duplicates: accept }`, because the consent check keys off the dataset being
incremental, regardless of where that was declared.

One wrinkle is worth calling out. An **inclusive** lower bound — `cursor >= {{ watermark(...) }}`,
including a lookback like `>= {{ watermark(...) }} - interval 2 hour` — re-reads the boundary
rows every run, because advancement always stores `MAX(cursor)` and the next run's `>=` filter
includes that value again. That makes an inclusive read **at-least-once by construction**: a
`merge` sink dedupes the re-read rows on its keys, `replace` overwrites them, and an `append`
sink is subject to the same `PZ0214` consent as any other at-least-once path. A strict `>` bound
reads each row once and has no boundary re-read.

## How `pz retry` staging reuse works

A successful `pz retry` used to be unable to advance the watermark at all: retry selects only the
prior run's failed/skipped nodes plus their ancestors, so a sink that already *succeeded* is never
re-selected, and watermark advancement requires every structural `SinkWrite` descendant to be
present-and-succeeded in *this run's own* results. That blocked advancement even after a fully
successful retry — and the next `pz run` would then re-extract the same slice and redeliver it to
every sink, duplicating rows in whichever ones were already committed. Retry staging reuse and
carried-forward sinks close that loop.

### Reuse: copying instead of re-extracting

For each `SourceLoad`, `pz retry` reuses the failed run's staged table instead of re-extracting
when **all** of these hold:

1. The prior run recorded that node `success`, under the same content-hash node id present in
   the freshly recompiled DAG (the same id-matching rule retry already uses to pick up
   failed/skipped nodes).
2. The prior run's `staging.duckdb` still exists (staging is retained by default when a run
   fails) and contains that node's staging table.
3. `--full-refresh` was **not** passed — that flag keeps meaning "start the extraction over",
   and disables reuse and carry-forward entirely.

When eligible, the executor copies the table before the connector is ever resolved — the source
is never contacted for that node:

```sql
ATTACH '<prior run dir>/staging.duckdb' AS pz_prior_<node id> (READ_ONLY);
CREATE OR REPLACE TABLE staging.<table> AS SELECT * FROM pz_prior_<node id>.staging.<table>;
-- verify COUNT(*) matches the prior run's recorded row count
DETACH pz_prior_<node id>;
```

(the attach alias is derived from the node's own id so that two SourceLoads reused concurrently
by the dispatcher never collide on a shared alias.) On success the node completes with
`provenance: reused`, its row count from the copy, and its watermark candidate re-materialized
under the *retrying* run's id.

### Fallback: never fail because reuse wasn't possible

Any guard failing — the row count not matching what was recorded, the table missing, or an
ATTACH/copy error (locked file, disk full) — drops whatever was copied and falls back to normal
extraction through the connector for that node, printing a `note:` naming the reason, for example:

```
note: source 'crm.events': prior run's staged table has 41 row(s) but 50 were recorded; re-extracting
note: source 'crm.events': staged data from the prior run could not be reused (<sanitized error>); re-extracting
```

Reuse is an optimization with a correctness bonus, not a new failure mode — a node that can't
reuse simply behaves exactly as retry did before this feature existed.

Only `SourceLoad` nodes are ever reused. Pipelines and Checks are always recomputed — they're
cheap (in-DuckDB) and recomputation avoids any question about per-run template constants
(`run_id`, `run_started_at`) baked into their rendered SQL.

### Partition checkpoints: the same fallback discipline, one level down

A source whose partitions declare `CheckpointableReads` (see
[Author a connector: partition identity and checkpoints](/how-to/author-a-connector/#partition-identity-and-checkpoints))
resumes a failed partition mid-read instead of re-reading it from the start — inside a single
run's attempt loop, or across a `pz retry`. This does not change the pairing matrix above.
Resume is strictly-after by contract: the engine only ever hands a connector a resume token
once every row it covers is durably staged, and before trusting that token it re-verifies the
staged prefix's row count against the ledger. A rejected or torn checkpoint is never trusted
partway — it degrades to a full partition re-read from scratch, the same at-least-once shape
the matrix already accounts for. Either way, staged rows never double-land: a partition's rows
move into the main staging table exactly once, in the same transaction as the ledger row that
marks it done.

### Carried-forward sinks unblock watermark advancement

Before dispatch, `pz retry` also seeds the run's results with **carried-forward** successes:
every `SinkWrite` that succeeded in the prior run, has an unchanged id in the recompiled DAG, and
— the soundness condition — has *every* SourceLoad ancestor being reused this retry (not falling
back to re-extraction), is recorded as an already-completed node with `provenance:
carried_forward`. It is never dispatched, shows up as such in the console and NDJSON output, and
counts toward watermark advancement's all-structural-sinks-committed rule. Because the soundness
condition guarantees every ancestor SourceLoad reproduces the prior slice byte-for-byte, the
carried-forward sink's already-committed data is provably identical to what this retry's other
sinks are working from — so a fully successful retry now advances the watermark, closing the
duplicate window described above.

If reuse fell back to re-extraction for any ancestor at execution time, the sinks downstream of
it remain recorded as carried forward in `run_results.json` and events (they genuinely committed
the prior slice), but that dataset's watermark advancement is blocked — the engine checks at
advancement time that every carried-forward sink's SourceLoad actually landed as `reused`, since
a re-extracted slice may not match the one the carried sink committed. The fallback path is never
worse than today's behavior, only sometimes less optimal.

A retry that reuses and carries forward prints both counts:

```
note: reusing staged data for 2 source load(s) from run 20260710T120000000Z-ab12
note: carrying forward 1 committed sink write(s) from run 20260710T120000000Z-ab12
```

## `provenance` in artifacts and events

Both `run_results.json` and the `node_completed` NDJSON event (see [Run events](/events/))
carry an optional `provenance` field on any node it applies to — absent for normally-executed
nodes, so pre-existing artifacts and event lines stay byte-identical:

- `"reused"` — a retried `SourceLoad` was satisfied by copying the failed run's staged table
  instead of re-extracting.
- `"carried_forward"` — a `SinkWrite` that committed in the prior run was recorded into this
  retry's results without being re-run.

A reused `SourceLoad`'s `run_results.json` entry also carries its `watermark` object (`cursor`,
`type`, `value`) — the slice identity the reuse inherited, re-stamped with the retrying run's id
rather than the failed run's.

## Delivery checkpoints

A sink whose connector declares `CheckpointableWrites` gets an engine-owned delivery
ledger — `pz_meta.sink_deliveries`, a table inside the run's `staging.duckdb`, tracking how many
drain-order rows the connector has durably confirmed for that node. The engine drains the sink's
input with `order by all` (a content-deterministic order, so the same relation content always
produces the same row prefix) and, after each batch, asks the checkpointing session how many rows
it has confirmed so far. At attempt teardown — success or failure — the acknowledged count is
persisted alongside a count+hash fingerprint of the drained relation's content; a later attempt
(the same run's retry loop, or a later `pz retry` carrying the staging DB forward through its
ATTACH mechanism) reads that row, re-fingerprints the relation, and — only when both the row count
and the content hash still match — resumes the drain past the acknowledged prefix instead of
re-delivering from row zero. Any mismatch (a changed relation, an unreadable prior, a declined
resume) scratches the row and falls back to a full re-drain, the same safe direction a rejected
partition checkpoint falls back to (above).

**Checkpoints narrow the duplicate window; they do not change the pairing matrix.** `append`
stays at-least-once even with checkpointing engaged: only connector-confirmed counts ever enter
the ledger (`TryGetAcknowledgedRows` may only report rows the destination has actually
acknowledged), so a resume never skips a row the destination hasn't seen — but a crash between the
destination's acknowledgment and the ledger write still re-delivers that unrecorded tail on the
next attempt. What checkpointing buys is a *smaller* duplicate window (the last unrecorded batch
or two, instead of the whole relation from scratch), not a different row in the table at the top
of this page.

## Write attempt identity

Every `SinkWrite` reaching a connector through the universal tier carries `OutputSpec.Attempt`, so a
sink can tell *which* attempt at *which* write it is executing rather than inferring it:

| Field | What it identifies |
|---|---|
| `Node` | the output being written — the content-addressed node id |
| `Run` | the run the attempt belongs to |
| `Ordinal` | which attempt within that run, counting from 1 |

**What it promises.** `Node` and `Run` are stable across every attempt *within one run*, and
`Ordinal` increments. A sink whose destination can record a durable progress marker — a commit
property, an application id, a row in a ledger table it writes transactionally with the data — can
therefore stamp one on commit, read it back at the start of the next attempt, and skip work a
previous attempt already committed. That closes the duplicate window `append` actually suffers from
in practice: a commit that reached the destination and then failed to be reported back to pz.

**What it does not promise.** Nothing here spans runs. A second `pz run` is a new `Run`, and a
marker written under the old one will not match — so do not build a cross-run dedupe on it. Bounding
it this way is deliberate: cross-run identity would have to be threaded through `run_results.json`
and every run-artifact backend, and a primitive that is silently unreliable in one backend is worse
than one whose limit is stated.

**Where it is stamped.** Only past the native-copy decision. A native `COPY` has no write session to
carry a marker, and the spec a connector is probed with by `TryGetNativeCopy` has to be the spec the
planner probed with — so `Attempt` is absent on that path rather than misleading. It is additive: a
connector that ignores it behaves exactly as before.

## What's still deferred: connector-side exactly-once `append`

Staging reuse and carried-forward sinks close the specific duplicate window where a fully
successful `pz retry` couldn't advance the watermark, and the delivery checkpoints (above)
narrow the re-delivery window for connectors that opt in. Neither makes `append` effectively-once
in general — the other duplicate windows in the pairing matrix above (a `pz run` instead of a
`pz retry`, a failed watermark persist, a partial `--select`, or a reuse fallback mid-retry) still
apply, and even a checkpointed sink can re-deliver its last unconfirmed batch on a crash.
[Attempt identity](#write-attempt-identity) hands a capable sink what it needs to close the
*within-run* case itself, which is the common one; it deliberately stops there. Closing
those for good needs a **connector-side** idempotency mechanism — a slice ledger (`_pz_slices`)
written in the same transaction as the data itself, for every sink connector — and that half of
the design stays deferred: it touches the connector ABI and every sink connector, so it's scoped
as its own follow-on design rather than bundled here.

## HTTP sink

`Pz.Connector.Http`'s sink is the vertical driver for the write-mode
and checkpoint work — see [Extract from an HTTP API](/how-to/extract-from-http-api/) for its
full configuration surface. Its delivery posture:

- **`append`** — chunked row-array (or NDJSON) requests; **at-least-once**, same as any other
  `append` sink — the `PZ0214` consent gate applies identically when it's fed by an incremental or
  windowed dataset.
- **`merge`** — one keyed `PUT`/`PATCH` request per row (exactly one key column in v1); rows are
  **effectively-once**, since a replayed request is an idempotent overwrite at the destination —
  the same slice landing twice is indistinguishable from landing once.
- **`replace`** — refused at plan time (`PZ0324`): the connector does not declare `ReplaceWrites`,
  since there is no way to atomically overwrite an arbitrary HTTP endpoint's prior state.

Its abort semantics are `none` — you cannot un-POST — and it declares `CheckpointableWrites`, so a
retried attempt resumes past its acknowledged prefix per the section above rather than re-sending
every row.

## Next steps

- [The execution model](/concepts/execution-model/) — the eight phases and how `pz retry` fits in.
- [Connectors](/concepts/connectors/#incremental-extraction-and-watermarks) — watermarks and commit-gated
  advancement in full.
- [Run events](/events/) — the `node_completed` event's full field list, including
  `provenance`.
- [Run checks and retry failures](/how-to/run-checks-and-retry/) — the operator-facing retry
  workflow.
