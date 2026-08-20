---
title: "Throttle a struggling source or sink"
description: "Retries handle outright connection drops; this article shows you how to bound how hard a run leans on a database or API that degrades under load — the same..."
---

Retries handle outright connection drops; this article shows you how to bound how *hard* a run
leans on a database or API that degrades under load — the same strained replica you might be
backfilling from, or a rate-limited endpoint, or any instance that needs less pressure.

`pz` has two independent throttling mechanisms, chosen by what the connector supports:

- **In-run request pacing** (`rate_limit:`) — a per-instance token bucket, enforced *within* one
  run, one operation at a time. Only connectors that declare
  `ConnectorCapabilities.GatedOperations` honor it (today: the `http` source, and the `azureblob`
  sink's universal write path).
- **Duty cycle** — bounded bursts with rests between runs, plus caps on concurrency. This is the
  fallback for every other connector, and remains useful alongside `rate_limit:` on gate-aware
  ones too (pacing bounds requests *per minute*; duty cycle bounds how much of the source's
  history a whole run touches).

The levers, and what each bounds:

| Lever | Where declared | What it bounds |
|---|---|---|
| `rate_limit` | Source/sink instance | Operations per minute, in-run (gate-aware connectors only) |
| `max_window` | Per dataset (`sync: { mode: incremental }`) | How much one run may extract (burst size) |
| Run spacing | Your scheduler / backfill loop | How often bursts fire |
| `max_concurrency` | Top level of a source/sink YAML file | How many of *that instance's* nodes run at once |
| `retry:` backoff | Source/sink/dataset/output | How hard a failing instance is re-hit |
| `engine.breaker` | `project.yml` `engine:` block | Whether a failing instance keeps being hammered at all |
| Database-side limits | The database itself | CPU/memory/IO of pz's queries, enforced where the resources live |

## Prerequisites

- A networked source or sink whose database or API degrades under load.

## Pace requests in-run with rate_limit

For a gate-aware connector, `rate_limit:` declares a token-bucket budget on the source/sink
**instance** (same YAML level as `retry:` — never on a dataset or output):

```yaml
# connections.yml
api:
  connector: http
  # ...host, credentials, connector options -- flat
  rate_limit:
    requests_per_minute: 60   # required, 1..1_000_000
    burst: 10                 # optional, 1..1_000_000; default max(1, requests_per_minute / 60)
```

The bucket starts full at `burst` and refills continuously at `requests_per_minute / 60` tokens
per second, shared across every dataset/output, partition, and retry attempt of that one
instance for the whole run. Every operation — one HTTP page fetch, one Azure blob open/copy/
delete — draws one token; when the bucket is empty, the next operation waits for a token rather
than firing immediately.

> [!IMPORTANT]
> **The unit is operations, not rows.** `rate_limit:` paces how often the connector talks to the
> remote endpoint — it has no notion of row count, and it does not resurrect the old
> `max_rows_per_second` dataset/output option (removed for being the wrong lever — see decision 21
> in the [architecture overview](/concepts/architecture-overview/) decision log).
> A single HTTP page can carry anywhere from zero to thousands of rows; `rate_limit:` doesn't
> know or care — it only counts the round-trip.

Because pacing happens at the operation boundary, a transient failure on the operation itself
(a 429, a dropped copy-promote) is retried *at that boundary* too, under the node's normal retry
policy — a failure on request 499 of a 500-request crawl re-fires only request 499, not the
whole node. See [Author a connector](/how-to/author-a-connector/#operation-gate) for the mechanism.

`rate_limit:` only paces connectors that declare `ConnectorCapabilities.GatedOperations`. On an
instance whose connector doesn't, `pz plan`/`pz run` refuse the config outright with `PZ0317`
rather than silently accepting a `rate_limit:` block that would never take effect:

```
source 'api': rate_limit is configured but connector 'foo' does not support gated operations
(pacing would be silently ignored)
```

Two remediations, same as the error's own next-step: **remove `rate_limit:`** and fall back to
the duty-cycle levers below, or **use a connector that declares `GatedOperations`**.

A malformed block (missing `requests_per_minute`, an out-of-range value, or `rate_limit:`
declared on a dataset/output instead of the instance) fails to load with `PZ0318`, naming the
file, field, and accepted range.

## Bound each burst with max_window

For connectors without `GatedOperations` — or as a complement to `rate_limit:` — throttle by
**duty cycle**: bounded bursts with rests, plus caps on concurrency, rather than a per-row rate
limit. `max_window` caps how many cursor units a single run extracts, so a run's blast radius
stays fixed no matter how far behind the backfill is — see
[Backfill in bounded slices](/how-to/backfill-in-slices/) for the full recipe. Space the bursts by
pacing your loop:

```console
$ until jq -e '.watermarks["pg_prod.orders"].value == "5000000"' .pz/state/watermarks.json > /dev/null 2>&1; do
    pz run --project .
    sleep 30   # rest between bursts — the replica gets its duty cycle back
  done
```

## Cap concurrent nodes with max_concurrency

```yaml
# connections.yml
pg_prod:
  connector: postgres
  # ...host, credentials, connector options -- flat
  max_concurrency: 2   # at most 2 of pg_prod's own nodes run at once, regardless of engine.threads
  retry:
    max_attempts: 8
    base_delay: 2s
    max_delay: 5m
  entities:
    orders:
      read:
        columns: { ... }
        sync: { mode: incremental, cursor: id, max_window: "10000" }
```

`max_concurrency` caps how many of that one instance's nodes run at once — independent of
`engine.threads`, which still governs everything else. It bounds concurrent *nodes*, not
connections: a source's own `partitions: N` still governs intra-node connection fan-out within
one SourceLoad, so the worst case for connections opened against the instance is
`max_concurrency × partitions`.

## Let the database limit the query itself

For *continuous* protection — not just smaller bursts — cap pz's queries where the resources
actually live. Give `pz` its own database login and restrict it:

- **SQL Server:** put the pz login in a [Resource Governor](https://learn.microsoft.com/sql/relational-databases/resource-governor/resource-governor)
  workload group with capped `MAX_CPU_PERCENT` / `MAX_MEMORY_PERCENT_PER_REQUEST`.
- **Postgres:** create a dedicated role and restrict it per-role:

```sql
CREATE ROLE pz_reader LOGIN PASSWORD '...';
ALTER ROLE pz_reader SET max_parallel_workers_per_gather = 0;  -- no parallel query fan-out
ALTER ROLE pz_reader SET work_mem = '16MB';
ALTER ROLE pz_reader SET statement_timeout = '10min';           -- no runaway extraction
GRANT SELECT ON orders TO pz_reader;
```

Database-enforced limits can't drift out of sync with reality and work identically for every
connector: they throttle the query no matter how the data moves.

## Back off a failing instance with engine.breaker

```yaml
# project.yml
engine:
  breaker:
    failure_threshold: 5   # 5 consecutive transient failures on one instance trips it
    cool_down: 2m           # ...then the instance is given 2 minutes before a single probe retries it
```

`engine.breaker` is instance-scoped, like `max_concurrency`: once an instance trips, every node
sharing it — every dataset of that source, every output of that sink — is gated. The connector
isn't invoked again until the cool-down elapses and a single probe node succeeds. This applies
regardless of `rate_limit:`: the breaker only ever sees the node's final, surfaced outcome —
operation-level retries inside the gate never trip or reset it on their own (see
[Author a connector](/how-to/author-a-connector/#operation-gate)).

A node that gives up waiting on an open breaker fails with a retryable `PZ0506`, not a fatal
error, so `pz retry` picks it back up once the instance has recovered. Watch for `breaker: ...`
lines in `pz run`'s console output — or the `breaker_state_changed` NDJSON event in
`--log-format json` — to see the trip and recovery as they happen.

## Choose the right lever

Reach for `rate_limit:` first on a gate-aware connector talking to a rate-limited API — it
paces exactly the unit the provider counts (requests), in-run, with no scheduler choreography.
Reach for `retry:` for outright connection drops. Bound bursts with `max_window` and space your
runs if a healthy-but-strained database needs less pressure per unit time; cap
`max_concurrency` if it needs fewer simultaneous connections; move to database-side resource
limits when the protection must hold continuously and unconditionally. Add `engine.breaker`
when a struggling instance needs the run to back off entirely, rather than retrying node after
node into the same outage.

> [!TIP]
> On an instance with many nodes, pair `engine.breaker` with `max_concurrency`: a node
> open-waiting on a tripped breaker still holds its dispatch slot for up to `2 × cool_down`
> before giving up, so an uncapped instance can have every one of its nodes parked in that
> wait at once.

## Next steps

- [Author a connector](/how-to/author-a-connector/#operation-gate) — the operation gate mechanism
  `rate_limit:` paces, for connector authors.
- [Tune retries per database](/how-to/tune-retries/)
- [Backfill in bounded slices](/how-to/backfill-in-slices/)
- [The execution model](/concepts/execution-model/) — how dispatch and `engine.threads`
  work.
