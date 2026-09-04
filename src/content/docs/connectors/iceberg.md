---
title: "Apache Iceberg"
description: "Reference for the iceberg connector: the four catalogs (rest, glue, s3_tables, files) and their keys, optional S3 or Azure storage credentials, namespace rules, time-travel reads, and the write-mode snapshot semantics."
sidebar:
  order: 11
---

The `iceberg` connector reads and writes Apache Iceberg tables through DuckDB's own `iceberg`
extension, which is the entire data plane: the engine's session attaches the catalog once per
connection, and every read and write is a plain SQL statement against that attach. The connector
ships no drivers of its own — it generates SQL over an Iceberg *catalog* (a REST catalog, AWS
Glue, Amazon S3 Tables, or no catalog at all, for reading table directories straight from
storage) and the object store where the tables' Parquet and metadata files live. The connector
runs on the native tier only, for both reads and writes: there is no universal-tier fallback.

## Connection

Every connection names a `catalog` (defaults to `rest`). A key that belongs to a different
catalog, or a key a catalog neither requires nor accepts, is refused with an error naming the
catalog it belongs to; validation reports every such error at once.

| `catalog` | Required keys | Forbids |
|---|---|---|
| `rest` (default) | `endpoint` | `root` |
| `glue` | – | `endpoint`, `root`, every `rest` credential key |
| `s3_tables` | `warehouse` | `endpoint`, `root`, every `rest` credential key |
| `files` | `root` | `endpoint`, `warehouse`, `nested_namespaces`, every `rest` credential key |

### `rest` — an Iceberg REST catalog

```yaml title="connections.yml"
lake:
  connector: iceberg
  catalog: rest                        # optional — this is the default
  endpoint: https://catalog.example.com/api
  warehouse: my_warehouse              # optional — a NAME or an id, never a URL
  token: ${LAKE_TOKEN}
```

```yaml title="connections.yml"
lake:
  connector: iceberg
  catalog: rest
  endpoint: https://catalog.example.com/api
  client_id: ${LAKE_CLIENT_ID}
  client_secret: ${LAKE_CLIENT_SECRET}
  oauth2_server_uri: https://catalog.example.com/api/v1/oauth/tokens   # optional
  oauth2_scope: PRINCIPAL_ROLE:ALL                                    # optional
  nested_namespaces: false             # optional — set true for catalogs that nest namespaces
```

`endpoint` must be an `http://`/`https://` URL. Authentication is a bearer `token` **or** a
`client_id`/`client_secret` pair, never both; `oauth2_server_uri` and `oauth2_scope` tune the
pair and mean nothing without it. Declaring neither attaches unauthenticated
(`authorization_type 'none'`, the right thing for a local development catalog). `warehouse` is
whatever the catalog wants in the attach string — a Polaris catalog name, an R2 warehouse id, a
Lakekeeper warehouse name — and validation refuses a URL-shaped value, since DuckDB would attach
it read-only. Any of Polaris, Lakekeeper, Nessie, Cloudflare R2, Unity Catalog, Google BigLake, or
the Apache REST fixture is a `rest` catalog.

### `glue` — AWS Glue

```yaml title="connections.yml"
lake:
  connector: iceberg
  catalog: glue
  warehouse: "123456789012:my_catalog"   # optional — ':' (the caller's default catalog) when omitted
  storage_region: eu-central-1           # optional — defaults to us-east-1
```

Signs with the ambient AWS credential chain (environment, profile, instance role) unless
`storage_key_id`/`storage_secret_key` are declared. `warehouse` accepts `:`, an account id,
`account_id:catalog`, `catalog/sub_catalog`, or `account_id:catalog/sub_catalog`.

### `s3_tables` — Amazon S3 Tables

```yaml title="connections.yml"
lake:
  connector: iceberg
  catalog: s3_tables
  warehouse: "arn:aws:s3tables:us-east-1:123456789012:bucket/my-table-bucket"   # required
```

Requires `warehouse` (the table bucket ARN). Same credential rule as `glue`.

### `files` — no catalog: table directories under a root (read-only)

```yaml title="connections.yml"
lake:
  connector: iceberg
  catalog: files
  root: "s3://my-bucket/warehouse/"      # required — a local directory or an object-store URL
```

