---
title: "Local files"
description: "Reference for the localfiles connector, which reads and writes csv, tsv, parquet, and json files on the local filesystem."
sidebar:
  order: 2
---

The `localfiles` connector reads and writes csv, tsv, parquet, and json (NDJSON) files on disk,
resolved relative to the project directory. It runs on the native DuckDB tier in both directions:
reads compile to `read_csv`/`read_parquet`/`read_json` (tsv shares `read_csv`, tab-delimited), and
writes compile to `COPY … TO`.

## Connection

```yaml title="connections.yml"
raw:
  connector: localfiles
  entities:
    customers:
      read:
        path: data/customers.csv
        format: csv
        columns:
          id: bigint
          email: varchar

lake:
  connector: localfiles
  root: out
```

| Key | Required | Default | Meaning |
|---|---|---|---|
| `root` | No | the project directory | Base directory every relative `path` in this connection's entities resolves against. |

`root` is the only user-facing connection option. There is no host, credential, or port: the
[entity](/concepts/key-concepts/) is a file, and the connection is where its files live.

## Read options

| Key | Required | Default | Meaning |
|---|---|---|---|
| `format` | No | `csv` | `csv`, `tsv`, `parquet`, or `json` (NDJSON). |
| `path` | No | `<entity>.<format>` | File or glob path, relative to `root`. |
| `columns` | Conditional | – | Column name to type map. Required for csv/tsv on the universal tier; required for json only when `pz validate --connect` needs to fetch a schema. Parquet infers its schema from the file footer and never needs it. |
| `delimiter` | No | `,` | csv only, one ASCII character other than a quote, newline, or carriage return. tsv is fixed to tab; setting `delimiter` on it is `PZ0362`. |
| `layout` | No | `ndjson` | json only. `ndjson` (newline-delimited) or `array` (one top-level JSON array). `array` works on the native tier; a read forced onto the universal tier (`engine.force_universal`) refuses it with `PZ0361`. |

The shared keys `columns`, `sync`, and `retry` under `read:` work the same for every connector.
`rate_limit` belongs on the connection, not under `read:`. See the
[connections.yml reference](/reference/connections-yml/) for all of them.

## Write options

| Key | Required | Default | Meaning |
|---|---|---|---|
| `format` | No | `parquet` | `csv`, `tsv`, `parquet`, or `json`. |
| `path` | No | a directory named after the entity | Output location, relative to `root`. |
| `delimiter` | No | `,` | csv only, one ASCII character other than a quote, newline, or carriage return. tsv is fixed to tab; setting `delimiter` on it is `PZ0362`. |
| `layout` | No | `ndjson` | json only. `ndjson` (newline-delimited) or `array` (one top-level JSON array). `array` works on the native `COPY` path; a write forced onto the managed writer (`engine.force_universal` or `partition_by`) refuses it with `PZ0361`. |

`localfiles` supports `strategy: append` and `strategy: replace`. It has no `Merge` capability, so
`strategy: merge` fails at compile time. `strategy`, `keys`, `schema_policy`, and `retry` under
`write:` are the same shared keys documented in the
[connections.yml reference](/reference/connections-yml/).

## Capabilities

| Flag | Meaning |
|---|---|
| `NativeScan` | Reads compile to a DuckDB `read_csv`/`read_parquet`/`read_json` call. |
| `NativeCopy` | Writes compile to a DuckDB `COPY … TO` statement. |
| `ReplaceWrites` | Supports `strategy: replace`. |
| `BoundedWindow` | Pushes a watermark upper bound into the native scan for incremental reads. |
| `PartitionedRead` | A large csv file may split into more than one partition for parallel reads. |

## Notes

- CSV needs a declared `columns:` contract only when `engine.force_universal` forces the universal
  tier; the native tier infers csv columns from the header when none is declared.
- On the universal tier, csv reads parse with the resolved `delimiter` (comma by default) instead
  of auto-detecting it — a semicolon-delimited file labelled `format: csv` needs
  `delimiter: ";"`. A non-comma delimiter also disables csv split-partitioning: a large file reads
  as a single partition instead of splitting across `PartitionedRead`.
- `strategy: merge` is refused: `localfiles` has no keyed upsert, since files have no primary key.
- An absolute `path` on an entity ignores the connection's `root` entirely.

## Related

- [Connections and entities](/concepts/connections-and-entities/) explains the `read:`/`write:` shape this page assumes.
- [connections.yml reference](/reference/connections-yml/) documents the shared keys every connector accepts.
- [Incremental loads](/concepts/incremental-loads/) covers watermarks and `BoundedWindow` in depth.
- [Connectors](/connectors/) lists every builtin connector and its capabilities side by side.
