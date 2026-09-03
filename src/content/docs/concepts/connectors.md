---
title: "Connectors"
description: "What a connector is, builtin versus third-party, how a connector runs, and the two data-movement tiers a planner chooses between."
sidebar:
  order: 13
---

This page explains what a [connector](/concepts/key-concepts/) is, how pz hosts one, and how the
planner decides what a connector can do. Read it before writing your own connector, or when you
need to know why a read or write took a particular path.

## What it is

A connector is the code that reads or writes one kind of place: a database, an object store, a
filesystem, or an API. Every [entity](/concepts/key-concepts/) in `connections.yml` belongs to a
connection, and every connection names exactly one connector, `connector: postgres` or
`connector: s3`, that does the actual work of a read or a write.

## Why it matters

A pipeline author never opens a driver or writes a client library call. `source()` and `sink()`
name a connection and an entity, and the connector behind that connection handles the rest:
authentication, pagination, retries at the request level, and turning rows into the
[staging database](/concepts/key-concepts/)'s tables or back out again. Which connector you use,
and what it declares it can do, decides what options are legal on an entity and how fast a read
or write runs.

## How it works

### Builtin versus third-party

Fifteen connectors ship inside the `pz` binary and need no extra setup: `localfiles`,
`postgres`, `s3`, `sqlserver`, `azureblob`, `gcs`, `http`, `mysql`, `sqlite`, `duckdb`,
`ducklake`, `motherduck`, `quack`, `iceberg`, and `sftp`. Naming one as `connector:` in
`connections.yml` is enough.

Anything else is a third-party connector: a NuGet package declared in `project.yml`.

```yaml title="project.yml"
connectors:
  - package: Some.Connector.Package
    version: 1.0.0
```

`pz restore` resolves every declared package against the configured feeds, `--feeds` if passed,
else the `PZ_FEEDS` environment variable, else nuget.org, downloads it under `.pz/packages`, and
writes `pz.lock.json` at the project root so every machine restores the exact same version.
Commit `pz.lock.json`, never `.pz/`. `pz run` refuses to start if `pz.lock.json` no longer
matches `project.yml`'s declared connectors, unless `--no-lock-check` is passed.

### Out-of-process execution

A builtin connector runs inside the same `pz` process as everything else. A restored, third-party
connector runs as its own operating-system process instead, speaking a wire protocol, PCP, back
to pz over a local socket. pz spawns that process with an empty environment and repopulates only
a small allowlist, `PATH`, `HOME`, and a few others: connection config and secrets never leak into
the child's environment. They cross the socket as an explicit request instead, the same way pz
would configure a builtin connector in memory.

This isolation boundary is what lets a third-party connector crash, misbehave, or hold a
dependency version pz itself doesn't ship, without any of that touching the host process. It is
also what a connector you write yourself has to speak, unless you're contributing it directly
into the `pz` binary. See [Author a connector](/how-to/author-a-connector/) to build one, and
[Connector architecture](/internals/connector-architecture/) for the protocol and hosting model
in full.

### Two data-movement tiers

For every read or write, the planner picks between two tiers: the native tier, where the
connector hands DuckDB a scan or copy statement and DuckDB moves the bytes directly with no
detour through pz, and the universal tier, where the connector streams Arrow record batches that
pz relays into or out of the staging database. Native is faster and is what most connectors
prefer; the universal tier exists for anything a native scan or copy can't express, such as an
HTTP API's paginated response. `engine.force_universal` in `project.yml` forces every entity onto the universal tier
project-wide, overriding the planner's own choice. A connector that only implements the native
tier, `mysql` and `sqlite` today, refuses a universal-only entity with `PZ0312` instead of
pretending to support it. A native scan that needs an unsigned, packaged DuckDB extension is also
refused by default; setting `allow_unsigned_extensions: true` on that connection opts it back in.

### Capabilities

A connector declares a fixed set of capabilities: flags like whether it supports a merge write,
whether its commit is transactional, whether it can honor a bounded incremental window, or resume
a partially delivered write. The planner reads these declarations, not the connector's code, to
decide whether an entity's declared options are legal before any node runs, refusing a `merge`
write on a connector with no merge capability rather than discovering that at write time. See the
[connector matrix](/connectors/) for what each builtin connector declares, and
[Delivery guarantees](/concepts/delivery-guarantees/) for what several of those capabilities mean
for a run that fails partway through.

### Inspecting and testing connectors

`pz connectors` lists every connector registered to the current project, builtin and restored,
with its capabilities and tiers:

```console
$ pz connectors
```

`pz connector test` runs black-box protocol conformance checks against a connector package
directly, independent of any project, useful while developing one:

```console
$ pz connector test ./dist/my-connector --config probe.yml
```

## Example

Declaring a database as a read-and-write connection needs nothing beyond naming the connector and
its credentials:

```yaml title="connections.yml"
mart:
  connector: postgres
  host: ${MART_PG_HOST}
  database: mart
  user: ${MART_PG_USER}
  password: ${MART_PG_PASSWORD}
  entities:
    public.orders_current:
      write:
        strategy: merge
        keys: [order_id]
```

Nothing here says which tier the write uses or what `merge` requires: `postgres` declares both
the `Merge` and `NativeCopy` capabilities, so the planner resolves the rest on its own.

## Related

- [Connector matrix](/connectors/): every builtin connector's read, write, and capability support at a glance.
- [Author a connector](/how-to/author-a-connector/): write, package, and test a connector of your own.
- [Connector architecture](/internals/connector-architecture/): the PCP protocol, hosting model, and ABI, for contributors.
- [Delivery guarantees](/concepts/delivery-guarantees/): what a connector's capabilities promise when a run fails partway through.
- [connections.yml reference](/reference/connections-yml/): the keys every connector shares, and where connector-specific options live.
