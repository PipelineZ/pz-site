---
title: "Delivery guarantees"
description: "What pz promises the destination when a run dies mid-write, how pz retry avoids repeating work that already landed, and what --full-refresh throws away."
sidebar:
  order: 9
---

This page states pz's delivery contract: what each write [strategy](/concepts/connections-and-entities/)
guarantees at the destination when a run fails partway, how `pz retry` avoids redoing work that
already landed, and what `--full-refresh` resets. Read it when you are choosing a write strategy
for an [entity](/concepts/key-concepts/), or when a partial failure left you unsure what actually
landed.

## What it is

A [run](/concepts/key-concepts/) can fail after some nodes have already written data. Delivery
guarantees describe what pz promises about the destination in that case: which strategies leave
it exactly as it was, which can leave a partial write behind, and which converge safely no matter
how many times the same slice lands. `pz retry` then decides how much of the failed run to redo,
and how much it can skip because the result is already proven.

## Why it matters

A source can be flaky, a network can drop mid-write, and a process can be killed. None of that is
exotic: it is the normal operating condition for anything that runs on a schedule. Knowing what
each write strategy promises tells you whether a partial failure is safe to retry blindly or
needs a human to check the destination first. Knowing what `pz retry` reuses tells you why a
retry is usually cheap, and why `--full-refresh` is the one command that is never cheap.

## How it works

<figure class="dgm">
  <a href="/diagrams/05-resilience-and-resume.png">
    <img class="dgm-light" loading="lazy" decoding="async" src="/diagrams/05-resilience-and-resume.png" alt="Resilience: containment tiers from one request up to one run, the records that survive a failure, and the delivery-guarantee matrix" />
    <img class="dgm-dark" loading="lazy" decoding="async" src="/diagrams/05-resilience-and-resume-dark.png" alt="" aria-hidden="true" />
  </a>
  <figcaption>Click the diagram to open it full size.</figcaption>
</figure>

### The guarantee by write strategy

Every write strategy needs the target connector to declare the matching capability, or `pz plan`
refuses it before any node runs (`PZ0324`): `replace` needs `ReplaceWrites`, `merge` needs
`Merge`. Given that, here is what a run that dies mid-write leaves behind:

| Strategy | If a run dies mid-write |
|---|---|
| `replace` | The destination is unchanged. A connector that also declares `Transactional` (`postgres`, `sqlserver`, `duckdb`, `ducklake`) commits the whole overwrite as one transaction or snapshot. A file or object-store connector (`localfiles`, `s3`, `azureblob`, `gcs`, `sftp`) writes to a temporary location and promotes it into place only on success. Either way there is no half-written destination to clean up: a retry sees exactly the pre-run state. |
| `append` | The destination may already hold some of the rows the failed attempt sent. A retry or re-run resends the same rows, so `append` is at-least-once, unless the connector declares `CheckpointableWrites`, which narrows the window to the last unconfirmed batch instead of the whole write. Only `http` declares it today. |
| `merge` | The destination holds whatever rows landed before the failure, each one already correct. A retry's keyed upsert on the same `keys:` overwrites those rows with themselves and adds the rest, so replaying a slice once or many times converges on the same result. |

`replace` and `merge` are effectively-once: the destination ends up the same whether a slice
lands once or is replayed. `append` is at-least-once by construction, which is why pairing an
incremental read with `append` requires you to opt in with `duplicates: 'accept'` (`PZ0214`). See
[Incremental loads](/concepts/incremental-loads/) for the full read side of that pairing.

### Retry tiers

pz absorbs a failure at the smallest scope that can contain it, so a transient error costs as
little as possible:

