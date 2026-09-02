---
title: "SQLite"
description: "Reference for the sqlite connector, which reads and writes a SQLite database file entirely through DuckDB's native sqlite extension."
sidebar:
  order: 6
---

The `sqlite` connector reads and writes a SQLite database file through DuckDB's own `sqlite`
extension. Reads are self-contained `sqlite_scan('path', 'table')` native scans, and writes are
native insert/replace copies through a single attach. There is no server and no credential: the
connection is a file path, and the connector runs on the native tier only.

## Connection

```yaml title="connections.yml"
local:
  connector: sqlite
  path: data/app.db
```

| Key | Required | Default | Meaning |
|---|---|---|---|
| `path` | Yes | – | Path to the SQLite database file. Relative paths resolve against the project directory. |

`path` is the only connection key. There is no `base_dir` option: relative-path resolution against
the project directory happens internally, and setting it in `connections.yml` is not supported.

## Read options

| Key | Required | Default | Meaning |
|---|---|---|---|
| `columns` | No | – | Column name to type map, when you want to declare one. |

There is no `query:` option: the upstream DuckDB `sqlite_query` table function this would need is
not usable for this connector's purposes, so every read names a table by entity.

`sync` and `retry` under `read:` are the shared keys documented in the
[connections.yml reference](/reference/connections-yml/); `rate_limit` belongs on the connection.

## Write options

`sqlite` takes no connector-specific write options. It supports `strategy: append` (a
create-if-not-exists plus insert batch) and `strategy: replace` (a single
`CREATE OR REPLACE TABLE … AS`). There is no `strategy: merge` and no CDC: `sqlite` declares
neither a `Merge` nor a `ChangeCapture` capability.

`strategy`, `schema_policy`, and `retry` under `write:` are the shared keys documented in the
[connections.yml reference](/reference/connections-yml/).

## Capabilities

| Flag | Meaning |
|---|---|
| `NativeScan` | Reads compile to a `sqlite_scan('path', 'table')` fragment. |
| `NativeCopy` | Writes compile to a native insert or create-or-replace copy through one attach. |
| `ReplaceWrites` | Supports `strategy: replace`. |
| `BoundedWindow` | Pushes a watermark upper bound into the generated query. |
| `InclusiveWatermarkBound` | Accepts an inclusive lower watermark bound (`cursor >= value`). |

## Notes

- `sqlite` is native-only. Declaring `engine.force_universal` on a `sqlite` entity fails at plan
  time with [`PZ0312`](/reference/error-codes/); remove that setting instead.
- `pz validate --connect` checks the file for the real SQLite header magic, not a network probe.
  A missing file is reported as will-be-created rather than an error; a missing parent directory
  is a permanent failure, since SQLite will not create directories for you.

## Related

- [connections.yml reference](/reference/connections-yml/) documents the shared read and write keys.
- [Incremental loads](/concepts/incremental-loads/) explains watermarks and bounded windows.
- [Error codes](/reference/error-codes/) looks up `PZ0312` and every other code by number.
- [Connectors](/connectors/) compares every builtin connector's capabilities at a glance.
