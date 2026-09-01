---
title: "Extract from an HTTP API"
description: "How to pull a JSON REST API into a pz project with the http connector: worked example, the two ways to land the response, the three pagination strategies,..."
---

How to pull a JSON REST API into a `pz` project with the `http` connector: worked example, the
two ways to land the response, the three pagination strategies, auth, incremental extraction, and
writing to an HTTP API as a sink.

## Prerequisites

- A JSON REST API that returns a paginated list endpoint (or a single object) over `GET`.
- If the API requires a credential, an environment variable holding it — see
  [Secure connection config](/how-to/secure-connection-config/).

## A worked example: GitHub issues

```yaml
sources:
  github:
    connector: http
    connection:
      base_url: https://api.github.com
      auth: { type: bearer, token: ${GITHUB_TOKEN} }     # optional; api_key|bearer|basic
      headers: { X-GitHub-Api-Version: "2022-11-28" }     # static extra headers
    datasets:
      issues:
        path: /repos/duckdb/duckdb/issues                 # literal path; GET only
        query:
          state: all
          per_page: "100"
          since: "{{ watermark }}"
        pagination: { strategy: link_header }
        # items: /data          — JSON pointer to the records array when the body wraps it;
        #                         omitted = the body root IS the array (RFC 6901: root = "")
        cursor: updated_at                                # raw-mode incremental (see below)
        cursor_type: timestamp                            # required alongside cursor
        sync:
          mode: incremental
          cursor: updated_at
```

