---
title: "Extract from an HTTP API"
description: "How to pull a paginated JSON REST API into a pz project with the http connector, using GitHub's issues endpoint as a worked example."
sidebar:
  order: 1
---

This page walks through pulling a paginated JSON REST API into a `pz` project with the `http`
connector: GitHub's issues endpoint, landed as typed columns, extracted incrementally, and
written to a local parquet file. Read it if you're wiring up your first HTTP source.

Later sections cover OAuth2, refresh-token and login sign-in, error rules, other pagination
shapes, newest-first feeds, POST queries, proxies and parallel fetching. For APIs that serve files, see
[Download files and exports from an API](/how-to/download-files-from-an-api/); for endpoints that
exist only per parent record, see [Call an API once per record](/how-to/call-an-api-per-record/).

## Prerequisites

- A `pz` project. Run `pz init --template http` to scaffold this exact example, or add the
  connection below to an existing project.
- Internet access. No credentials are required for this example: GitHub allows about 60
  unauthenticated requests per hour.

## Steps

### 1. Declare the connection

Add an `http` connection to `connections.yml`. `base_url` anchors every entity's `path`, and
`headers` apply to every request on this connection:

```yaml title="connections.yml"
github:
  connector: http
  base_url: https://api.github.com
  headers: { X-GitHub-Api-Version: "2022-11-28" }
```

### 2. Declare the entity

Add an entity under `entities:` naming the endpoint, its pagination, and the columns you want:

```yaml title="connections.yml"
  entities:
    issues:
      read:
        path: /repos/duckdb/duckdb/issues
        query: { state: all, per_page: "100", sort: updated, direction: asc, since: "{{ watermark }}" }
        pagination: { strategy: link_header }
        max_pages: 5
        cursor_order: asc
        columns:
          id: bigint
          number: bigint
          title: varchar
          state: varchar
          updated_at: timestamp
        sync: { mode: incremental, cursor: updated_at }
```

`path` is request-relative and starts with `/`. `pagination: { strategy: link_header }` follows
the RFC 8288 `Link` header GitHub returns, which is the most common pagination shape among REST
APIs. `max_pages: 5` caps a run at 500 issues, so a first try stays fast; drop it once you trust
the shape. `columns:` types exactly these five fields at extraction time; every other JSON key in
the response is ignored.

`sync: { mode: incremental, cursor: updated_at }` paired with `since: "{{ watermark }}"` in the
query makes this a [watermark](/concepts/incremental-loads/)-driven read: the first run omits
`since` entirely, and every later run sends the stored watermark. `cursor_order: asc` tells pz the
API serves oldest-first, so a `max_pages`-truncated crawl still advances the watermark safely. See
[Incremental loads](/concepts/incremental-loads/) for the full watermark model, and the
[HTTP connector reference](/connectors/http/) for every read option, all five pagination
strategies, and the raw landing mode you get with no `columns:` contract.

### 3. Add a sink and write the pipeline

Declare a `localfiles` connection to land the output, then write a pipeline that selects from the
source and inserts into the sink:

```yaml title="connections.yml"
lake:
  connector: localfiles
  root: out
```

```sql title="pipelines/issues_log.sql"
INSERT INTO {{ sink('lake', 'issues_log', format: 'parquet', path: 'out/issues/', strategy: 'append', duplicates: 'accept') }}
SELECT id, number, title, state, updated_at
FROM {{ source('github', 'issues') }}
```