Every read is `iceberg_scan('<root>/<namespace>/<table>', allow_moved_paths = true)`. There is
nothing to commit a write to, so a `files` connection used as a sink is refused at plan time
(`PZ0353`). A table without a `version-hint.text` file — every table a REST catalog wrote — needs
the dataset option `metadata_version:` naming the metadata file to read.

### Optional: S3-compatible storage credentials

```yaml title="connections.yml"
lake:
  connector: iceberg
  catalog: rest
  endpoint: http://minio-catalog:8181
  warehouse: dev
  storage_key_id: ${LAKE_S3_KEY}
  storage_secret_key: ${LAKE_S3_SECRET}
  storage_region: us-east-1              # optional — defaults to us-east-1
  storage_endpoint: minio.internal:9000  # optional — for an S3-compatible endpoint
  storage_url_style: path                # optional — "vhost" (default) or "path"
  storage_use_ssl: false                 # optional — defaults to true
```

`storage_key_id` and `storage_secret_key` are declared together on any catalog; `storage_endpoint`/
`storage_url_style`/`storage_use_ssl` require the pair (`storage_region` stands alone). On a
`files` connection they build a `type s3` secret scoped to that root, so the credentials apply to
that root's tables only. On a catalog connection the secret is unscoped, since the catalog hands
out each table's location. On a `rest` catalog, declaring them also switches credential vending
off (`access_delegation_mode 'none'`): the keys are the data-plane credential themselves. Without
them, a REST catalog is expected to vend storage credentials (Polaris, S3 Tables, Glue, and R2 all
do).

### Optional: Azure storage (`storage: azure`)

```yaml title="connections.yml"
lake:
  connector: iceberg
  catalog: rest
  endpoint: https://lakekeeper.internal/catalog
  warehouse: adls-wh                     # a NAME, as for every catalog
  token: ${LAKE_TOKEN}
  storage: azure                         # the tables' data files live on Azure Blob / ADLS Gen2
  storage_auth: service_principal        # or connection_string | account_key | credential_chain
  storage_tenant_id: ${AZ_TENANT}
  storage_client_id: ${AZ_CLIENT}
  storage_client_secret: ${AZ_SECRET}
  storage_account_name: mylakeaccount

raw:
  connector: iceberg
  catalog: files
  root: "abfss://lake@mylakeaccount.dfs.core.windows.net/warehouse/"   # az://, azure:// or abfss://
  storage_auth: credential_chain         # storage: azure is inferred from the root's scheme
  storage_account_name: mylakeaccount
  storage_chain: cli;env                 # optional
```

`storage` selects the key family: `s3` (the default, the keys above) or `azure`. Under `azure`
the keys mirror the azureblob connector's `auth` methods field-for-field, prefixed `storage_`
because `client_id`/`client_secret` already name a REST catalog's OAuth2 pair here:

| `storage_auth` | required | optional |
|---|---|---|
| `connection_string` | `storage_connection_string` | — |
| `account_key` | `storage_account_name`, `storage_account_key` | `storage_endpoint` (a custom Blob endpoint, e.g. Azurite) |
| `service_principal` | `storage_tenant_id`, `storage_client_id`, `storage_client_secret`, `storage_account_name` | — |
| `credential_chain` | `storage_account_name` | `storage_chain` (e.g. `cli;env`; managed identity is a link in the chain) |

Every S3 key is refused under `azure` and every Azure key under `s3`; `storage: azure` is refused
on `glue`/`s3_tables`. A `files` root with an Azure scheme infers `storage: azure` and needs a
`storage_auth` (nothing vends credentials for a bare root); a `rest` catalog may omit
`storage_auth`, in which case the catalog is expected to vend Azure SAS credentials. The
connection loads DuckDB's `azure` extension and, when a method is declared, builds a `type azure`
secret — scoped to a `files` root, unscoped on a catalog — and switches the REST catalog's
credential vending off exactly as explicit S3 keys do.

**Status of writes on Azure.** The `azure` extension DuckDB 1.5.5 installs implements the
directory and write operations the iceberg extension's insert needs, but DuckDB's own
documentation still lists REST catalogs as supported on S3, S3 Tables and GCS only, and no local
emulator can host an Azure-backed catalog (Azurite has no ADLS/DFS endpoint). This connector's CI
therefore proves `files` reads over `az://` (Azurite) and ships REST writes on Azure as
extension-supported but unproven, run only when a real catalog's endpoint is supplied through
environment variables.

