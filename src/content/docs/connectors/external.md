---
title: "External connectors"
description: "First-party connectors the PipelineZ org publishes outside the pz binary, at a secondary support tier: what that tier means, and the bigquery, databricks, deltalake, elasticsearch, github, kafka, mongodb, and snowflake connectors it covers today."
sidebar:
  order: 17
---

pz connectors come in three tiers, the same shape DuckDB gives its extensions:

| Tier | Who maintains it | Where it ships | Support |
|---|---|---|---|
| **Builtin** | PipelineZ | inside the `pz` binary | primary: released with `pz`, gated by `pz`'s own CI |
| **External** (this page) | PipelineZ | a `Pz.Connector.*` NuGet package from a `pz-connector-*` repo under the [PipelineZ org](https://github.com/PipelineZ) | secondary: first-party code, own release cadence, coverage as its README states |
| **Third-party** | anyone | any NuGet package | none from PipelineZ |

The connectors below are **first-party, not third-party**. They are written, tested, and released
by the same people who build `pz`, and held to the same bar as a builtin: the same
[`Pz.Connectors.Abstractions`](/how-to/author-a-connector/) ABI, the same
[`Pz.Connectors.TestKit`](/how-to/author-a-connector/) acceptance suite every builtin runs
against, the same error-code and redaction rules. They live outside the binary because their
dependencies (a Rust runtime, a proprietary driver, a 35 MB client stack) don't belong in it, and
that is the whole of what makes their support **secondary** rather than primary:

- **Own versions, own cadence.** Each repo tags and publishes on its own schedule, pinned to a
  `Pz.Connectors.Sdk` version rather than to a `pz` release. A `pz` release does not wait for them.
- **Coverage is what the README says.** Each connector states which backends and platforms its
  own test suite has actually talked to, and which are merely shipped. Read that before depending
  on an untested path.
- **Fixes land there, not in `pz`.** Issues go to the connector's own repo; an SDK-level fix in
  `pz` reaches you when the connector re-releases against it.

Everything on this page is built on [`Pz.Connectors.Sdk`](/how-to/author-a-connector/) and
ships a `runtime: "process"` manifest: pz spawns the self-contained binary the package carries
for your platform and talks to it over PCP, so each needs **pz 0.5.1 or newer**. Releases of
deltalake and snowflake before 0.2.0 were in-process packages, which `PZ0360` refuses; pin 0.2.0
or later.

A third-party connector that is not on this page may be perfectly good; it just isn't something
PipelineZ has tested or will support. To get a connector onto this page, open an issue in
[`pz`](https://github.com/PipelineZ/pz) proposing it move under the org.

## Capability matrix

Same columns as the [builtin matrix](/connectors/#capability-matrix): "Native DuckDB tier" means at
least one direction hands DuckDB a native scan or copy instead of streaming through Arrow.

| Connector | Package | Read | Write | Native DuckDB tier | Incremental | CDC | Merge |
|---|---|---|---|---|---|---|---|
| [bigquery](https://github.com/PipelineZ/pz-connector-bigquery) | `Pz.Connector.BigQuery` | ✓ | ✓ | – | ✓ | – | ✓ |
| [databricks](https://github.com/PipelineZ/pz-connector-databricks) | `Pz.Connector.Databricks` | ✓ | ✓ | – | ✓ | – | ✓ |
| [deltalake](https://github.com/PipelineZ/pz-connector-deltalake) | `Pz.Connector.DeltaLake` | ✓ | ✓ | ✓ (read only) | ✓ | – | ✓ |
| [elasticsearch](https://github.com/PipelineZ/pz-connector-elasticsearch) | `Pz.Connector.Elasticsearch` | ✓ | ✓ | – | ✓ | – | ✓ |
| [github](https://github.com/PipelineZ/pz-connector-github) | `Pz.Connector.Github` | ✓ | – | – | ✓ | – | – |
| [kafka](https://github.com/PipelineZ/pz-connector-kafka) | `Pz.Connector.Kafka` | ✓ | ✓ | – | ✓ | – | – |
| [mongodb](https://github.com/PipelineZ/pz-connector-mongodb) | `Pz.Connector.MongoDb` | ✓ | ✓ | – | ✓ | – | ✓ |
| [snowflake](https://github.com/PipelineZ/pz-connector-snowflake) | `Pz.Connector.Snowflake` | ✓ | ✓ | – | ✓ | – | ✓ |

## bigquery

A table reads through the Storage Read API as Arrow: column pruning and predicate pushdown become
`selected_fields` and `row_restriction`, an incremental cursor (`cursor > watermark`) and a bounded
window are pushed the same way, and `streams:` splits one read into parallel partitions. `query:`
reads any GoogleSQL statement by materializing it into a short-lived table in `staging_dataset`
first, since the Storage API serves tables, not queries. The sink is BigQuery's own load path: rows
spool to NDJSON, load jobs land them in an expiring staging table, and one statement on the target
finishes the commit — `append` (insert), `replace` (`WRITE_TRUNCATE`), or `merge` (a `MERGE` with
last-write-wins on the session's own sequence and null-safe keys). Auth is a service-account key
(`key_file`/`key_json`) or Application Default Credentials.

```yaml title="project.yml"
connectors:
  - package: Pz.Connector.BigQuery
    version: 0.1.0
```

**Before you install it:** views are refused on read — point `query:` at them instead. a `BIGNUMERIC`
column cannot land as-is (DuckDB has no decimal256) — read it through `query:` with a cast. Writes need `bigquery.dataEditor` and
`bigquery.jobUser`; reads need `bigquery.dataViewer` and `bigquery.readSessionUser`. `schema_policy:
evolve` is not supported. Merge and replace, multi-stream reads, and view refusal are exercised
against real BigQuery only by an env-gated live suite (the emulator its CI runs cannot do them), so
watch those paths on your first run. The package is Native AOT and ships `linux-x64`, `linux-arm64`,
`osx-arm64`, and `win-x64`, but only `linux-x64` has actually been exercised by its own CI. See its
[README](https://github.com/PipelineZ/pz-connector-bigquery#readme) for the type tables, the error
codes, and the emulator setup.

## databricks

Reads run on a SQL warehouse through the Statement Execution API and come back as Arrow over
presigned links: every result chunk is one partition, column pruning and a predicate become the
statement's `select` list and `where` clause, and an incremental cursor's bounds travel as typed
statement parameters rather than literals. `query:` runs any Databricks SQL statement as written.
`ARRAY`/`MAP`/`STRUCT` and `INTERVAL` columns land as strings (`to_json` / `cast` in the statement)
so the schema the probe declares is the schema the batches carry. The sink spools rows to Parquet,
uploads the files to a Unity Catalog volume with the Files API, and finishes with one statement on
the target — `append` (`insert … select from parquet.`…``), `replace` (`create or replace table … as
select`), or `merge` (null-safe keys, last write wins on the session's own sequence). Decimals and
timezone-less timestamps are staged as strings and cast back, so nothing is rounded on the way in.
Auth is a personal access token or a service principal's OAuth client credentials.

```yaml title="project.yml"
connectors:
  - package: Pz.Connector.Databricks
    version: 0.1.0
```

**Before you install it:** every read and every commit runs statements on the warehouse, billed as
warehouse time, and a stopped serverless warehouse starts on the first one. Writes need
`staging_volume` (a 3-part Unity Catalog volume name) with `READ VOLUME`/`WRITE VOLUME`, plus
`CREATE TABLE`/`MODIFY` on the target schema; reads need `USE CATALOG`/`USE SCHEMA`/`SELECT`, and
everything needs `CAN USE` on the warehouse. `schema_policy: evolve` is refused — the target either
matches or the run fails. A `query:` read is never pushed down or watermarked; declare the cursor in
the SQL itself. See the
[README](https://github.com/PipelineZ/pz-connector-databricks#readme) for the type tables, the error
codes, and the live test setup.

## deltalake

Reads through DuckDB's `delta` extension, so rows never enter .NET on the read side. Writes —
`append`, `replace`, `merge` — go through `delta-rs` instead, on the universal Arrow tier, since
DuckDB has no native Delta write path.

```yaml title="project.yml"
connectors:
  - package: Pz.Connector.DeltaLake
    version: 0.2.0
```

**Before you install it:** it's a 200 MB download — the package ships a Native AOT binary plus
delta-rs's two Rust libraries for each of four platforms, and `pz restore` fetches the whole nupkg
(printing nothing while it does) before materializing only your platform's 150 MB, 138 MB of which
is the Rust pair. And only
`linux-x64` has actually been run against; `linux-arm64`, `osx-arm64`, and `win-x64` are shipped
but never exercised by this connector's own suite, and `osx-x64` is not shipped. See its
[README](https://github.com/PipelineZ/pz-connector-deltalake#readme) for the full platform table,
merge-cost numbers on a partitioned table, and what's proven per backend.

## elasticsearch

An index (alias, or pattern) reads as a table: the mapping is the schema — numerics, booleans and
standard-format dates typed, objects flattened into dotted columns, everything else (`nested`,
`flattened`, geo, vectors, custom date formats) landed as JSON or text — plus a trailing `_id`.
Reads page through a point in time, so a run sees one consistent version of the index; an
incremental cursor (`cursor > watermark`) and a bounded window become a `range` clause alongside
your own `query:` (Query DSL). The sink is `_bulk`: `append`, `merge` (`_id` from the keys, a
full-document upsert), and `replace` — a fresh index swapped in behind the output's alias in one
atomic aliases request.

```yaml title="project.yml"
connectors:
  - package: Pz.Connector.Elasticsearch
    version: 0.1.0
```

**Before you install it:** it targets Elasticsearch 9.x through the official 9.x client — nothing
older is exercised. A field that holds an array where the mapping says scalar fails the read rather
than stringifying silently; list it under `json_fields:` and decode it in SQL. `replace` needs the
output name to be an alias (or absent) — a concrete index of that name is refused, not deleted.
There is no SQL predicate pushdown; `query:` is the explicit lever. The package is Native AOT and
ships `linux-x64`, `linux-arm64`, `osx-arm64`, and `win-x64`, but only `linux-x64` has actually
been exercised by its own CI. See its
[README](https://github.com/PipelineZ/pz-connector-elasticsearch#readme) for the type table,
connection keys, and what's proven.

## github

Source only — reading GitHub's write APIs' side effects and abuse-detection limits into pz's
append/merge/replace vocabulary would be its own design, not a same-repo add-on. Six entities read
as `{owner}/{repo}/{kind}` — `issues`, `pulls`, `issues/comments`, `commits`, `releases`,
`actions/runs` — each a fixed schema (these are API resources, not user tables). Incremental reads
use whichever filter GitHub's own API actually supports per entity: `since=`/`created=` server-side
where available, otherwise (`pulls`, `releases`) a client-side early stop once a page's row falls at
or before the watermark. No third-party GitHub client — a plain `HttpClient` plus source-generated
JSON, kept off the same AOT-compatibility bet the elasticsearch connector above had to route around.

```yaml title="project.yml"
connectors:
  - package: Pz.Connector.Github
    version: 0.1.0
```

**Before you install it:** a run created before the watermark advances past it, but which keeps
updating afterward (`status: in_progress` → `completed`), is not re-read on a later incremental
`actions/runs` sync — its final `status`/`conclusion` can go stale until a `pz run --full-refresh`.
Personal-access-token auth only; no GitHub App / installation tokens. The package is Native AOT and
ships `linux-x64`, `linux-arm64`, `osx-arm64`, and `win-x64`; its own CI runs the full suite against
a fake GitHub server on both Linux and Windows (no docker dependency), but only `linux-x64`'s
packaged binary is smoke-tested end to end. See its
[README](https://github.com/PipelineZ/pz-connector-github#readme) for the full per-entity schema
tables, rate-limit handling, and the enterprise-server (`url:`) connection shape.

## kafka

Reads as an offset-resumed feed source: each partition is bounded at its high watermark as of the
run's start, and the stored offset token picks up from there on the next run. Rows land in a fixed
text envelope — `topic, partition, offset, timestamp, key, value, headers` — with `key` and `value`
as text and `headers` as a JSON object. The sink is append-only produce: whole-row JSON by default,
or a verbatim `value:` column, with optional `key:`/`headers:` columns; the producer is idempotent,
giving at-least-once delivery across runs.

```yaml title="project.yml"
connectors:
  - package: Pz.Connector.Kafka
    version: 0.1.1
```

**Before you install it:** there's no Schema Registry / Avro / Protobuf decoding — `value` arrives
as text, so decode Avro or Protobuf payloads in SQL after landing. A feed source paired with an
`append` output needs `duplicates: accept` (incremental → append is otherwise a compile error,
PZ0214). A stored offset that retention has already dropped fails the run rather than silently
skipping ahead — recover with `--full-refresh` or by clearing the offset through `pz state`. The
package is self-contained rather than Native AOT, since the Kafka client library has no AOT
support; it ships `linux-x64`, `linux-arm64`, `osx-arm64`, and `win-x64`, but only `linux-x64` has
actually been exercised by its own CI. See its
[README](https://github.com/PipelineZ/pz-connector-kafka#readme) for the full platform table and
what's proven per backend.

## mongodb

A collection reads as a table: the columns are either declared under `fields:` (path → type) or
inferred from the first `sample_size` documents in `_id` order — scalars typed, nested documents
flattened into dotted columns, arrays and anything without a scalar spelling landed as canonical
extended JSON, `_id` trailing as its 24-hex ObjectId. An incremental cursor and a bounded window
become a typed `$gt`/`$lte` range on the cursor field, `$and`-ed with your own `filter:` (a MongoDB
query in YAML or extended JSON). The sink is the driver's write path: `append` (ordered
`insertMany`), `merge` (upserting `replaceOne` per row, filter from the keys), and `replace` — a
fresh collection carrying the output's indexes, renamed over the output with `dropTarget` in one
server-side rename.

```yaml title="project.yml"
connectors:
  - package: Pz.Connector.MongoDb
    version: 0.1.0
```

**Before you install it:** an inferred schema is only as stable as the head of the collection —
declare `fields:` for a pipeline that must not change shape when the data does. A document value
the column cannot hold losslessly (a fraction in an integer column, a decimal with more than nine
fraction digits) fails the read naming the field and the `_id` rather than landing truncated; `string`
and `json` are the escapes. There is no SQL predicate pushdown (`filter:` is the lever), no change
streams, and one partition per read. The package is Native AOT — the driver's own reflective
serializer lookup is registered up front, and the native binary is run against a live server in CI —
and ships `linux-x64`, `linux-arm64`, `osx-arm64`, and `win-x64`, but only `linux-x64` has actually
been exercised by its own CI. See its
[README](https://github.com/PipelineZ/pz-connector-mongodb#readme) for the type tables, connection
keys, and what's proven.

## snowflake

Runs entirely on the universal Arrow-stream tier, both directions — a typed reader on the read
side, a spool → PUT → COPY load on the write side. Key-pair (JWT) authentication only; there is no
password-auth surface.

```yaml title="project.yml"
connectors:
  - package: Pz.Connector.Snowflake
    version: 0.2.0
```

**Before you install it:** prefer a glibc Linux host over Alpine — the driver's documented Linux
support is glibc-based, and the self-contained binary is glibc-linked. There's no regional-endpoint
option for GCP-hosted accounts, either. The package is self-contained rather than Native AOT, since
`Snowflake.Data` binds through reflection; it ships `linux-x64`, `linux-arm64`, `osx-arm64`, and
`win-x64` as a 203 MB download of which only your platform's ~55 MB is materialized, and only
`linux-x64` has been exercised through pz end to end. A relative `private_key_path` resolves
against the project directory (the manifest declares a project-directory anchor). See its
[README](https://github.com/PipelineZ/pz-connector-snowflake#readme) for connection keys, schema
policy, and type mapping.

## Related

- [Connector matrix](/connectors/): every builtin connector's capabilities, and how a packaged
  connector gets restored.
- [Connectors](/concepts/connectors/): what a connector is, the three tiers, isolation.
- [Author a connector](/how-to/author-a-connector/): the ABI and test suite every connector here
  implements.
