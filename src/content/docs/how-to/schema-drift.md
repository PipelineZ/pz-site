---
title: "Detect schema drift at run time"
description: "The default is ignore, and it is a true no-op: with no key present, a run performs no DESCRIBE, no baseline read or write, and publishes no event —..."
---

`on_source_drift` turns on a run-time gate that compares each contract-less source dataset's
actual landed schema against an accepted baseline, and reacts per an `ignore | warn | fail`
policy. It is the run-time complement to `pz validate --connect` (tier 5): see
[Handle schema drift](/how-to/handle-schema-drift/) for the validate-time picture, contract-checking,
and sink-side drift. This page is about the newer, opt-in, actual-data check.

## Prerequisites

- A runnable project with at least one contract-less source dataset (no `columns:` under
  `entities: <e>: read:`). Follow the [quickstart](/quickstart/) to scaffold one.

## Turn it on

```yaml
# project.yml
on_source_drift: warn        # ignore (default) | warn | fail
```

The default is `ignore`, and it is a true no-op: with no key present, a run performs no
`DESCRIBE`, no baseline read or write, and publishes no event — artifacts are byte-identical to
a project that predates this feature.
`on_source_drift: banana` (or any value other than
`ignore`/`warn`/`fail`) is a load-time error, `PZ0126`, naming `project.yml` and the bad value;
the project still loads with the policy treated as `ignore` (aggregate-errors convention — one
bad key does not block the rest of the file from being validated).

Only contract-less datasets are checked. A dataset that declares `columns:` is skipped by this
gate entirely — the contract already types and prunes the read, a missing column is an
extraction error, and `pz validate --connect` keeps checking it against source metadata. This
gate is the missing complement for the datasets a contract doesn't cover, not a second checker
for the ones it does.

> [!NOTE]
> **`localfiles` CSV/JSON and `azureblob` CSV/JSON datasets are covered here too, under `warn`/`fail`
> only.** Both connectors can run a `columns:`-less csv/json dataset via DuckDB's own
> `auto_detect` on the real native-scan read, so this gate's ordinary, connector-agnostic
> contract-less check reaches them too. There is no separate inference-specific baseline or
> seeding path: DuckDB's auto-detected schema plays exactly the same role a landed-data
> `DESCRIBE` plays for any other contract-less connector (Postgres query-mode, SqlServer, HTTP raw
> mode), because csv/json's real read already goes through native scan. `on_source_drift: ignore`
> (the default) still short-circuits before any baseline is read or written, same as for every
> connector — inference alone never seeds a baseline on its own.



## What seeds when