### Entities and namespaces

The entity is `namespace.table` — an Iceberg table always lives in a namespace, so a bare `table`
is refused on a catalog connection (a `files` entity may be bare: a table directory directly under
`root`). Nested namespaces (`a.b.table`) are not supported. The namespace **`main`** cannot be
addressed: DuckDB's binder reserves that name for its own default schema, so the connector refuses
it up front rather than letting the read fail with a misleading "schema not found". A relative
local `root` resolves against the project directory and may not resolve inside the project's
`.pz/` directory. Under `pz mcp`, a local `root:` that resolves outside the project directory is
refused with `PZ0606`; an object-store `root` (any value containing `://`) is skipped by that
guard.

## Reading data

```yaml title="connections.yml"
lake:
  connector: iceberg
  endpoint: https://catalog.example.com/api
  token: ${LAKE_TOKEN}
  entities:
    raw.events:
      read:
        columns: { id: bigint, updated_at: timestamp, amount: double }
        sync: { mode: incremental, cursor: updated_at }
    raw.snapshot_events:
      read:
        columns: { id: bigint, updated_at: timestamp }
        version: 4830783628919130688    # a snapshot id — or timestamp: "...", never both
```

A declared `columns:` contract prunes the read to only the declared columns. A contract-less read
takes the table as the catalog declares it, but also means `pz validate --connect` cannot probe a
schema for that dataset — there is no offline driver to ask, so the contract *is* the schema. The
plain incremental watermark is pushed into the generated `where` clause; the windowed pair
(`initial`/`max_window`/`until`) is applied the same way.

**Time travel**: a dataset may declare `version:` (a snapshot id) or `timestamp:` (the snapshot
current at an instant), never both — declaring both fails at plan time. A **`files`** read is
`iceberg_scan(...)`, where `version:` maps to `snapshot_from_id`, `timestamp:` to
`snapshot_from_timestamp`, and `metadata_version:` to `version` (the metadata file to start from,
e.g. `00003-<uuid>`); `metadata_version` is refused on a catalog connection, where the catalog
resolves the current metadata itself.

`sync` and `retry` under `read:` are the shared keys documented in the
[connections.yml reference](/reference/connections-yml/).

## Writing data

One read-write attach per connection, shared by every read and write against it. Every mode first
ensures the namespace (`create schema if not exists`) and creates the target from the staged shape
so a first run needs no pre-created namespace or table. Then:

| Strategy | What runs |
|---|---|
| `append` | `insert into … select * from {{source}};` — one `append` snapshot. An incremental source feeding an append sink still needs `write: { duplicates: accept }` (`PZ0214`). |
| `replace` | `begin transaction; delete from …; insert into … select * from {{source}}; commit;` |
| `merge` | `merge into … using (… qualify row_number() over (partition by <keys>) = 1) … when matched then update when not matched then insert;` |

`replace` always commits **two** new snapshots, a `delete` immediately followed by an `append` —
DuckDB's iceberg extension commits one snapshot per DML statement, and there is no single-snapshot
`overwrite` it can be asked for. What the wrapping transaction buys instead: neither snapshot
reaches the catalog until `commit`, so a concurrent reader sees the old rows and no new snapshot
right up to that instant, then both the delete and the append snapshot at once — never an empty
table, never one without the other. The table keeps its identity and history either way (there is
no `CREATE OR REPLACE`, and a drop-and-recreate would discard every earlier snapshot). The delete
is merge-on-read (positional delete files), so a table replaced many times benefits from the
catalog's compaction and maintenance.

