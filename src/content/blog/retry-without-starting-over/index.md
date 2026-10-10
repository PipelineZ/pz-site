---
title: "Retry without starting over"
description: "A run that fails on its last write shouldn't cost another hour of extraction. pz retry re-runs only what didn't finish, copies the reads that already landed, and carries forward the writes that already committed."
date: 2026-10-11
heroImage:
  dark: ./hero-dark.svg
  light: ./hero-light.svg
  alt: "The words Retry, not rerun, above a row of pipeline nodes where a run broke at the last step and a yellow path picks up from the break without going back to the start."
---

A nightly job spends forty minutes pulling two large tables out of a production replica, joins
them in a few seconds, writes the result to a lake, and then fails on its second write because
the warehouse dropped the connection. Nothing was wrong with the data. Nothing about the forty
minutes needs repeating. A plain re-run repeats all of it anyway, and hits the replica a second
time for rows it already handed over.

`pz retry` exists so that the expensive part of a failed run isn't paid twice. It reads what the
last run recorded, works out the smallest amount of work that finishes the job, and reuses
everything it can prove is still good.

## What a retry selects

Every run writes `run_results.json`, with one entry per node: its id, its status, how many rows
it moved. `pz retry` reads the most recent one and selects every node that `failed` or was
`skipped` because something upstream failed. It then adds whatever those nodes depend on, the
same way `--select` pulls in ancestors.

A node that succeeded on its own branch is never selected again. In a project with ten
independent flows where one sink failed, the retry touches that one flow and leaves the other
nine alone.

```console
$ pz run --all
ok src_pg_prod__customers 1204331 rows 552310ms
ok src_pg_prod__orders 18730552 rows 1900482ms
ok orders_enriched 18730552 rows 6204ms
ok lake.orders_enriched 18730552 rows 48113ms
FAIL warehouse.orders_enriched 0 rows 2087ms
  PZ0501: sink 'warehouse' output 'orders_enriched': connection reset by peer

$ pz retry
note: reusing staged data for 2 source load(s) from run 20261010T020011408Z-7d1e
note: carrying forward 1 committed sink write(s) from run 20261010T020011408Z-7d1e
ok src_pg_prod__customers 1204331 rows 3811ms
ok src_pg_prod__orders 18730552 rows 21390ms
ok orders_enriched 18730552 rows 6122ms
ok warehouse.orders_enriched 18730552 rows 50967ms
```

Four things happened on that retry, and each follows its own rule.

## Reads that landed are copied, not re-extracted

Each source read lands in the run's staging database, `.pz/runs/<id>/staging.duckdb`, before any
pipeline touches it. That file survives a failed run. On retry, a source load that succeeded last
time attaches the old staging database read-only and copies its table across, so the replica
isn't contacted at all. Forty minutes of extraction became twenty-five seconds of local copy.

The copy is checked, not trusted. pz compares the copied table's row count against what the
failed run recorded for that node. A mismatch, a staging file that's gone, or a table that can't
be read falls back to a normal extraction, with a note saying why. A retry that can't reuse a read
is slower, but it never fails because of the reuse.

Staging databases are swept after each run, keeping the newest ten by default (`retention:
keep_last`), so the run a retry needs is always there. `pz clean` deletes them by hand, and after
that a retry re-extracts everything.

## Pipelines and checks always re-run

`orders_enriched` succeeded the first time, and the retry ran it again anyway. Pipelines and
checks run inside the staging database against tables that are already local, so recomputing
them costs seconds. Recomputing also means there's no second cache of intermediate results whose
validity pz would have to reason about.

## Writes that committed are carried forward

`lake.orders_enriched` committed on the first attempt. The retry didn't run it again. pz recorded
it into the new run's results as `carried_forward`, using the row count from the run that wrote
it.

That record isn't just bookkeeping. An incremental source only advances its watermark once
every sink downstream of it has committed in the same run. If the lake write were simply left out
of the retry, the retry run would have only one of the two sinks, the watermark would never move,
and tomorrow's run would extract the same rows again. Carrying the write forward lets the retry
finish the run's job, watermark included.