`duplicates: 'accept'` is required here: GitHub's `since` is inclusive, so the boundary row can
re-land on the next run. That makes this pairing at-least-once rather than effectively-once. `pz`
refuses an incremental read feeding a plain `append` sink without this consent
([`PZ0214`](/reference/error-codes/)). Deduplicate downstream by keeping the highest `updated_at`
per `id`, or point the sink at a merge-capable connector instead. See
[Incremental loads](/concepts/incremental-loads/#strategy-merge-and-re-extraction) for the merge
alternative.

### 4. Run it

Validate the config offline first, since the schema here is declared, not probed:

```console
$ pz validate
validation passed (1 pipelines, 2 connections checked)
```

Then run it, twice:

```console
$ pz run --all
ok src_github__issues 487 rows 612ms
ok lake.issues_log 487 rows 41ms
run 20260902T090011003Z-8a2f: 2 succeeded, 0 failed, 0 skipped (.pz/runs/20260902T090011003Z-8a2f/run_results.json)

$ pz run --all
ok src_github__issues 12 rows 340ms
ok lake.issues_log 12 rows 9ms
run 20260902T090512118Z-1c3e: 2 succeeded, 0 failed, 0 skipped (.pz/runs/20260902T090512118Z-1c3e/run_results.json)
```

Row counts vary since this hits live data. The second run only lands issues updated since the
first run's watermark.

## Verify

Query the parquet output directly with DuckDB, deduplicating on the highest `updated_at` per
`id` since the read is at-least-once:

```console
$ duckdb -c "select * from read_parquet('out/issues/*.parquet')
             qualify row_number() over (partition by id order by updated_at desc) = 1
             limit 5"
```

Confirm the watermark advanced between runs:

```console
$ pz state show github.issues
github.issues — cursor updated_at (timestamp)
  current  2026-09-02T08:58:04Z  run 20260902T090512118Z-1c3e
```

## Add authentication

Unauthenticated GitHub access is rate-limited to about 60 requests an hour. For heavier use,
export a token and reference it with `${VAR}` interpolation, never a literal in YAML:

```yaml title="connections.yml"
github:
  connector: http
  base_url: https://api.github.com
  auth: { type: bearer, token: ${GITHUB_TOKEN} }
  headers: { X-GitHub-Api-Version: "2022-11-28" }
```

```console
$ export GITHUB_TOKEN=ghp_...
```

`auth` also supports `api_key` and `basic`, OAuth2 sign-ins, and login sessions (below). See the
[HTTP connector reference](/connectors/http/#auth) for every shape, and
[Secure connection config](/how-to/secure-connection-config/) for keeping credentials out of the
repository.

### Sign in with OAuth2

For an API behind Microsoft Entra ID (Azure AD), such as Microsoft Graph, sign in as a service
principal. `scope` is the API's `<resource>/.default`:

```yaml title="connections.yml"
graph:
  connector: http
  base_url: https://graph.microsoft.com/v1.0
  auth:
    type: azure_ad
    method: service_principal
    tenant_id: ${AZURE_TENANT_ID}
    client_id: ${AZURE_CLIENT_ID}
    client_secret: ${AZURE_CLIENT_SECRET}
    scope: https://graph.microsoft.com/.default
```

On an Azure VM or container, `method: managed_identity` needs no secret at all. On a developer
machine, `method: credential_chain` picks up `az login`. For certificate sign-in, replace
`client_secret` with `certificate_path`, and keep the file outside the project directory.

For any other OAuth2 provider, use the client-credentials grant against its token endpoint:

```yaml title="connections.yml"
vendor:
  connector: http
  base_url: https://api.vendor.example
  auth:
    type: oauth2_client_credentials
    token_url: https://login.vendor.example/oauth2/token
    client_id: ${VENDOR_CLIENT_ID}
    client_secret: ${VENDOR_CLIENT_SECRET}
    scope: reports.read
```

Both cache the token and sign in again before it expires. Run `pz validate --connect` to test the
sign-in: a failure is reported as `sign-in failed: ...`, separately from errors the API returns.

### Sign in with a refresh token

APIs such as Google's act on behalf of a person, who grants access once. Run the provider's
consent flow yourself to get a refresh token, export it, and let pz exchange it for access
tokens:

```yaml title="connections.yml"
google_ads:
  connector: http
  base_url: https://googleads.googleapis.com/v17
  auth:
    type: oauth2_refresh_token
    token_url: https://oauth2.googleapis.com/token
    client_id: ${GOOGLE_CLIENT_ID}
    client_secret: ${GOOGLE_CLIENT_SECRET}
    refresh_token: ${GOOGLE_REFRESH_TOKEN}
```

This works only with refresh tokens that stay valid. If the provider sends back a new refresh
token, the read fails with [`PZ0366`](/reference/error-codes/), since the old one may already be
revoked and pz has nowhere to store the new one. For a provider that keeps old refresh tokens
valid, such as Microsoft Entra, add `rotation: ignore`. If a read fails with `invalid_grant`, the
refresh token has expired or been revoked: authorize again and update the variable.

### Sign in with a login request

Some APIs issue a session token from a login endpoint. Describe the login, where the token is in
its response, and how to send it:

```yaml title="connections.yml"
erp:
  connector: http
  base_url: https://erp.example.com/api
  auth:
    type: session
    login:
      path: /auth/login
      body: { username: "${ERP_USER}", password: "${ERP_PASSWORD}" }
    token_pointer: /data/token
    inject: { header: X-Session-Token }
    ttl: 30m
```

pz logs in once per node and logs in again after `ttl`. If the login response states the
session's lifetime, use `expires_in_pointer: /data/expires_in` instead of `ttl`. `inject` defaults
to `Authorization: Bearer <token>`; `{ query: sid }` sends the token as a query parameter instead.
An API that answers an expired session with something other than `401` can list those statuses in
`reauth_status: [419, 440]`.

A login refused with `401` or `403` is not tried again in the same run, by any node, so a wrong
password costs one failed login per run. See [Session](/connectors/http/#session) for every key.

## Handle API errors with rules

By default, `408`, `429` and `5xx` responses are retried by the engine and every other error fails
the read. When an API uses other statuses, classify them with `on_status`:

```yaml title="connections.yml"
github:
  connector: http
  base_url: https://api.github.com
  auth:
    type: bearer
    token: ${GITHUB_TOKEN}
  entities:
    issues:
      read:
        path: /repos/duckdb/duckdb/issues
        query: { state: all, since: "{{ watermark }}" }
        pagination: { strategy: link_header }
        on_status:
          - { status: 403, body_contains: "secondary rate limit", action: transient, retry_after: 60s }
        columns: { id: bigint, title: varchar, updated_at: timestamp }
        sync: { mode: incremental, cursor: updated_at }
```

GitHub answers a secondary rate limit with `403`. The rule makes that response transient, so the
engine's retry waits and tries again, while any other `403` still fails at once. The wait is the
response's `Retry-After` if it has one, otherwise the rule's `60s`. Raise `max_attempts` in the
connection's `retry:` block if one wait is not enough; see [Tune retries](/how-to/tune-retries/).

`action: permanent` fails the read with the rule named, for a `5xx` that will not go away with a
retry. `action: skip` ends a read with 0 rows, for a daily report that answers "no data" with an
error; it is refused on incremental datasets, because a skipped window would be lost. See
[Status rules](/connectors/http/#status-rules-on_status) for the rule order and restrictions.

If the API states its wait in a header other than `Retry-After`, name it on the connection, for
example `retry_after: { header: x-ms-retry-after-ms, kind: ms }`.

## Page through other API shapes

The GitHub example follows a `Link` header. Pick the strategy that matches how your API points at
the next page:

```yaml title="connections.yml"
graph:
  connector: http
  base_url: https://graph.microsoft.com/v1.0
  auth: { type: azure_ad, method: managed_identity, scope: "https://graph.microsoft.com/.default" }
  entities:
    users:
      read:
        path: /users
        items: /value
        pagination: { strategy: next_url, pointer: /@odata.nextLink }
        columns: { id: varchar, displayName: varchar, mail: varchar }
```

`next_url` reads the next page's URL from the response body. For an offset/limit API, use
`pagination: { strategy: offset, size: 100 }`, which sends `offset` and `limit` and advances by the
number of rows each page returned. Every link the API hands back is still checked against the
connection's host and `allow_hosts`.

### Page tokens in headers

Some APIs put the next page's token in a response header instead of the body. Azure Cosmos DB's
REST API sends it in `x-ms-continuation` and expects it back in the same request header:

```yaml title="connections.yml"
        pagination:
          strategy: cursor
          header: x-ms-continuation
          location: header
          param: x-ms-continuation
```

`header:` reads the token from the response; `location: header` sends it in the request header
named by `param`. Leave out `location` to send a header token as a query parameter instead. The
crawl ends when the header is missing or empty.

## Read a newest-first feed

Some feeds list the newest records first and have no "since" filter, so each run would page
through everything. With `cursor_order: desc` and `stop_at_watermark: true`, the crawl stops at the
first page that reaches records the last run already landed:

```yaml title="connections.yml"
    activity:
      read:
        path: /activity
        items: /items
        pagination: { strategy: cursor, pointer: /next, param: cursor }
        columns: { id: bigint, created_at: timestamp, kind: varchar }
        cursor: created_at
        cursor_order: desc
        stop_at_watermark: true
        sync: { mode: incremental, cursor: created_at }
```

The first run, and any `--full-refresh`, read the whole feed. Later runs stop early and print a
notice with the page and the number of older records dropped. If the feed turns out not to be
newest-first (a record newer than the one before it), the read fails rather than miss rows.
`cursor` names the cursor column even in contract mode, and must match `sync.cursor`.

## Query with a POST body

Search and GraphQL endpoints take their query in the request body. Set `method: post` and write
the body as a map. This reads GitHub's GraphQL API, paging with the cursor written into the body:

```yaml title="connections.yml"
github_graphql:
  connector: http
  base_url: https://api.github.com
  auth: { type: bearer, token: ${GITHUB_TOKEN} }
  entities:
    issues:
      read:
        path: /graphql
        method: post
        body:
          query: |
            query($after: String) {
              repository(owner: "duckdb", name: "duckdb") {
                issues(first: 100, after: $after) {
                  nodes { id title updatedAt }
                  pageInfo { endCursor }
                }
              }
            }
          variables: { after: null }
        items: /data/repository/issues/nodes
        error_pointer: /errors
        pagination:
          strategy: cursor
          location: body
          param: /variables/after
          pointer: /data/repository/issues/pageInfo/endCursor
        columns: { id: varchar, title: varchar, updatedAt: timestamp }
```

`location: body` writes each page's cursor to `/variables/after` in the body instead of the URL.
`error_pointer: /errors` fails the read when GraphQL reports errors with HTTP 200. Point a POST
read only at an endpoint with no side effects: a retry sends the request again.

## Go through a proxy or trust a private CA

Behind a corporate proxy, or against an API whose certificate is issued by an internal CA, add
`proxy:` and `tls:` to the connection:

```yaml title="connections.yml"
partner:
  connector: http
  base_url: https://partner.example.com/api
  proxy:
    url: http://proxy.corp.example:3128
    user: ${PROXY_USER}
    password: ${PROXY_PASSWORD}
    bypass: ["*.corp.example"]
  tls:
    ca_file: certs/corp-root.pem
    client_certificate:
      path: ~/.pz/certs/pz-client.pfx
      password: ${CLIENT_CERT_PASSWORD}
```

`ca_file` adds trust in your CA alongside the system roots; it never turns certificate checks off.
`client_certificate` is the certificate the API expects for mutual TLS, sent only to `base_url`'s
origin and `allow_hosts`. See the [HTTP connector reference](/connectors/http/#proxy) for every
key, and for how these interact with `azure_ad`.

## Fetch pages in parallel

A slow API with numbered pages can be read several pages at a time:

```yaml title="connections.yml"
        pagination: { strategy: page, size_param: per_page, size: 100, concurrency: 4 }
```

Pages still land in order. Pair it with `rate_limit:` on the connection so four requests at a time
stay under the API's limit; see [Throttle a source](/how-to/throttle-a-source/).

## Write to an HTTP API

The `http` connector also ships a sink, for pushing a pipeline's rows to a REST endpoint with
`POST`, `PUT`, or `PATCH`:

```sql title="pipelines/events_out.sql"
INSERT INTO {{ sink('webhook', 'events_out', strategy: 'append', path: '/events') }}
SELECT * FROM {{ ref('events_shaped') }}
```

`append` chunks rows into request bodies; `strategy: 'merge'` sends one keyed `PUT` per row
instead, with a `{key}` token in `path`. See the [HTTP connector reference](/connectors/http/)
for every write option and the write-side capability limits.

## Troubleshooting

| If you see | Do |
|---|---|
| `PZ0103` naming `GITHUB_TOKEN` | The `${GITHUB_TOKEN}` reference is unset. Export it, or remove the `auth:` line to run unauthenticated. |
| `PZ0214` at compile time | An incremental read feeds a plain `append` sink. Add `duplicates: 'accept'` to the sink, or switch to a merge-capable connector. |
| `PZ0229` at compile time | `cursor_order: desc` is set alongside `max_pages`. A truncated descending crawl could skip rows; drop `max_pages` or switch the cursor order. |
| An error naming a host and pointing at `allow_hosts` | A pagination link or redirect pointed outside `base_url`'s origin, or to `http://` from an `https://` `base_url`. Add the host to `allow_hosts` on the connection, only if you trust it; an `http://` link stays refused. |
| `401`/`403` from the API | The token is missing, expired, or lacks scope. Requests fail the whole `SourceLoad` rather than landing a partial page. |
| `sign-in failed: ...` from `pz validate --connect` | The OAuth2 credentials, `tenant_id`, `token_url` or the session login are wrong. The message names the cause without the secret. |
| `PZ0366` | The provider rotated the refresh token. Configure it for non-rotating tokens and authorize again, or set `rotation: ignore` if it keeps old tokens valid. |
| `invalid_grant` | The refresh token expired or was revoked. Authorize again and update `auth.refresh_token`. |
| `pz did not try again` after a refused login | An earlier node of the same run was refused with these credentials. Fix the credentials; the next run tries once more. |
| `action 'skip' is not allowed on a dataset that is or could be incremental` | `skip` is refused on incremental datasets, with `columns:`, and with `export`. Use `transient` or `permanent`, or read the dataset without a watermark. |
| `stop_at_watermark` fails with a cursor value greater than the one before it | The feed is not strictly newest-first. Remove `stop_at_watermark` and `cursor_order: desc`. |
| `the API rejected a freshly issued token (HTTP 401)` | Sign-in worked but the token is not for this API. Check `scope` (`<resource>/.default` for `azure_ad`) and the app's access grant. |
| An error naming `tls.ca_file` | The server's certificate is not trusted. Set `tls.ca_file` to the CA that issued it. An expired certificate or a host name mismatch is always refused. |
| An error naming `proxy.user`/`proxy.password` | The proxy answered `407`. Fix the proxy credentials. |
| An error naming `error_pointer` | The API reported an error in a `200` response. The message quotes it. |
| A permanent error naming `max_pages` | The crawl passed 50,000 pages with no `max_pages` cap. Set one, since an unbounded crawl and a broken feed look identical past that point. |

## Related

- [HTTP connector reference](/connectors/http/): every connection, read, and write option, all
  five pagination strategies, and status rules.
- [Download files and exports from an API](/how-to/download-files-from-an-api/): zip archives,
  dated URLs, and asynchronous export jobs.
- [Call an API once per record](/how-to/call-an-api-per-record/): `for_each` reads for
  per-parent endpoints.
- [Incremental loads](/concepts/incremental-loads/): watermarks, bounded windows, and the
  `strategy: merge` alternative to `duplicates: accept`.
- [Secure connection config](/how-to/secure-connection-config/): keeping `auth` credentials out
  of `connections.yml`.
- [Throttle a source](/how-to/throttle-a-source/): pace requests with `rate_limit` when an API
  enforces its own rate limit.
- [Debug a failed run](/how-to/debug-a-failed-run/): reading `run_results.json` when a crawl
  fails partway through.