`merge` requires at least one declared key column, refused at compile time otherwise. The staged
side is deduplicated first (one connector-determined survivor per key) because DuckDB's `MERGE
INTO` matches every source row independently against the pre-statement target, so duplicate keys
the target lacks would otherwise all insert; the engine warns with [`PZ0522`](/reference/error-codes/)
when a batch carried duplicates.

A `files` connection cannot write: only a catalog can commit new table metadata.

`strategy`, `keys`, `schema_policy`, and `retry` under `write:` are the shared keys documented in
the [connections.yml reference](/reference/connections-yml/).

## Capabilities

| Flag | Meaning |
|---|---|
| `NativeScan` | Every read is a scan fragment over the attach alias (or an `iceberg_scan` call for a `files` connection). |
| `NativeCopy` | Every write is native SQL against the same attach alias. |
| `ReplaceWrites` | Supports `strategy: replace`. |
| `Merge` | Supports `strategy: merge` through DuckDB's own `MERGE INTO`. |
| `Transactional` | A replace's delete and insert land together or not at all, even though the extension still records them as two snapshots. |
| `BoundedWindow` | Pushes a watermark upper bound into the generated query. |
| `InclusiveWatermarkBound` | Accepts an inclusive lower watermark bound (`cursor >= value`). |

## `pz validate --connect` behaviour

Zero drivers, so the check per catalog is necessarily shallow — credentials are exercised only by
the first run's attach:

| Catalog | Check |
|---|---|
| `rest` | TCP reachability to the `endpoint` host/port only, with a five-second timeout. Credentials are verified at run time. |
| `glue`, `s3_tables` | Not checked. An AWS catalog has no offline probe; the first run authenticates. |
| `files` | A local `root` directory must exist (reads cannot create it). An object-store `root` is not checked. |

The schema precheck works only for datasets with a declared `columns:` contract; contract-less
datasets get a clear refusal. Plain `pz validate`, `pz run`, and the `on_source_drift` gate
(which baselines from the staged `describe`) are unaffected.

## Notes

- `iceberg` is native-only. Declaring `engine.force_universal` on an `iceberg` entity fails at
  plan time; remove that setting instead.
- **Credentials never ride the attach string.** A bearer token or OAuth2 client pair builds a
  `type iceberg` DuckDB secret the attach references by name; AWS catalogs sign with a `type s3`
  secret (explicit keys, or `provider credential_chain`); storage keys build a `type s3` secret
  scoped as described above, or a `type azure` secret under `storage: azure`. A failed attach
  echoes only the warehouse and the endpoint, never a credential.
- **First use needs network access** to install the DuckDB `iceberg` and `httpfs` extensions (and
  `aws` for a credential-chain AWS catalog); the extension repository is consulted only when an
  extension is not yet installed.
- **Setup statements run once per run**, shared by every node that needs the same extension load,
  secret, or attach; a node retry re-issues a statement that failed.
- **A catalog and a `files` connection may point at the same warehouse**, but they get separate
  aliases and separately scoped secrets — reading a table through `files` right after the catalog
  wrote it needs the newest `metadata_version:`, since a `files` read never consults the catalog.

| Code | When |
|---|---|
| [`PZ0209`](/reference/error-codes/) | A `strategy: merge` write declares no `keys:`. |
| [`PZ0214`](/reference/error-codes/) | An incremental read feeds a `strategy: append` write without `duplicates: accept`. |
| [`PZ0311`](/reference/error-codes/) | A setup statement failed at run time: a secret, a session setting, or the attach. Redacted — never a credential. |
| [`PZ0312`](/reference/error-codes/) | `engine.force_universal` is set on an `iceberg` entity, on either direction. |
| [`PZ0324`](/reference/error-codes/) | A write declares a `strategy` the connector does not support. |
| [`PZ0353`](/reference/error-codes/) | A `files` connection is used as a sink, or a `files` read names a table directory that does not exist. |
| [`PZ0522`](/reference/error-codes/) | A `strategy: merge` write's staged input holds duplicate merge-key groups, which collapse to one survivor. |
| [`PZ0606`](/reference/error-codes/) | Under `pz mcp`, a local `root` resolves outside the project directory. |

## Related

- [DuckLake](/connectors/ducklake/) is the closest sibling: another catalog-plus-Parquet
  lakehouse, native-only, with the same time-travel and transactional-replace shape.
- [Delivery guarantees](/concepts/delivery-guarantees/) explains what `merge` and `replace`
  promise on retry.
- [Secure connection config](/how-to/secure-connection-config/) covers keeping catalog and storage
  credentials out of the repository.
- [Connectors](/connectors/) compares every builtin connector's capabilities at a glance.
- DuckDB's [`iceberg` extension docs](https://duckdb.org/docs/extensions/iceberg/overview) cover
  the SQL surface this connector generates.
