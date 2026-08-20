---
title: "Tune retries per database"
description: "Transient source and sink failures — dropped connections, failovers — are retried by the engine automatically, with exponential backoff. This article shows..."
---

Transient source and sink failures — dropped connections, failovers — are retried by the engine
automatically, with exponential backoff. This article shows you how to change the retry policy
for one database, or for one dataset within it.

## Prerequisites

- A project with at least one networked source or sink (for example the Postgres connector).

## The default policy

Every source and sink starts with the same policy, which suits healthy databases:

| Setting | Default | Meaning |
|---|---|---|
| `max_attempts` | 3 | Total tries before the node fails |
| `base_delay` | 1s | Delay before the first retry; grows exponentially |
| `max_delay` | 30s | Cap on the backoff delay |

## Override the policy for one source or sink

For a flaky database — a long backfill over a strained replica, say — declare a `retry:` block
in that source's or sink's own YAML file:

```yaml
# connections.yml
pg_prod:
  connector: postgres
  # ...host, credentials, connector options -- flat
  retry:
    max_attempts: 8
    base_delay: 2s
    max_delay: 5m
```

All three keys are optional; an absent key keeps its default. Durations accept `ms`, `s`, `m`,
`h`, and `d`.

## Override the policy for one dataset

When datasets sharing one source differ in scale — a millions-of-rows backfill next to a small
lookup table — a dataset (or, on sinks, an output) can declare its own `retry:` block. Its
fields override the instance's, field by field.

> [!TIP]
> `pz plan` shows the effective policy for everything that declares a `retry:` block, so you
> can confirm the override without running.

## Next steps

- [Backfill in bounded slices](/how-to/backfill-in-slices/) — pair a sized retry policy with bounded
  extraction windows.
- [Throttle a struggling source or sink](/how-to/throttle-a-source/) — when the problem is load, not
  dropped connections.
