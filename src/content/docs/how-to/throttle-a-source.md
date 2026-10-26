---
title: "Throttle a source"
description: "How to bound how hard a run leans on a struggling database or rate-limited API, with rate_limit pacing, max_window bursts, max_concurrency, and engine.breaker."
sidebar:
  order: 6
---

This page shows how to bound how hard a run leans on a source or sink that degrades under load: a
strained replica, a rate-limited API, or any instance that needs less pressure. Read it when
retries alone aren't the fix, because the problem is volume, not dropped connections.

`pz` has two throttling mechanisms, chosen by what the connector supports: in-run request pacing
with `rate_limit:`, and duty cycle, bounded bursts with rests between runs. The table below maps
each lever to what it bounds.

| Lever | Where declared | What it bounds |
|---|---|---|
| `rate_limit` | Connection | Operations per minute, in-run, on gate-aware connectors only. |
| `max_window` | Entity, under `sync:` | How much one run may extract. |
| Run spacing | Your scheduler or backfill loop | How often bursts fire. |
| `max_concurrency` | Connection | How many of that connection's nodes run at once. |
| `retry:` backoff | Connection, entity, or output | How hard a failing instance is re-hit. |
| `engine.breaker` | `project.yml` | Whether a failing instance keeps being hammered at all. |
| Database-side limits | The database itself | CPU, memory, and IO of pz's own queries. |

## Prerequisites

- A networked connection whose database or API degrades under load.

## Steps

### 1. Pace requests in-run with rate_limit

For a gate-aware connector, `rate_limit:` declares a token-bucket budget on the connection, at
the same YAML level as `retry:`:

```yaml title="connections.yml"
api:
  connector: http
  base_url: https://api.example.com
  rate_limit:
    requests_per_minute: 60
    burst: 10
```

The bucket starts full at `burst` and refills at `requests_per_minute / 60` tokens per second,
shared across every entity, partition, and retry attempt of that one connection for the whole
run. Every operation, one HTTP page fetch or one blob copy, draws one token.

`rate_limit:` only paces connectors that declare the `GatedOperations` capability: `http` and
`sftp` on both reads and writes, and `azureblob` and `gcs` on their universal-tier writes. On a
connector that doesn't declare it, `pz plan`/`pz run` refuse the config outright with `PZ0317`.
A malformed block, or one declared under `read:`/`write:` instead of the connection, is `PZ0318`.

### 2. Bound each burst with max_window

For connectors without `GatedOperations`, or as a complement to `rate_limit:`, throttle by duty
cycle instead: bounded bursts with rests, rather than a per-row rate limit. `max_window` caps how
many cursor units a single run extracts. See
[Backfill in slices](/how-to/backfill-in-slices/) for the full recipe. Space the bursts yourself:

```console
$ until pz state show pg_prod.orders | grep -q "5000000"; do
    pz run --all
    sleep 30
  done
```

### 3. Cap concurrent nodes with max_concurrency

```yaml title="connections.yml"
pg_prod:
  connector: postgres
  host: ${PG_PROD_HOST}
  database: prod
  max_concurrency: 2
```

`max_concurrency` caps how many of that one connection's nodes run at once, independent of
`engine.threads`, which still governs everything else. It bounds concurrent nodes, not
connections: an entity's own `partitions:` still governs connection fan-out within one node, so
the worst case is `max_concurrency × partitions`.

### 4. Back off a failing instance with engine.breaker

```yaml title="project.yml"
engine:
  breaker:
    failure_threshold: 5
    cool_down: 2m
```

`engine.breaker` is connection-scoped, like `max_concurrency`. Once a connection trips, every
node sharing it is gated until the cool-down elapses and one probe node succeeds. A node that
gives up waiting on an open breaker fails with a retryable `PZ0506`, so `pz retry` picks it back
up once the instance recovers.

### 5. Let the database limit the query itself

For continuous protection, cap `pz`'s queries where the resources live. Give `pz` its own login
and restrict it:

```sql
CREATE ROLE pz_reader LOGIN PASSWORD '...';
ALTER ROLE pz_reader SET max_parallel_workers_per_gather = 0;
ALTER ROLE pz_reader SET statement_timeout = '10min';
GRANT SELECT ON orders TO pz_reader;
```

## Verify

`pz plan` prints every connection that declares `max_concurrency`, and the effective `retry:`
policy for every connection, entity, and output that declares one, so you can confirm an override
without running anything.

## Choose the right lever

Reach for `rate_limit:` first on a gate-aware connector talking to a rate-limited API: it paces
exactly the unit the provider counts, in-run, with no scheduler choreography. Reach for `retry:`
for outright connection drops. Bound bursts with `max_window` and space your runs when a
healthy-but-strained database needs less pressure per unit time. Cap `max_concurrency` when it
needs fewer simultaneous connections. Add `engine.breaker` when a struggling instance needs the
run to back off entirely, rather than retrying node after node into the same outage.

:::tip
On a connection with many nodes, pair `engine.breaker` with `max_concurrency`. A node
open-waiting on a tripped breaker still holds its dispatch slot for up to `2 × cool_down` before
giving up, so an uncapped connection can have every node parked in that wait at once.
:::

## Troubleshooting

| If you see | Do |
|---|---|
| `PZ0317` at compile time | `rate_limit:` is declared on a connector without `GatedOperations`. Remove it, or switch to a gate-aware connector. |
| `PZ0318` at compile time | `rate_limit:` is malformed, out of range, or declared under `read:`/`write:` instead of the connection. |
| `PZ0506` on a node | The connection's breaker is open. Wait for `cool_down` to elapse, then `pz retry`. |
| A node parked for a long time before failing | A tripped breaker's waiting nodes hold their dispatch slot for up to `2 × cool_down`. Pair `max_concurrency` with `engine.breaker` to bound how many nodes wait at once. |
| The database itself is still overloaded | pz-side throttling only bounds what pz sends. Add database-side limits for continuous, unconditional protection. |

## Related

- [Backfill in slices](/how-to/backfill-in-slices/): the full `max_window` recipe for bounding
  one run's extraction.
- [Tune retries](/how-to/tune-retries/): the `retry:` cascade this page's backoff lever relies on.
- [connections.yml reference](/reference/connections-yml/#rate_limit): every `rate_limit:` key and
  its bounds.
- [How a run works](/concepts/how-a-run-works/): how dispatch and `engine.threads` interact with
  `max_concurrency`.