The schema truth here is the actual staged data, not a metadata call: after a SourceLoad
materializes its staging table, the engine runs one `DESCRIBE` against it (a single scalar
round trip on the run's DuckDB connection) and compares that observed schema to whatever is
stored as the dataset's accepted baseline.

There is no baseline the first time a dataset is checked, so the first `warn`/`fail` run for
each dataset **seeds** the baseline from what it observes — silently, with no event, and the
node succeeds normally. From the second run on, drift detection is live.

A baseline is also **silently reseeded**, with no event, whenever the effective read shape
changes — tracked as a hints hash over the dataset's projection/predicate pushdown
(`ReadHints`). This is deliberate: a `hintsHash` mismatch means "the read changed, not the
source." It follows naturally that if you edit a pipeline's SQL so it selects a different
column set, or a tier flip changes which columns get pushed down (see
[Edge cases](#edge-cases) below), the very next run reseeds against the new shape instead of
reporting drift that isn't real. If real source drift happens to land on that exact run, it is
absorbed into the new baseline unnoticed — a narrow, accepted trade-off, not a bug.

## The warn-until-accept loop

Under `on_source_drift: warn`, a drifted run does three things and none of them touch the
baseline:

1. Publishes a `source_drift_detected` NDJSON event (see [Run events](/events/)) naming the
   connection, entity, each column-level change (`added`/`removed`/`retyped`), the full observed
   schema, and the hints hash.
2. Prints a console warning line naming the connection, entity, and changes. On an interactive
   TTY run, the live tree also grows a yellow child node under the drifted SourceLoad with the
   same wording.
3. Lets the node succeed — `warn` never fails a run.

The baseline is **not** advanced automatically. That means the same warning repeats on every
subsequent run until a person (or an automated system) explicitly accepts the new shape — `warn` is a
standing notice, not a one-time alert.

## `pz schema accept`

```console
$ pz schema accept                    # accept every dataset whose latest observed schema differs from its baseline
$ pz schema accept pg.orders          # accept only pg.orders
$ pz schema accept pg.orders crm.leads
```

`accept` promotes the **latest run's** recorded observed schema into the baseline, one dataset
at a time, printing what moved:

```console
$ pz schema accept
pg.orders: column 'amount' retyped BIGINT -> VARCHAR
accepted 1 schema change(s)
```

Nothing to accept prints `nothing to accept` and writes nothing; exit code is `0` either way.
A named target that the latest run recorded no observed schema for is `PZ0127`, exit code `2`,
naming the dataset and the next step (run with `on_source_drift: warn` or `fail` first).

**It never opens a connection.** `accept` reads two things only: the latest run's artifacts
(`run_results.json`'s `observed_schema` field, or its SQL-backend equivalent) and the current
baseline entry, then re-diffs the two purely in memory. The project is compiled (to map the
run's content-hash node ids back to `<connection>.<entity>` names, the same way `pz retry` maps
ids back to selection) but no node is ever executed and no source is ever contacted — so
`accept` works even when the source that drifted is currently unreachable.

**Where you can run it from depends on the `state:` backend** — run artifacts (what `accept`
reads) and the baseline it writes don't always travel together:

| Backend | Where `pz schema accept` can run |
|---|---|
| `local` (default) | The machine that ran — artifacts and baseline both live under `.pz/`. |
| `sqlserver` | Any machine that can reach the shared SQL Server store — run artifacts and the baseline both live there. |
| `http` | The machine that ran, only. Run artifacts stay **local** under this backend (only watermarks and sync-state move to the server over HTTP — see [Move state off the local disk](/how-to/remote-state/)), so `accept` has nothing to read from anywhere else. To accept from elsewhere, do it against the state server directly instead of through the CLI. |

## `fail` and the `pz retry` synergy

Under `on_source_drift: fail`, a drifted SourceLoad node fails with **PZ0331**, naming the
dataset, the changes, and `pz schema accept` as the next step. Downstream nodes skip as usual —
no sink ever writes drifted data. The extraction cost for that node is already spent by the time
the check fires (the schema truth is the *landed* data), but nothing is wasted: the staged table
is retained exactly like any other failed run's staging, so the sequence is:

1. `pz run` fails a SourceLoad with PZ0331.
2. `pz schema accept` (or the named form) updates the baseline from that run's recorded
   `observed_schema` — no connection opened.
3. `pz retry` reuses the already-staged table for that node instead of re-extracting, and the
   rest of the run proceeds from there.

## Where the baseline lives

The baseline is a new keyed-state scope, `"schemas"`, stored beside `"watermarks"` and
`"sync-state"` — it follows whichever `state:` backend the project is already using (see
[Move state off the local disk](/how-to/remote-state/)):

| Backend | Baseline location |
|---|---|
| `local` (default) | `.pz/state/schemas.json` |
| `sqlserver` | The same generic keyed-state tables watermarks use, scope `schemas`, under `state.schema` |
| `http` | The same run-scoped state endpoint, `/schemas/{key}` |

Entries are keyed `<connection>.<entity>`, one per dataset, and carry the observed columns (name
+ DuckDB type, in table order), the hints hash they were seeded/accepted under, and the run id
that produced them. Nothing here is new plumbing to operate — the SQL Server and HTTP backends
work unchanged through the same generic stores that already carry watermarks.

## Edge cases

- **A tier flip absorbs drift on the same run it happens.** If a capability or config change
  moves a dataset between the native-scan and universal-Arrow data-plane tiers, the effective
  read shape (and so the hints hash) changes too. If real source drift lands on exactly the run
  where that flip happens, the run reseeds silently instead of reporting it — the flip and the
  drift are indistinguishable from a hints-hash point of view. Rare in practice, and consistent
  with "a hints-hash mismatch always means the read changed, never the source."
- **`accept` reads only the latest run.** A `warn`-policy `pz retry` that reuses a previously
  staged SourceLoad does not re-run the drift gate for that node (the table was landed by the
  earlier, failed or drifted run, and its schema is whatever that run already reported) — so
  that node's entry carries no `observed_schema` in the retry run's artifacts. If you retry
  before accepting, `pz schema accept` for that dataset then reports `PZ0127` (no recorded
  observed schema in the *latest* run), even though an earlier run did observe and report the
  drift. Either accept before retrying, or run once more (without reuse) afterward to get a
  fresh observed schema to accept.
- **Zero-row extracts still seed/compare normally.** An empty result set still materializes a
  staging table with real columns, so the gate has something to `DESCRIBE` either way.

## Next steps

- [Handle schema drift](/how-to/handle-schema-drift/) — the validate-time (`--connect`) and sink-side
  picture.
- [Run events](/events/) — the `source_drift_detected` event contract.
- [`project.yml` reference](/reference/project-yml/) — `on_source_drift:` and every other key.
- [Move state off the local disk](/how-to/remote-state/) — the `state:` block the baseline follows.