- **Per-node retry.** A node whose connector reports a transient error retries in place, with
  exponential backoff and jitter, before the node is marked failed. This is the `retry:` block:
  `max_attempts` (default 3), `base_delay` (default 1s), and `max_delay` (default 30s), settable
  on a connection and overridable per entity. See [connections.yml](/reference/connections-yml/#retry)
  for the full shape.
- **Circuit breaker.** An optional, connection-scoped guard: after `breaker.failure_threshold`
  consecutive failures against one connection, pz stops sending it new requests for
  `breaker.cool_down`, then probes once before resuming. Other connections keep running
  unaffected the whole time. Off by default; see [`engine.breaker`](/reference/project-yml/#engine).
- **`pz retry`.** When a node still fails after its own retries, or is skipped because an
  ancestor failed, the run ends. `pz retry` re-runs the current project against only that prior
  run's failed and skipped nodes, plus whatever ancestors they need. It never re-selects a node
  that already succeeded on its own.

What a retry never redoes: a source read that already landed successfully in the failed run is
reused from where it was staged, not re-extracted, as long as the source hasn't changed shape and
`--full-refresh` wasn't passed. A write that already committed in the failed run is carried
forward as already done, not re-run. Pipelines and checks are always recomputed, since they run
inside the [staging database](/concepts/key-concepts/) and are cheap either way. Either guard can
fall back: a reused read that no longer matches what was recorded, or a staged table that is
missing or unreadable, re-extracts instead of failing the retry outright.

### The flaky-source contract for bounded windows

An incremental read with `max_window` set exists partly to protect the destination from a
partial write, and partly to protect a source that cannot tolerate one huge extract: a flaky
replica, a rate-limited API, or a backlog too large to read in one pass. Each run then reads one
bounded slice, `(watermark, watermark + max_window]`, instead of everything past the watermark in
one attempt, so a failure costs at most one slice and the next run resumes cleanly at the same
boundary.

That promise only holds if the connector actually applies the upper bound during extraction
rather than reading past it. pz calls this its `BoundedWindow` capability, and treats it as
load-bearing: declaring `max_window` on an entity whose connector does not declare `BoundedWindow`
is refused at plan time, `PZ0313`, rather than silently extracting more than the window promised.

### `--full-refresh`

`pz run --full-refresh` and `pz retry --full-refresh` ignore every stored watermark and sync-state
token for that run and extract everything from scratch. Capture and advancement still run, so the
watermark or token is re-established from the full extract rather than left stale. On a windowed
entity, this also resets the window back to its declared `initial` value. Use it to recover from
an expired or unusable resume token, or after a schema change that makes the stored cursor value
untrustworthy. It is never the cheap option: treat it as a deliberate, occasional reset, not a
routine flag.

### Resuming a partitioned read

A source that reads more than one partition, such as many files or many parallel database splits,
can resume a failed read partway through instead of starting the whole entity over. Each partition
that finished lands in full before the next one starts, and a partition that only partly lands is
never counted as done. On a retry, pz skips the partitions already proven complete and either
resumes an interrupted one from where it left off, on a connector built to support that, or reads
it again from the start. A source's rows never end up staged twice either way.

### Resuming a checkpointable write

A sink whose connector supports resumable delivery can pick up a retried write past the point the
destination already confirmed, instead of resending every row. pz tracks how many rows the
destination has actually acknowledged, together with a fingerprint of what was sent, and only
trusts that position on the next attempt if the fingerprint still matches what would be sent again.
Anything else, a changed result set or an unreadable prior position, falls back to a full re-send
for that write rather than risking a gap. This narrows how much an `append` write can duplicate on
retry; it does not turn `append` into effectively-once delivery, since a row the destination
received but never got to acknowledge can still be resent once.

## Example

After a network blip fails one write partway through a run:

```console
$ pz run orders_enriched
ok stg_orders 5 rows 12ms
ok orders_enriched 5 rows 8ms
FAIL lake.order_totals 0 rows 4ms
run 20260902T101533221Z-4c1a: 2 succeeded, 1 failed, 0 skipped (.pz/runs/20260902T101533221Z-4c1a/run_results.json)

$ pz retry
note: reusing staged data for 2 source load(s) from run 20260902T101533221Z-4c1a
ok lake.order_totals 5 rows 6ms
run 20260902T101602118Z-9e2f: 1 succeeded, 0 failed, 0 skipped (.pz/runs/20260902T101602118Z-9e2f/run_results.json)
```

`stg_orders` and `orders_enriched` already succeeded, so `pz retry` reuses their staged results
instead of re-running the pipeline, and only `lake.order_totals` actually executes again.

## Errors

| Code | Meaning |
|---|---|
| [`PZ0214`](/reference/error-codes/) | An incremental or windowed read feeds an `append` write with no `duplicates: 'accept'` consent. |
| [`PZ0313`](/reference/error-codes/) | `max_window` is set on an entity whose connector does not declare `BoundedWindow`. |
| [`PZ0324`](/reference/error-codes/) | A write strategy the target connector's capabilities do not support. |

## Related

- [Incremental loads](/concepts/incremental-loads/): watermarks, `max_window`, and the `merge` strategy that pairs with them.
- [How a run works](/concepts/how-a-run-works/): the phases a run passes through before any node writes.
- [Resume internals](/internals/resume-internals/): how staging reuse, carried-forward writes, and delivery checkpoints are implemented, for contributors.
- [Run checks and retry failures](/how-to/run-checks-and-retry/): the operator's guide to `pz retry` in practice.
- [Connectors](/concepts/connectors/): what a capability is and how a connector declares one.
