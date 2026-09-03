---
title: "Connectors"
description: "A capability matrix for the fourteen builtin pz connectors, plus how to add a third-party connector and test a connection."
sidebar:
  order: 1
---

A [connector](/concepts/connectors/) is the code that reads or writes one kind of place: a
database, an object store, a filesystem, or an API. `pz` ships fourteen builtin connectors, and every
one of them can act as a read connection, a write connection, or both in the same project.

## Capability matrix

"Native DuckDB tier" means the connector can hand DuckDB a native scan or copy instead of
streaming rows through Arrow. "Incremental" and "CDC" name the capability flags that gate a
windowed read or a change-capture read. "Merge" names keyed upsert writes.

| Connector | Read | Write | Native DuckDB tier | Incremental | CDC | Merge | Formats |
|---|---|---|---|---|---|---|---|
| [localfiles](/connectors/localfiles/) | ✓ | ✓ | ✓ | ✓ | – | – | csv, parquet, json |
| [postgres](/connectors/postgres/) | ✓ | ✓ | – | ✓ | ✓ | ✓ | – |
| [sqlserver](/connectors/sqlserver/) | ✓ | ✓ | – | ✓ | ✓ | ✓ | – |
| [mysql](/connectors/mysql/) | ✓ | ✓ | ✓ | ✓ | – | – | – |
| [sqlite](/connectors/sqlite/) | ✓ | ✓ | ✓ | ✓ | – | – | – |
| [duckdb](/connectors/duckdb/) | ✓ | ✓ | ✓ | ✓ | – | ✓ | – |
| [ducklake](/connectors/ducklake/) | ✓ | ✓ | ✓ | ✓ | – | ✓ | – |
| [motherduck](/connectors/motherduck/) | ✓ | ✓ | ✓ | ✓ | – | ✓ | – |
| [quack](/connectors/quack/) | ✓ | ✓ | ✓ | ✓ | – | ✓ | – |
| [s3](/connectors/s3/) | ✓ | ✓ | ✓ | ✓ | – | – | csv, parquet, json |
| [azureblob](/connectors/azureblob/) | ✓ | ✓ | ✓ | ✓ | – | – | csv, parquet, json |
| [gcs](/connectors/gcs/) | ✓ | ✓ | ✓ | ✓ | – | – | csv, parquet, json |
| [sftp](/connectors/sftp/) | ✓ | ✓ | – | ✓ | – | – | csv, parquet, json |
| [http](/connectors/http/) | ✓ | ✓ | – | ✓ | – | ✓ | json |

:::note
`gcs` reads natively only under `hmac` credentials. `service_account` and `adc` auth write but do
not read.
:::

Database connectors have no file format: `postgres`, `sqlserver`, `mysql`, `sqlite`, `duckdb`,
`ducklake`, `motherduck`, and `quack` move rows, not files. `mysql`, `sqlite`, and the four
DuckDB-family connectors (`duckdb`, `ducklake`, `motherduck`, `quack`) run on the native tier
only, so declaring `engine.force_universal` for one of their entities fails with
[`PZ0312`](/reference/error-codes/). `quack`'s merge is a whole-table rewrite rather than a keyed
upsert; its page explains what that costs.

## Third-party connectors

A connector that does not ship with `pz` is a NuGet package, declared in `project.yml` under
`connectors:`:

```yaml title="project.yml"
connectors:
  - package: Some.Connector.Package
    version: 1.0.0
```

`pz restore` resolves every declared package against the configured feeds (`--feeds`, else
`PZ_FEEDS`, else nuget.org), downloads it under `.pz/packages`, and writes `pz.lock.json` so every
machine restores the exact same version. A restored connector runs out-of-process, the same
isolation boundary a builtin connector runs inside. See
[Connectors: the plugin architecture](/concepts/connectors/) for how that isolation works, and
[Author a connector](/how-to/author-a-connector/) to write your own.

## Test a connection

`pz validate --connect` is how you check that a connection in `connections.yml` is actually
reachable. It runs the full config and SQL validation, then probes live connectivity and schema
drift for every declared entity:

```sh
pz validate --connect
```

If you are building a third-party connector instead, `pz connector test <target>` runs black-box
protocol conformance checks against its package directory or entrypoint binary, using a `--config`
file that names the connection and the `read:`/`write:` entities to probe:

```sh
pz connector test ./dist/my-connector --config test-config.yml
```

## Related

- [Connectors: the plugin architecture](/concepts/connectors/) explains hosting, isolation, and the ABI a connector implements.
- [Author a connector](/how-to/author-a-connector/) walks through writing and packaging a new one.
- [connections.yml reference](/reference/connections-yml/) covers the reserved keys every connector shares.
- [Error codes](/reference/error-codes/) looks up `PZ0312` and every other code by number.
- [Key concepts](/concepts/key-concepts/) defines connection, entity, and connector before you dive into the tables above.