`connection` is shared by every dataset under `github`; each dataset's own keys (everything
except the engine-level `columns`/`sync`/`retry`) describe one
endpoint. `path` is a literal, request-relative path — the connector never templates the path
itself, only `query` values (via `{{ watermark }}`, see [Incremental extraction](#incremental-extraction-watermark)
below).

## Landing modes

The connector has two ways to turn a JSON record into a row. Pick raw if you want to see
whatever the API sends and shape it downstream; pick a contract if you want typed columns going
in.

### Raw envelope (default)

With no `columns:` option, every record under the `items` pointer lands as one row of:

| Column | Type | Meaning |
|---|---|---|
| `payload` | `varchar` | The record's JSON text, verbatim |
| `pz_page` | `int` | Zero-based page index within this run |
| `pz_fetched_at` | `timestamp` | Request-time UTC when the page was fetched |
| *(cursor name)* | *(cursor_type)* | Present only when `cursor:`/`cursor_type:` are set |

The schema is exact and known offline — it never probes the API, so it can't drift out from
under `pz validate`. Shape the payload downstream with DuckDB's JSON functions:

```sql
-- pipelines/issues_shaped.sql
select
    payload ->> '$.id'          as issue_id,
    payload ->> '$.title'       as title,
    payload ->> '$.state'       as state,
    (payload ->> '$.updated_at')::timestamp as updated_at
from {{ source('github', 'issues') }}
```

Because `payload` is exact JSON text, `->>`/`->` and DuckDB's other JSON functions work the same
way they would over any JSON column — no connector-specific extraction step.

### `columns:` contract

Declare `columns:` on the dataset to type the fields you want at extraction time instead of
downstream:

```yaml
datasets:
  issues:
    path: /repos/duckdb/duckdb/issues
    query: { state: all, per_page: "100" }
    pagination: { strategy: link_header }
    columns:
      id: bigint
      title: varchar
      state: varchar
      updated_at: timestamp
    sync:
      mode: incremental
      cursor: updated_at
```

Extra JSON keys not named in `columns:` are ignored; a key named in `columns:` but absent from a
record (or an explicit JSON `null`) lands as an Arrow null. A value that doesn't fit its declared
type — a string where `bigint` was declared, say — fails loudly rather than coercing silently.
The accepted contract types are `int`, `bigint`, `double`, `decimal`, `varchar`, `boolean`,
`date`, `timestamp` — decimal values arrive as JSON numbers, date/timestamp as strings.

In contract mode the cursor is just another declared column — no separate `cursor_type:` option
is needed, or accepted.

## Pagination

Declare exactly one `pagination:` block per dataset. `max_pages:` (if set) caps the read regardless
of whether more pages remain — set it whenever a runaway loop would be expensive, since a mid-crawl
failure re-crawls from page one (see [Limits](#limits) below).

How a crawl *ends* depends on whether the strategy has an end-of-feed signal of its own:

- **Link header and cursor token** end when the signal is absent — no `rel="next"` link, or a
  missing/null/empty token. An **empty page is not an ending** for these: a page with zero records
  that still carries a next link is a gap to cross, and the crawl continues. Microsoft Graph delta
  feeds and filtered queries both serve empty middle pages, and stopping there would drop every row
  behind them with no error at all.
- **Page number** has no other signal, so an empty page *is* its ending.

| Strategy | YAML | When to use it |
|---|---|---|
| Link header | `pagination: { strategy: link_header }` | The API returns an RFC 8288 `Link` response header (GitHub, and most REST APIs that follow the convention). The connector follows the link whose `rel` contains `next`; parameter order and quoting don't matter, and a relative URI resolves against the current request. |
| Page number | `pagination: { strategy: page, param: page, start: 1, size_param: per_page, size: 100 }` | Offset-style APIs with a page-number query parameter. `param`/`start` default to `page`/`1`; `size_param`/`size` are optional and only added when both are set. The **first** request already carries `param=start` and the size params — the API's default page size never applies, so page two can neither skip nor re-deliver rows. |
| Cursor token | `pagination: { strategy: cursor, pointer: /meta/next_cursor, param: cursor }` | Token/cursor-style APIs that return the next page's opaque token in the response body. `pointer` is a JSON pointer into the body; the token is copied verbatim into the `param` query parameter on the next request. A missing, null, or empty token ends the read. |

A crawl that does not advance is a permanent error naming the URL rather than a loop that never
ends. That covers a "next" link pointing back at the current page, and any longer ring (page A
links to B, B links back to A) — every URL requested during an attempt is remembered, so a repeat
of *any* of them fails. A feed that keeps offering genuinely fresh pages forever is bounded too: a
crawl that passes 50 000 pages without `max_pages:` set fails and names `max_pages:`, since at that
point "enormous feed" and "broken pagination" are indistinguishable and the honest answer is to make
the author say which.

> [!NOTE]
> This rules out **scroll-style cursors** that repeat the same token while the server advances
> state server-side (Elasticsearch scroll/PIT ids; Crossref's `/works` deep paging works this
> way). That is deliberate, not just loop paranoia: pz's retry/checkpoint model assumes
> re-issuing a request re-fetches the *same* page, and a scroll cursor silently hands back the
> *next* one — a retried run would skip pages. Use an API's changing-token cursor variant
> (OpenAlex-style) or an offset/page parameter instead.

## Auth

Declare `auth:` once on the `connection:` block; it applies to every dataset under that source.

| Type | YAML | Where the credential goes |
|---|---|---|
| API key | `auth: { type: api_key, key: ${API_KEY}, header: X-Api-Key }` or `auth: { type: api_key, key: ${API_KEY}, param: api_key }` | A request header (`header:`) or a query parameter (`param:`) — exactly one of the two. Query-parameter keys are redacted (`api_key=***`) in every error message and log line the connector produces. |
| Bearer token | `auth: { type: bearer, token: ${GITHUB_TOKEN} }` | `Authorization: Bearer <token>` header. |
| Basic | `auth: { type: basic, user: ${API_USER}, password: ${API_PASSWORD} }` | `Authorization: Basic <base64(user:password)>` header. |

Credentials belong in environment variables, never literal in YAML — see
[Secure connection config](/how-to/secure-connection-config/) for the `${VAR}` interpolation rules.

OAuth2 (client-credentials, authorization-code, refresh flows) is not supported; only the three
static-credential shapes above. An expired token surfaces as whatever status the API returns —
`401`/`403` are permanent errors that fail the read, so a token that expires mid-crawl fails the
whole `SourceLoad` rather than landing a short read and advancing a watermark past rows it never
fetched.

## Bounds on a misbehaving endpoint

Everything the far side controls is bounded, because a source you do not operate can stall, bloat,
or redirect you. Three connection-level options set the dials:

| Option | Default | What it bounds |
|---|---|---|
| `timeout_seconds` | `30` | How long one page request may take. `HttpClient`'s own default is 100s, which is far too long for a page of JSON and applies *per attempt* — a black-holed endpoint would hold a run for minutes before the engine saw a transient failure. Raise it for a genuinely slow endpoint. |
| `max_response_mb` | `256` | How many bytes one response may occupy. A page is buffered whole and then parsed into a JSON DOM, so peak memory is a multiple of the wire size; without a cap the only backstop is the process running out of memory on a response whose size the endpoint chooses. |
| `allow_hosts` | *(empty)* | Extra hosts this connection may talk to, beyond `base_url`'s own origin. |

```yaml
connections:
  github:
    connector: http
    connection:
      base_url: https://api.github.com/
      auth: { type: bearer, token: ${GITHUB_TOKEN} }
      timeout_seconds: 15
      max_response_mb: 64
```

**Requests never leave the connection's own origin** (scheme + host + port of `base_url`) unless the
host is listed in `allow_hosts:`. This matters because the endpoint chooses several of the URLs pz
would otherwise follow — the `Link` header's next page, a `3xx` redirect target, a stored delta link
or resume checkpoint — and every request carries this connection's `Authorization`/API-key headers.
Following a cross-host URL would hand those credentials to whatever host the response named, so a
single hostile or compromised response would be enough to exfiltrate them. A cross-origin target is
a permanent error naming the offending authority (never the full URL, which can embed the secret
itself) and pointing at `allow_hosts:`.

Redirects are followed by the connector rather than by `HttpClient`, so that check is reachable at
all: the automatic behavior strips only the `Authorization` header on a cross-origin hop and would
carry a configured `headers:` entry or an API-key header straight through. Chains are capped at five
hops, so a redirect loop fails instead of spinning.

## Incremental extraction (`{{ watermark }}`)

Reference the stored watermark in any `query:` value with `{{ watermark }}`:

```yaml
query:
  since: "{{ watermark }}"
```

- **First run / `--full-refresh`:** there is no stored watermark yet, so the `since` parameter is
  omitted from the request entirely rather than sent as an empty or null value — the API sees
  its own unbounded default.
- **Rendering:** a `timestamp`-typed cursor renders as ISO-8601 UTC with seconds precision and a
  literal `Z` (`yyyy-MM-ddTHH:mm:ssZ`) — the form GitHub's `since` and most REST APIs expect.
  Other cursor types render in their canonical string form. All query values are URL-encoded.
- **Inclusive-cursor duplicates:** APIs like GitHub's `since` are "at or after", so the boundary
  record is re-extracted on the next run. That's standard over-extraction, not a bug — point the
  dataset at a `write: { strategy: merge }` sink and the duplicate is absorbed by the key-based
  upsert. See [Delivery guarantees](/concepts/delivery-guarantees/#the-pairing-matrix) for
  what each (read shape, write strategy) pair promises.
- Raw mode needs `cursor:` + `cursor_type:` declared alongside `sync.cursor` (both must
  name the same column); contract mode only needs the cursor present in `columns:`.
- Optionally declare **`cursor_order: asc|desc`** — how the API serves records relative to the
  cursor. It is load-bearing when a crawl truncates: `desc` + `max_pages` on an incremental
  dataset is refused at compile time (PZ0229), because a truncated descending crawl would
  advance the watermark past unfetched rows. Left undeclared, the connector decides by
  observation at run time (below).

## Windowed backfill (bounded windows)

For a large historical range, extract it in bounded increments instead of one open-ended pull.
Declare `max_window` (and optionally `until`) on the dataset's `sync:` block, and reference
the engine-supplied upper bound with the `{{ window_upper }}` binding:

```yaml
# connections.yml, under the entity's read:
sync:
  mode: incremental
  cursor: updated_at
  initial: "2024-01-01T00:00:00Z"
  max_window: 7d
  until:   "2025-01-01T00:00:00Z"
```

```yaml
# the dataset's query
query:
  updated_after:  "{{ watermark }}"      # lower bound of the window, exclusive (>)
  updated_before: "{{ window_upper }}"   # upper bound of the window, inclusive (<=)
```

Each `pz run` extracts one `(lower, upper]` window and, once every downstream sink commits,
advances the watermark by one window. Drive the full backfill by running repeatedly (a scheduler,
or `pz run` in a loop) until the run reports caught up. A failure partway through leaves the
watermark at the last fully-committed window; the next run resumes there and re-extracts only the
in-flight window — progress is preserved at window granularity.

**Notes.**

- **Truncation is guarded.** A crawl the `max_pages` cap cuts short may only advance the
  watermark when the landed cursor values were ascending (a provable contiguous prefix — the
  MediaWiki `rcdir=newer` shape, which safely inches through a too-big window run by run).
  Otherwise the run fails with a permanent error naming the remedies: remove `max_pages` so
  slices run to completion, or use an ascending endpoint. Declare `cursor_order: desc` to get
  the same refusal at compile time (PZ0229) instead of at the first truncated run.
- The window is `(lower, upper]`. Whether the API applies `>`/`<=` (vs `>=`/`<`) to your chosen
  params is the API's semantics; pick params that match, or rely on a `merge`/`replace` sink to
  make a boundary double-count harmless.
- If you set `max_window` but do **not** reference `{{ window_upper }}` in the query, the connector
  extracts open-ended past the window; the engine still caps the watermark at the window's upper
  edge, so the next run re-delivers the beyond-window rows (wasted work + duplicates), never data
  loss. Always wire `{{ window_upper }}` when you declare `max_window`.
- Timestamp bounds render as ISO-8601 UTC to whole seconds: the lower bound floors and the upper
  bound ceils, so the inclusive tail (e.g. an upper of `...00.5`) is never dropped by rounding.
  Rows beyond the true upper that fall inside the ceiled second are over-extracted this window but
  re-deliver next window (the engine caps the watermark candidate at the true upper), never loss;
  incremental/windowed `append` needs `write: { duplicates: accept }` (PZ0214), `merge`/`replace`
  are effectively-once.
- Incremental/windowed → `append` requires `write: { duplicates: accept }` (PZ0214);
  `merge`/`replace` are effectively-once.

## Sync state (delta-link / change-feed APIs)

Some APIs don't let you filter by an orderable field — they hand back an opaque "call this URL next
time" token (e.g. Microsoft Graph `@odata.deltaLink`). Point the connector at the delta link and
leave the dataset's `sync:` block absent (or `mode: auto`) — a `delta_pointer` option makes this
dataset's natural read a **feed**, and `auto` resolves to it automatically (see [Delivery
guarantees](/concepts/delivery-guarantees/#declaring-how-data-is-read-and-written)):

```yaml
# connections.yml
datasets:
  messages:
    path: /me/messages/delta
    pagination: { strategy: link_header }   # walk @odata.nextLink pages within a run
    delta_pointer: /@odata.deltaLink        # the token to persist for next run
                                             # no sync: block needed — mode: auto resolves to feed
```

First run starts at `path`; each later run replays the stored delta link to fetch only changes. The
token is stored in `.pz/state/sync-state.json` and only advances after every downstream sink commits.
If the server expires the token (HTTP 410), the run fails with a permanent error — re-run with
`--full-refresh` to restart the feed from the beginning.

**Delivery is at-least-once**: on a retry/replay the connector resumes from the last committed token,
which can re-deliver rows. Pair a feed-shaped dataset with a `merge` sink (effectively-once) or
declare `write: { duplicates: accept }` on an `append` output (PZ0214). A feed-shaped dataset is
always single-partition (`PZ0316` refuses one on a partitioned-read connector) and can't declare a
bounded window — `max_window`/`initial`/`until` are `sync: { mode: incremental }` sub-keys only.

## Write to an HTTP API (sink)

The `http` connector also ships a sink: a generic way to `POST`/`PUT`/`PATCH` a
pipeline's output rows to a REST endpoint. The `connection:` block — `base_url`, `auth:`,
`headers:` — is shared with the source:

```yaml
# connections.yml
webhook:
  connector: http
  base_url: https://api.example.com
  auth: { type: bearer, token: ${WEBHOOK_TOKEN} }
```

The per-write options below are keyword arguments on the `sink()` call:

```sql
-- path is required; request-relative, must start with '/'
-- body_format defaults to json_array (or ndjson); rows_per_request is the append-mode chunk size
INSERT INTO {{ sink('webhook', 'events_out', strategy: 'append', path: '/events', body_format: 'json_array', rows_per_request: 500) }}

-- merge requires the '{key}' token in path; method defaults to post (append) / put (merge)
INSERT INTO {{ sink('webhook', 'items_out', strategy: 'merge', keys: ['id'], path: '/items/{key}', method: 'put') }}
```

| Option | Applies to | Meaning |
|---|---|---|
| `path` | both | Required. Request-relative path, must start with `/`. Under `strategy: 'merge'` it must contain a `{key}` token (the row's key value, URL-escaped, is substituted in); under `append` the token is not allowed. |
| `method` | both | `post`\|`put`\|`patch`. Defaults to `post` for `append`, `put` for `merge`. |
| `body_format` | `append` only | `json_array` (default, one `[...]` array per request) or `ndjson` (one JSON object per line). Setting it on a `merge` output is a config error — merge sends one full-row body per key and would silently ignore it. |
| `rows_per_request` | `append` only | Rows chunked into each request. Default `500`. Setting it on a `merge` output is a config error, same as `body_format`. |

**Modes.** `append` chunks rows into `rows_per_request`-sized requests. `merge` requires exactly
one key column in v1 (a multi-key follow-up is on the backlog) and
sends one keyed `PUT`/`PATCH` per row. `replace` is refused at plan time (`PZ0324`) — there is no
way to atomically overwrite an arbitrary endpoint's prior state. See
[Delivery guarantees: HTTP sink](/concepts/delivery-guarantees/#http-sink) for the guarantee
each mode provides.

**Abort semantics: `none`.** A delivered row is already visible at the destination — you cannot
un-POST — so a failed write's abort cleans up nothing, and the engine reports `delivery stopped:
up to N row(s) already visible...` rather than implying anything unwound.

> [!IMPORTANT]
> Error messages redact query strings and request/response bodies, but **not** the request path
> — and under `write.strategy: merge` the `{key}` token is substituted directly into that path. A
> failed merge request's error message therefore includes the key value verbatim (e.g.
> `.../items/cust_9f3a failed: ...`). Pick a merge key column that isn't itself sensitive (an
> internal id, not an email address or an account number) if your endpoint or its errors might
> be logged somewhere you don't control.
>
> `{key}` is reserved across ALL path validation, not just this sink's own — but a literal `{key}`
> in a file-connector path (LocalFiles/S3/AzureBlob's calendar-token templating) is accepted as a
> literal path segment rather than rejected as an unknown token.

**Checkpointing is automatic.** The connector declares `CheckpointableWrites`: under `pz retry` or
a same-run retry attempt, the engine resumes delivery past whatever prefix the destination has
already confirmed (2xx responses only) instead of re-sending rows — see
[Delivery guarantees: Delivery checkpoints](/concepts/delivery-guarantees/#delivery-checkpoints).
No configuration is needed on your end; it engages whenever the sink's write session is checkpointable.

## Limits

This is a universal-tier-only connector — know what it doesn't do:

- **`GET` only on the source side.** No pagination-via-request-body reads.
- **One partition per dataset.** No parallel fan-out across pages or partitions.
- **Universal tier only** — every read/write moves data through .NET; there is no native DuckDB
  scan/copy path (no `httpfs`/`read_json` pushdown). The source declares `BoundedWindow`
  (windowed/incremental extraction) and `SyncState` (delta-link mode, above); the sink declares
  `Merge` and `CheckpointableWrites` (above) but not `ReplaceWrites`.
- **Node-level retry, not resume, on the source side.** The connector classifies failures
  (transient vs. permanent) and never retries internally — the engine's node-level retry re-runs
  the whole `SourceLoad` from page one on a transient failure. Keep `max_pages` sane on an
  endpoint with many pages so a mid-crawl transient failure doesn't turn a retry into an expensive
  re-crawl. The sink's own resume story is checkpointed (above), not a plain re-run from zero.
- **At-least-once posture on the source side.** Combined with inclusive-cursor duplicates above,
  plan on a `merge` sink downstream rather than `append`.

## Next steps

- [Connectors](/concepts/connectors/#http-connector) — how the `http` connector fits the
  ABI and why it's universal-tier only.
- [Handle schema drift](/how-to/handle-schema-drift/)
- [Secure connection config](/how-to/secure-connection-config/)
- [Delivery guarantees](/concepts/delivery-guarantees/)
