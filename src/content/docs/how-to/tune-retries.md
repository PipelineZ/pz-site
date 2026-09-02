---
title: "Tune retries"
description: "How to change pz's automatic retry policy for one connection or one entity, and how the policy cascades down to pz's built-in default."
sidebar:
  order: 5
---

This page shows how to change `pz`'s automatic retry policy: the exponential backoff it applies
to a transient source or sink failure before giving up on a node. Read it when a flaky database
or API needs more, or fewer, attempts than the default.

## Prerequisites

- A project with at least one networked connection, such as `postgres`, `sqlserver`, or `http`.

## Steps

### 1. Know the default

Every connection starts with the same built-in policy:

| Setting | Default | Meaning |
|---|---|---|
| `max_attempts` | `3` | Total tries before the node fails. |
| `base_delay` | `1s` | Delay before the first retry. Grows exponentially after that. |
| `max_delay` | `30s` | Cap on the backoff delay. |

Delay between attempts is `base_delay × 2^(attempt-1)`, capped at `max_delay`, then jittered by
about ±25% so many nodes retrying the same struggling instance don't all retry in lockstep.

### 2. Override the policy for one connection

Declare a `retry:` block at the top level of the connection:

```yaml title="connections.yml"
pg_prod:
  connector: postgres
  host: ${PG_PROD_HOST}
  database: prod
  user: ${PG_PROD_USER}
  password: ${PG_PROD_PASSWORD}
  retry:
    max_attempts: 8
    base_delay: 2s
    max_delay: 5m
```

All three keys are optional. An absent key keeps its default. Durations accept `ms`, `s`, `m`,
`h`, and `d`.

### 3. Override the policy for one entity

When entities sharing a connection differ in scale, such as a millions-of-rows backfill next to a
small lookup table, declare `retry:` under that entity's own `read:` or `write:` block instead.
Its fields override the connection's, field by field:

```yaml title="connections.yml"
    entities:
      public.orders:
        read:
          columns: { id: bigint, updated_at: timestamp }
          retry:
            max_attempts: 8
            base_delay: 2s
            max_delay: 5m
```

An unset field cascades: entity retry, then connection retry, then pz's built-in default of 3
attempts, a 1s base delay, and a 30s cap.

A `write:` block takes the same `retry:` key, for an output that needs its own policy separate
from the connection it writes to:

```sql title="pipelines/orders_out.sql"
INSERT INTO {{ sink('lake', 'orders_synced', retry: { max_attempts: 6, base_delay: '3s' }) }}
select * from {{ ref('orders_shaped') }}
```

The cascade is the same either direction: the output's own `retry:` overrides the connection's,
field by field, and an unset field falls through to the connection's value or the built-in
default.

## Verify

`pz plan` prints the effective policy for everything that declares a `retry:` block, so you can
confirm an override without running anything:

```console
$ pz plan
strategy      node                        reason
arrow_stream  src_pg_prod__public_orders  arrow stream: connector 'postgres' has no native path
...
retry: source pg_prod max_attempts=8 base_delay=2s max_delay=5m
```

## Troubleshooting

| If you see | Do |
|---|---|
| `PZ0121` | The `retry:` block is malformed: a non-mapping value, `max_attempts` under 1, a bad duration, or `max_delay` smaller than `base_delay` in the same block. Fix the value named in the error. |
| A node keeps failing after 3 quick attempts | You're relying on the default policy against a genuinely flaky instance. Raise `max_attempts` and `base_delay` as shown above. |
| Retries aren't fixing anything | Retries only help transient failures: dropped connections, failovers. A permanent error, such as a bad password, fails the same way every attempt. Check the error message before raising `max_attempts`. |
| A struggling source needs less request volume, not more patience | Retries wait between attempts; they don't reduce how much a run asks of the source. See [Throttle a source](/how-to/throttle-a-source/) instead. |

## Related

- [connections.yml reference](/reference/connections-yml/#retry): the full `retry:` key table
  and where it can be declared.
- [Throttle a source](/how-to/throttle-a-source/): bound how hard a run leans on a source, which
  retries alone don't do.
- [Backfill in slices](/how-to/backfill-in-slices/): pair a sized retry policy with bounded
  extraction windows.
- [Run checks and retry](/how-to/run-checks-and-retry/): `pz retry`, for resuming a run after a
  node exhausts its retries and fails outright.