pz only carries a write forward when it can show the retry will hand the other sinks exactly the
data that write already committed:

- every node between the sink and its sources succeeded last time and hasn't changed since, and
- every source load feeding it is being reused from the failed run's staging, not re-extracted.

If either condition fails, the sink runs again rather than having its earlier commit vouched for.
Watermark advancement repeats the check at the end of the run, so a carried-forward sink whose
source fell back to re-extraction still can't advance that source's watermark.

## Edited nodes aren't the same node

Node ids are content hashes of what the node does: its SQL, its connection, its options. Fix a
typo in a pipeline after a failed run and that pipeline has a new id. `pz retry` matches by id, so
an edited node is no longer "the node that failed", and pz says so:

```console
$ pz retry
note: orders_enriched changed since the failed run; run 'pz run' for a full pass if needed
nothing to retry (project changed)
```

It's deliberate. A retry promises to finish *that* run, and that run never ran your edited SQL. A
sink's `keys:`, `duplicates:`, and `on_delete:` are part of its identity for the same reason:
changing how a write lands means an earlier commit no longer stands for it. `retry:` settings
aren't part of the identity, since they change how an attempt is made, not what it commits.

## What the destination saw in the meantime

A retry is only safe if the failed attempt left the destination in a state a second attempt can
build on. That depends on the write strategy:

| Strategy | After a failed write | On retry |
|---|---|---|
| `replace` | Unchanged: transactional connectors commit the overwrite atomically, file and object stores promote a temp location only on success | Writes the full result once |
| `merge` | Holds whatever rows landed, each one correct | Upserts on `keys:`, so rows already written overwrite themselves |
| `append` | May hold some rows from the failed attempt | Sends them again: at-least-once |

`replace` and `merge` are effectively-once: one attempt or five, the destination ends up the
same. `append` can't be, which is why pairing an incremental read with an `append` sink is
`PZ0214` at compile time unless the sink says `duplicates: accept`.

Two finer-grained resumes narrow the gap further. A source read split into partitions (many files,
or parallel database splits) resumes past the partitions that fully landed. A sink whose connector
supports checkpointed delivery resumes past the rows the destination acknowledged, but only if a
fingerprint of what would be sent still matches what was sent. `http` is the one builtin that
supports it today.

## When pz won't retry

Some runs can't be finished, only redone. pz refuses those with an error instead of guessing:

| Code | Meaning |
|---|---|
| `PZ0502` | There's no earlier run to retry. |
| `PZ0503` | The last run was interrupted mid-flight, a crash or a kill, so its recorded statuses can't be trusted. |
| `PZ0504` | The last run failed at the orchestrator level, not at a node. |

All three say to run `pz run` again. A run that succeeded gets `nothing to retry` and exit `0`, so
a script can call `pz retry` after any run without checking how it ended first.

`pz retry --full-refresh` turns all of this off: no reuse, no carried-forward writes, every
watermark ignored. It's the escape hatch for when the staged data is the thing that's wrong, and
it's never the cheap option.

## Seeing what a retry reused

Reuse is recorded, not just announced. In `run_results.json` and on each `node_completed` event in
`--log-format json`, a reused source load carries `"provenance": "reused"` and a carried-forward
sink carries `"provenance": "carried_forward"`. Normally executed nodes have no `provenance`
field. `pz runs` lists the reused and carried-forward counts for each run, so a run history shows
which runs did real extraction and which were finished from an earlier attempt.

## Try it

[Run checks and retry](/how-to/run-checks-and-retry/) walks `pz retry` step by step, and
[Debug a failed run](/how-to/debug-a-failed-run/) covers finding the cause before you retry.
[Delivery guarantees](/concepts/delivery-guarantees/) is the full contract: the strategy table,
the retry tiers below `pz retry` (per-node backoff and the circuit breaker), and partition and
checkpoint resume.
