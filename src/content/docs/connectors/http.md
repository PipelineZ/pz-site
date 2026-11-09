---
title: "HTTP API"
description: "Reference for the http connector: connection, auth (OAuth2, Azure AD, refresh tokens and login sessions), proxy and TLS keys, GET and POST reads, status rules, the five pagination strategies, file downloads and export jobs, per-record for_each reads, parallel fetching, incremental extraction with watermark formats, and the write-side sink options."
sidebar:
  order: 16
---

The `http` connector pulls a REST API's responses into a project, and can push a pipeline's rows
back out over `POST`/`PUT`/`PATCH`. A read sends `GET` or `POST` and lands either JSON pages or a
downloaded file (CSV, TSV, JSON, XML, optionally inside a zip or gzip archive). It runs entirely
on the universal Arrow tier: there is no native DuckDB scan or copy path, since DuckDB has no
HTTP-JSON data plane of its own.

## Connection

```yaml title="connections.yml"
github:
  connector: http
  base_url: https://api.github.com
  auth: { type: bearer, token: "${GITHUB_TOKEN}" }
  headers: { X-GitHub-Api-Version: "2022-11-28" }
```

| Key | Required | Default | Meaning |
|---|---|---|---|
| `base_url` | Yes | — | Absolute `http(s)` URL every entity's `path` resolves against. |
| `auth` | No | — | `{ type: api_key \| bearer \| basic \| azure_ad \| oauth2_client_credentials \| oauth2_refresh_token \| session, ... }`. Shared by every entity on this connection. See [Auth](#auth). |
| `headers` | No | `{}` | Static extra headers sent on every request. |
| `check_path` | No | — | Request-relative path `pz validate --connect` probes to confirm connectivity. |
| `timeout_seconds` | No | `30` | Per-request timeout, up to 3600 seconds. Also bounds each OAuth2 sign-in request. |
| `max_response_mb` | No | `256` | Maximum size of one JSON response after decompression, 1–2047 MiB. A page is buffered whole then parsed. |
| `max_download_mb` | No | `4096` | Maximum size of one downloaded file (datasets with `file:`), 1–1048576 MiB. Decompressed archive content is capped at 20 times this value. |
| `allow_hosts` | No | `[]` | Extra bare hostnames this connection may follow, beyond `base_url`'s own origin. |
| `retry_after` | No | — | `{ header, kind }`: a header that states how long to wait when a throttled response has no usable `Retry-After`. See [Wait times from another header](#wait-times-from-another-header). |
| `proxy` | No | system default | `none`, or `{ url, user, password, bypass }`. See [Proxy](#proxy). |
| `tls` | No | — | `{ ca_file, client_certificate }`. See [TLS](#tls-private-ca-and-client-certificates). |

Every request (reads, writes and the connection check) sends `Accept-Encoding: gzip, deflate, br`
and unpacks the response. A server that ignores the header sends a plain response, which works
the same way. `max_response_mb` applies to the unpacked size, so a small compressed page that
expands past the limit still fails.

### Allowed hosts

Every request carries this connection's credentials, so the connector never follows a redirect,
a pagination link, an export download URL or a stored resume token to a host outside
`base_url`'s own origin (scheme, host and port) unless the host is listed in `allow_hosts`.

When `base_url` is `https://`, an `allow_hosts` host is reached over `https` only: a link or
redirect to `http://<allowed host>` is refused, since it would send the token unencrypted. An
`http://` `base_url` may still reach allowed hosts over `http`.

`pz validate` warns ([`PZ0364`](/reference/error-codes/)) when an `auth:` block or an
`Authorization` header is sent to an `http://` `base_url`. Loopback addresses are exempt.

### Auth

| Type | YAML | Where the credential goes |
|---|---|---|
| API key | `auth: { type: api_key, key: "${API_KEY}", header: X-Api-Key }` or `..., param: api_key` | A request header or a query parameter, exactly one of `header`/`param`. Query-parameter keys are redacted in error messages and logs. |
| Bearer token | `auth: { type: bearer, token: "${TOKEN}" }` | `Authorization: Bearer <token>` header. |
| Basic | `auth: { type: basic, user: "${USER}", password: "${PASSWORD}" }` | `Authorization: Basic <base64(user:password)>` header. |
| Azure AD | `auth: { type: azure_ad, method: service_principal, ... }` | Signs in to Microsoft Entra ID and sends `Authorization: Bearer <access token>`. See below. |
| OAuth2 client credentials | `auth: { type: oauth2_client_credentials, token_url: ..., ... }` | Fetches a token from any OAuth2 token endpoint and sends `Authorization: Bearer <access token>`. See below. |
| OAuth2 refresh token | `auth: { type: oauth2_refresh_token, token_url: ..., refresh_token: ..., ... }` | Exchanges a refresh token for access tokens and sends `Authorization: Bearer <access token>`. See below. |
| Login session | `auth: { type: session, login: { ... }, token_pointer: ..., ... }` | Sends a login request, reads a token from its response, and sends that token on every request. See below. |

Credentials belong in environment variables, never literal in YAML. See
[Secure connection config](/how-to/secure-connection-config/).

The three OAuth2 types cache the access token and refresh it up to five minutes before it
expires (half its lifetime for short-lived tokens). A sign-in failure is reported without the
secret or the token. Retries are left to the engine's `retry:` policy. When the API answers `401`:

- to a token it never accepted, the read fails permanently, with a hint to check `scope` and the
  app's access grant;
- to a token it accepted before, the token is dropped and the error is transient, so the engine's
  retry signs in again.

#### `azure_ad`

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

| Key | Required | Meaning |
|---|---|---|
| `method` | Yes | `service_principal`, `managed_identity`, or `credential_chain`. |
| `scope` | Yes | The API's `<resource>/.default`, for example `https://graph.microsoft.com/.default`. `pz validate` warns about any other form; a scope Entra refuses fails with a hint naming it. |
| `tenant_id` | `service_principal` | A GUID or a domain such as `contoso.onmicrosoft.com`. A malformed value is refused at validation. |
| `client_id` | `service_principal` | The app registration's client id. With `managed_identity`, set it to use a user-assigned identity; omit it for the system-assigned one. |
| `client_secret` | One of these two for `service_principal` | The app's client secret. |
| `certificate_path` | One of these two for `service_principal` | A certificate file for certificate sign-in. A relative path resolves against the project directory; `~/` expands to the home directory. `pz validate` warns when the file is inside the project directory, where it is easily committed. |
| `certificate_password` | No | Password for `certificate_path`. |
| `authority_host` | No | An absolute `https` URL of a non-public Entra authority (sovereign clouds). |

`managed_identity` uses the identity of the Azure host pz runs on. `credential_chain` tries the
default Azure credential chain, which includes environment variables and `az login`, so it suits
a developer machine. `timeout_seconds` bounds each sign-in request; the Azure CLI step of
`credential_chain` has its own timeout.

#### `oauth2_client_credentials`

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
    params: { audience: "https://api.vendor.example/" }
```

| Key | Required | Default | Meaning |
|---|---|---|---|
| `token_url` | Yes | — | The token endpoint. Must be `https` (`http` only for localhost) and must not embed credentials. |
| `client_id` | Yes | — | The client id. |
| `client_secret` | Yes | — | The client secret. |
| `scope` | No | — | Sent as the `scope` form field when set. |
| `client_auth` | No | `body` | `body` sends the client id and secret as form fields; `basic` sends them as an `Authorization: Basic` header. |
| `params` | No | `{}` | Extra form fields for the token request, such as `audience`. `grant_type`, `client_id`, `client_secret` and `scope` cannot be set here. |

#### `oauth2_refresh_token`

For APIs where a person signs in once and grants access, such as Google's APIs. A person obtains
the refresh token once, through the provider's consent flow, and you pass it to pz as an
environment variable. pz exchanges it for access tokens with `grant_type=refresh_token`.

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

| Key | Required | Default | Meaning |
|---|---|---|---|
| `token_url` | Yes | — | The token endpoint, with the same rules as for `oauth2_client_credentials`. |
| `client_id` | Yes | — | The client id. |
| `refresh_token` | Yes | — | The refresh token. |
| `client_secret` | No | — | The client secret. Omit it for a public client. |
| `client_auth` | No | `body` | `body` or `basic`, as for `oauth2_client_credentials`. `basic` needs `client_secret`. |
| `scope` | No | — | Sent as the `scope` form field when set. |
| `params` | No | `{}` | Extra form fields for the token request. |
| `rotation` | No | `refuse` | What to do when the token response carries a different `refresh_token`. See below. |

Token caching, `401` handling, `token_url` rules and `proxy`/`tls` work as for
`oauth2_client_credentials`.

pz has nowhere to store a new refresh token, so it works only with refresh tokens that stay
valid. Some providers rotate them: the token response carries a new `refresh_token`, and the old
one may already be revoked. Microsoft Entra rotates on every refresh, and so do Xero, QuickBooks
and some Zoho setups. A response with no `refresh_token`, or with the same one, is fine. When the
value differs, `rotation` decides:

- `refuse` (the default): the read fails with the permanent error
  [`PZ0366`](/reference/error-codes/), and the new access token is not used. Configure the
  provider for non-rotating refresh tokens, authorize again, and update `auth.refresh_token`.
- `ignore`: the new access token is used, the configured `refresh_token` stays in use for later
  refreshes, and a notice says the provider rotated it. Use it only for providers that keep old
  refresh tokens valid, such as Microsoft Entra and Google. If the provider does revoke the old
  token, the next refresh fails with `invalid_grant`.

An `invalid_grant` answer means the refresh token is no longer valid: authorize again and update
`auth.refresh_token`. Any refresh token or client secret the provider echoes in its error text is
replaced with `***`.

#### `session`

For APIs that issue a token from a login request rather than from an OAuth2 token endpoint.

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

| Key | Required | Default | Meaning |
|---|---|---|---|
| `login.path` | One of these two | — | The login path, relative to `base_url`. |
| `login.url` | One of these two | — | An absolute `http(s)` login URL. It must not embed credentials. |
| `login.method` | No | `post` | `post` or `get`, in any case. A `get` cannot have a body. |
| `login.body` | No | — | A map, sent as JSON or as a form with `body_format: form`, or a string sent as is. |
| `login.body_format` | No | `json` | `json` or `form`. A form body is a flat map of values; a field left empty (null, for example an unset variable) is a validation error. |
| `login.content_type` | No | `application/json` | The media type of a string `body`. |
| `login.headers` | No | `{}` | Headers sent on the login request only. |
| `token_pointer` | Yes | — | JSON pointer to the token in the login response, for example `/token`. A number is sent as its JSON text. |
| `inject` | No | `bearer` | Where the token goes on API requests: `bearer` (`Authorization: Bearer <token>`), `{ header: <name>, prefix: <text> }` (the header value is the prefix followed by the token), or `{ query: <name> }`. |
| `ttl` | One of these two | — | How long a session lasts, from `1s` to `30d`, for example `30m`. |
| `expires_in_pointer` | One of these two | — | JSON pointer to the session's lifetime in seconds in the login response, as a number or a string. |
| `reauth_status` | No | `[401]` | Statuses from the API that mean the session expired, for example `[419, 440]`. Any 4xx except `407` and `429`. `401` always counts: a list adds to it. |

How the login behaves:

- The body is sent literally. `{{ }}` bindings are not expanded in it, so a password containing
  `{{` goes on the wire unchanged. `${VAR}` references are substituted when `connections.yml`
  loads, as everywhere else.
- Connection `headers:` are not sent on the login, only `login.headers`.
- The login must go to `base_url`'s origin or an `allow_hosts` host, and it uses the
  connection's `proxy` and `tls`. A redirect is not followed.
- A login answered `401` or `403` fails permanently and is never retried (see
  [Refused sign-ins](#refused-sign-ins)). `408`, `429` and `5xx` are transient, waiting for the login's
  `Retry-After` or, on a `429` or `503` without one, the connection's
  [`retry_after`](#wait-times-from-another-header) header.
- A login response over 1 MiB, a missing, empty or object token, or a token with control
  characters fails permanently. A header or bearer token must be printable ASCII.
- Each node that reads or writes through the connection logs in once.
- A `401` (or a `reauth_status` code) from the API on a session that worked before drops the
  session, and the engine's retry logs in again. The same status on a fresh session fails
  permanently, with a hint to check `inject`.
- A query token (`inject: { query: ... }`) is redacted from messages and is never stored in a
  checkpoint; a resumed read adds the current one. Its name cannot be a query parameter that
  pagination sets, such as `page` or `offset`.

Cookie-based sessions, and tokens returned in a response header, are not supported.

#### Refused sign-ins

pz makes one refused sign-in per connection per run. A session login answered `401` or `403`, a
refresh token refused with `PZ0366`, `invalid_grant`, `invalid_client` or `unauthorized_client`:
later reads, writes and nodes of the same run that use the same credentials fail at once with the
same message, without sending anything. A provider that locks accounts after repeated failures
therefore sees one attempt per run. Scheduled runs each try again, once.

The rule holds for the life of the pz process. Under `pz mcp`, which stays running, restart the
server after an account is unlocked without a change to its configuration.

### Proxy

With no `proxy` key, the connection uses the system's default proxy settings, as before.
`proxy: none` turns proxying off, including any proxy the environment sets.

```yaml title="connections.yml"
partner:
  connector: http
  base_url: https://partner.example.com/api
  proxy:
    url: http://proxy.corp.example:3128
    user: ${PROXY_USER}
    password: ${PROXY_PASSWORD}
    bypass: ["*.corp.example", internal-api]
```

| Key | Required | Meaning |
|---|---|---|
| `url` | Yes | An `http://` URL with only a scheme, host and optional port. The TLS connection to an `https` target still runs end to end through the proxy. A URL with a user name or password in it is refused. |
| `user`, `password` | No, set together | Basic authentication to the proxy. |
| `bypass` | No | Hosts reached directly. An entry is an exact host name, or `*.suffix` for any host under that suffix (not the bare suffix itself). Loopback is always reached directly. |

A proxy that answers `407` fails the request permanently, naming `proxy.user`/`proxy.password`.

### TLS: private CA and client certificates

```yaml title="connections.yml"
partner:
  connector: http
  base_url: https://partner.example.com/api
  tls:
    ca_file: certs/corp-root.pem
    client_certificate:
      path: certs/pz-client.pfx
      password: ${CLIENT_CERT_PASSWORD}
```

| Key | Required | Meaning |
|---|---|---|
| `ca_file` | No | A PEM file of CA certificates to trust in addition to the system roots. An anchor may be an intermediate CA. |
| `client_certificate.path` | With `client_certificate` | A PKCS#12 file (`.pfx`/`.p12`), or a PEM certificate (`.pem`, `.crt`, `.cer`) with `key_path`. |
| `client_certificate.key_path` | With a PEM certificate | The PEM private key. Not allowed with a `.pfx`/`.p12`, which holds its own key. |
| `client_certificate.password` | No | Password for the PKCS#12 file or the encrypted key. |

Relative paths resolve against the project directory, and `~/` expands to the home directory.

`ca_file` adds trust; it never removes checks. Expiry and host name checks always apply, and
there is no option that disables certificate validation. A chain that ends at a `ca_file` anchor
is accepted only when every certificate between the server's own and the anchor was sent by the
server or is in `ca_file`; certificates that happen to be in the machine's certificate stores do
not complete it.

The client certificate is presented to `base_url`'s origin and to the `allow_hosts` hosts this
connection reaches with its credentials, for example a next-page link. It is not presented on
credential-free requests to other hosts (file downloads from a pre-signed URL), or to an OAuth2
token endpoint on another origin.

`proxy` and `tls` apply to dataset reads, sink writes, the connection check and OAuth2 token
requests. With `auth.type: azure_ad`:

- `service_principal` uses them;
- `managed_identity` ignores them, since it talks to a local endpoint on the Azure host;
- `credential_chain` combined with `proxy` or `tls` is refused at validation, since its
  developer-tool credentials run outside pz.

Failures name the setting to fix:

| Failure | Class | Message points at |
|---|---|---|
| The server's certificate is not trusted | Permanent | `tls.ca_file` (an expired certificate or a host name mismatch is always refused) |
| The TLS handshake fails for another reason | Permanent | `tls.client_certificate` |
| The proxy answers `407` | Permanent | `proxy.user`/`proxy.password` |
| The connection drops while a client certificate is configured | Transient | `tls.client_certificate` (a server refusing a certificate can look like a reset) |

### Wait times from another header

Some APIs state how long to wait in a header other than `Retry-After`. Name it with `retry_after`:

```yaml title="connections.yml"
graph:
  connector: http
  base_url: https://graph.microsoft.com/v1.0
  retry_after: { header: x-ms-retry-after-ms, kind: ms }
```

| `kind` | The header holds |
|---|---|
| `seconds` | A delay in seconds. Decimals are accepted. |
| `ms` | A delay in milliseconds. |
| `epoch` | A Unix time in seconds, such as `X-RateLimit-Reset`. |

The header is used when a `429` or `503`, or a response an [`on_status`](#status-rules-on_status)
rule makes transient, carries no usable `Retry-After`. It applies to reads, to sink requests and to
a `session` login. The wait is capped at 600 seconds; a stated wait above a day also adds a note to
check `kind`. A value that is not a number, or a wait that is already over (zero, or an epoch in
the past), is ignored with a note, and the next source of a wait applies. The wait moves the shared
pause of a [parallel read](#parallel-fetching) as a `Retry-After` does. pz still never retries a
request itself: the wait goes to the engine's [retry policy](/how-to/tune-retries/).

## Read options

Shared keys (`columns`, `sync`, `retry` under `read:`, and `rate_limit` on the connection) are
documented in [connections.yml reference](/reference/connections-yml/).

| Key | Required | Default | Meaning |
|---|---|---|---|
| `path` | Yes | — | Request-relative path, must start with `/`. May contain [bindings](#bindings), each value escaped as one path segment. |
| `query` | No | `{}` | Map of query parameters. Values may contain [bindings](#bindings). |
| `method` | No | `get` | `get` or `post`. See [POST reads](#post-reads). |
| `body` | No | — | `post` only. A map, sent as JSON or as a form, or a string. |
| `body_format` | No | `json` | `post` with a map `body` only. `json` or `form`. |
| `content_type` | No | `application/json` | `post` with a string `body` only. The request's media type, for example `application/graphql`. |
| `error_pointer` | No | — | JSON pointer to an error field in the response, for APIs that report errors with HTTP 200. |
| `on_status` | No | — | Rules that classify error responses as transient, permanent or skipped. See [Status rules](#status-rules-on_status). |
| `pagination` | No | none | One pagination block: `page`, `offset`, `link_header`, `cursor`, or `next_url`. See below. |
| `items` | No | body root | JSON pointer to the array of records, when the response body wraps it in an envelope. |
| `columns` | No | — | Column-to-type contract. With no contract, the entity lands the raw envelope shape below. |
| `cursor` | Raw mode, or with `stop_at_watermark` | — | Column name driving incremental extraction. In contract mode, the cursor is just a declared `columns` entry; set `cursor` to that name only for `stop_at_watermark`. |
| `cursor_type` | Raw mode only, required with `cursor` | — | One of the contract types: `int`, `bigint`, `double`, `decimal`, `varchar`, `boolean`, `date`, `timestamp`. |
| `cursor_pointer` | No | `/<cursor>` | JSON pointer to the cursor's value in one record, when it differs from a same-named field. |
| `cursor_order` | No | inferred at run time | `asc` or `desc`: how the API serves records relative to the cursor. Makes a truncated crawl's safety checkable at compile time. |
| `stop_at_watermark` | No | `false` | With `cursor_order: desc`, stop the crawl at the first page the watermark already covers. See [Newest-first feeds](#newest-first-feeds). |
| `watermark_format` | No | `iso8601` | How `{{ watermark }}` and `{{ window_upper }}` render. See [Watermark formats](#watermark-formats). |
| `watermark_time_zone` | No | `UTC` | An IANA zone id in which `date` and custom watermark formats render. See [Time zones](#time-zones). |
| `epoch_unit` | No | — | `s` or `ms`: read JSON numbers in timestamp columns as Unix time. See [Epoch timestamps](#epoch-timestamps). |
| `delta_pointer` | No | — | JSON pointer to a delta link on the last page, for change-feed APIs. Not allowed with `method: post`, `file:`, `for_each:` or `pagination.concurrency`. |
| `max_pages` | No | `50000` ceiling | Caps a single run's crawl. |
| `run_date` | No | `{ offset_days: 0, timezone: UTC, format: yyyy-MM-dd }` | Configures the `{{ run_date }}` binding. See [Bindings](#bindings). |
| `file` | No | — | Read the response as a file instead of a JSON page. See [Files](#files). |
| `export` | No | — | Start an asynchronous export job, poll it, then download its file. Requires `file`. See [Export jobs](#export-jobs). |
| `for_each` | No | — | A list request whose records each drive one item request. See [One request per record](#one-request-per-record-for_each). |

### Landing modes

With no `columns:`, every record under `items` lands as one row of a fixed raw envelope:

| Column | Type | Meaning |
|---|---|---|
| `payload` | `varchar` | The record's JSON text, verbatim. |
| `pz_page` | `int` | Zero-based page index within the run. |
| `pz_fetched_at` | `timestamp` | Request-time UTC when the page was fetched. |
| `pz_item` | `varchar` | `for_each` datasets only: a JSON object of the item's declared fields. |
| *(cursor name)* | *(`cursor_type`)* | Present only when `cursor`/`cursor_type` are set. |

Declaring `columns:` instead types the fields you want at extraction time. Extra JSON keys are
ignored; a declared key absent from a record lands as null. File datasets have their own raw
envelope; see [Files](#files).

#### Nested fields

A contract column reads the record's top-level key of the same name. To read a nested value, use
the column's long form with `pointer`, a JSON pointer into the record:

```yaml title="connections.yml"
jira:
  connector: http
  base_url: https://jira.example.com/rest/api/3
  auth:
    type: basic
    user: ${JIRA_USER}
    password: ${JIRA_TOKEN}
  entities:
    issues:
      read:
        path: /search
        items: /issues
        pagination: { strategy: offset, param: startAt, size_param: maxResults, size: 100 }
        columns:
          key: varchar
          status: { type: varchar, pointer: /fields/status/name }
          assignee_email: { type: varchar, pointer: /fields/assignee/emailAddress, redact: true }
          updated: { type: timestamp, pointer: /fields/updated }
```

- A pointer starts with `/`, and escapes `~` and `/` in a key as `~0` and `~1`. An array index is
  a plain number (`/tags/0`); `01`, `+1` or an index with blanks selects nothing.
- A step that is missing lands null. An object or array at the pointer lands in a `varchar`
  column as JSON text.
- It works for JSON pages and JSON files, with `redact`, and on the incremental cursor column.
- It is refused on a column filled from a `for_each` field, and with `csv`, `tsv` and `xml` files.
- Changing a pointer changes the source's node id, as changing any read option does.

`pointer` is http-only: on any other connector it is
[`PZ0301`](/reference/error-codes/), both in `pz validate` and when `pz run` opens the source.

```yaml title="connections.yml"
github:
  connector: http
  base_url: https://api.github.com
  auth: { type: bearer, token: "${GITHUB_TOKEN}" }
  entities:
    issues:
      read:
        path: /repos/duckdb/duckdb/issues
        query:
          state: all
          since: "{{ watermark }}"
        pagination: { strategy: link_header }
        columns:
          id: bigint
          title: varchar
          updated_at: timestamp
        sync:
          mode: incremental
          cursor: updated_at
```

### Bindings

`path`, `query` values and string values in `body` may contain these bindings:

| Binding | Value |
|---|---|
| `{{ watermark }}` | The stored watermark of an incremental dataset. See [Incremental extraction](#incremental-extraction). |
| `{{ window_upper }}` | The upper bound of the current window, with `sync: { max_window: ... }`. |
| `{{ run_date }}` | The day of the run, shifted and formatted by `run_date:`. |
| `{{ item.<name> }}` | In a `for_each` item request only: a field of the current list record. |

`run_date:` takes `offset_days` (whole days, -36500 to 36500, default `0`), `timezone` (an IANA
zone id such as `Europe/Bucharest`, default `UTC`) and `format` (built from `y`, `M`, `d` and the
separators `-`, `_`, `/`, `.` and space; default `yyyy-MM-dd`). The date is computed once per read,
so the requests of one read agree on it even across midnight.

A binding that has no value yet, such as `{{ watermark }}` on the first run or under
`--full-refresh`:

- in `query`, omits the parameter entirely rather than sending it empty;
- in `body`, becomes JSON `null`; declare `sync: { initial: ... }` to avoid it;
- in `path`, is an error that names the fix.

Values are escaped by position: a path segment, a query value, a typed JSON value in a map body,
or form-encoded text. A value is never expanded a second time.

### Pagination

Declare exactly one `pagination:` block.

| Strategy | YAML | When to use it |
|---|---|---|
| Link header | `pagination: { strategy: link_header }` | The API returns an RFC 8288 `Link` header (GitHub and most REST APIs that follow the convention). Follows the `rel="next"` link. |
| Next URL | `pagination: { strategy: next_url, pointer: /@odata.nextLink }` | The response body carries the next page's URL: `/@odata.nextLink` (Microsoft Graph, OData), `/links/next`, `/next`. A relative link resolves against the current request. |
| Page number | `pagination: { strategy: page, param: page, start: 1, size_param: per_page, size: 100 }` | Numbered pages. `param`/`start` default to `page`/`1`; `size_param`/`size` are optional and added together. |
| Offset | `pagination: { strategy: offset, param: offset, start: 0, size_param: limit, size: 100 }` | Offset/limit APIs. `param`/`start`/`size_param` default to `offset`/`0`/`limit`; `size` is optional. |
| Cursor token | `pagination: { strategy: cursor, pointer: /meta/next_cursor, param: cursor }` | Token-style APIs. `pointer` is a JSON pointer to the next page's token in the body, or `header` names a response header that carries it (exactly one of the two). The token is copied to `param` on the next request. See [Page tokens in headers](#page-tokens-in-headers). |

Link-header, next-URL and cursor-token crawls end when their own signal is absent (no next link,
or a missing/null/empty link or token); an empty page alone does not end them. Page-number and
offset crawls end on an empty page. A crawl exceeding `max_pages`, or one that revisits a URL it
already requested, fails with a permanent error rather than looping. Every next link is checked
against [allowed hosts](#allowed-hosts).

An offset crawl advances by the number of records each page actually returned, not by `size`, so
an API that serves fewer rows than asked cannot make the crawl skip any.

Page-number and offset crawls also accept `stop_on_short_page: true`: a page shorter than `size`
ends the crawl, for APIs that clamp an out-of-range page number to the last real page instead of
returning an empty one. It requires `size` (a short page is judged relative to the requested
size). Two caveats: an API that serves fewer rows than `size` on every page stops the crawl after
page one, and a total row count that is an exact multiple of `size` still needs `max_pages` to end
the crawl, since every page it serves is full.

All five strategies work with checkpointed resume: a retried read continues from the page it
reached.

| Pagination key | Default | Meaning |
|---|---|---|
| `location` | `query` | `body` writes the page number, offset or cursor into a `post` read's JSON body instead of the URL. See [POST reads](#post-reads). `header` sends a cursor token in a request header; see [Page tokens in headers](#page-tokens-in-headers). |
| `header` | — | `cursor` only: the response header holding the next page's token, instead of `pointer`. |
| `concurrency` | `1` | 1–16. Fetch up to this many pages at once. See [Parallel fetching](#parallel-fetching). |

`pz validate` reports an unknown `location`. At run time, a GET read ignores it with a notice; a
POST read fails.

#### Page tokens in headers

Some APIs hand out the next page's token in a response header, or expect it back in a request
header. Azure Cosmos DB does both with `x-ms-continuation`:

```yaml title="connections.yml"
        pagination:
          strategy: cursor
          header: x-ms-continuation
          location: header
          param: x-ms-continuation
```

`header:` reads the token from a response header; `location: header` sends it in the request
header named by `param`. Each works without the other: a header token can go into the query
(`location: query`) or a POST body (`location: body`), and a body token can go into a header. Both
work on the `for_each` list request too.

- A missing or empty header ends the crawl. A header that appears twice in one response fails the
  read.
- A token sent in a header must be visible ASCII, with no whitespace at either end. Otherwise the
  read fails, without showing the token.
- The request header cannot be one pz or the HTTP stack sets: `Authorization`,
  `Proxy-Authorization`, `Cookie`, `Host`, `Connection`, `Transfer-Encoding`, `Expect`, `TE`,
  `Upgrade`, a content header (`Content-*`, `Expires`, `Last-Modified`, `Allow`), or a header the
  connection's `headers:`, `api_key` auth or session `inject.header` already sets. `pz validate`
  reports a clash, and the read is refused before any request.
- The page header is kept across redirects, and counts when checking for a repeated request.
- A checkpoint stores the URL, the body and the page header only, never connection headers or
  credentials.

### POST reads

`method: post` sends a request body, for APIs that take their query in the body: Elasticsearch or
OpenSearch `_search`, GraphQL, and report endpoints.

- A map `body` is sent as JSON, or as a form with `body_format: form` (a flat map of scalars).
- A string `body` is sent as is, with `content_type` (default `application/json`).
- String values in either form may contain [bindings](#bindings).

```yaml title="connections.yml"
search:
  connector: http
  base_url: https://search.example.com
  auth: { type: api_key, key: "${SEARCH_KEY}", header: Authorization }
  entities:
    orders:
      read:
        path: /orders/_search
        method: post
        body:
          sort: [{ updated_at: asc }, { id: asc }]
          query:
            range:
              updated_at: { gt: "{{ watermark }}" }
        items: /hits/hits
        cursor: updated_at
        cursor_type: timestamp
        cursor_pointer: /_source/updated_at
        pagination:
          strategy: offset
          location: body
          param: /from
          size_param: /size
          size: 500
```

With `pagination.location: body`, `param` and `size_param` are JSON pointers into the body, for
example `/from` and `/size` or `/variables/after`. Each pointer must name an existing member of the
body, or a new last member of an existing object. `size` requires `size_param`. `location: body`
needs a map body sent as JSON, and applies to `page`, `offset` and `cursor`; `link_header` and
`next_url` follow URLs.

`error_pointer` fails the read when the field it points at is present and not `null`, `false`, or
an empty array or object. The error's first `message` is quoted. Set it to `/errors` for GraphQL,
which reports errors with HTTP 200. The failure is permanent.

A `307` or `308` redirect keeps `POST` and the body; `301`, `302` and `303` switch to `GET` without
a body.

Limits:

- A POST read cannot use `delta_pointer`.
- Elasticsearch `search_after` is not supported, so `from`/`size` paging cannot pass
  Elasticsearch's default 10,000-hit window (the request fails).
- Point a read only at an endpoint with no side effects: a retry or a resume sends the request
  again.

### Status rules (`on_status`)

By default a `408`, `429` or `5xx` response is transient (the engine's retry tries again) and
every other error status is permanent. `on_status` changes that for the responses you name, with
rules tried in order:

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
        pagination: { strategy: link_header }
        on_status:
          - { status: 403, body_contains: "secondary rate limit", action: transient, retry_after: 60s }
          - { status: 503, body_contains: "maintenance", action: permanent }
```

| Rule key | Required | Meaning |
|---|---|---|
| `status` | Yes | A code from 400 to 599 other than `407`, a class `4xx` or `5xx`, or a list of those. |
| `body_contains` | No | Text the response body must contain, matched without regard to case. A file download matches the first 64 KiB of the error body. |
| `action` | Yes | `transient`, `permanent` or `skip`. |
| `retry_after` | No | `transient` only: a wait such as `30s` or `2m`, above zero and up to `600s`. |

The first matching rule wins; a response no rule matches gets the built-in classification.

- **`transient`** makes the response retryable, such as GitHub's `403` secondary rate limit. Its
  wait is the response's `Retry-After`, else the connection's
  [`retry_after`](#wait-times-from-another-header) header, else the rule's `retry_after`, else
  the engine's backoff. In a parallel read, the wait pauses every request of the read.
- **`permanent`** fails the read, naming the rule and quoting the start of the body.
- **`skip`** ends the read with a notice saying 0 rows landed. See below.

A rule only classifies the response; the engine's [retry policy](/how-to/tune-retries/) does any
retrying.

Some cases are handled before the rules: a proxy `407`, a `401` (or a session `reauth_status`
code) handled by a token sign-in (`azure_ad`, the OAuth2 types, `session`), and a `410` on a
replayed delta link. Rules then come before `for_each.on_missing`.

A dataset's rules cover its own requests, which in a `for_each` dataset are the item requests.
`for_each.on_status` covers the list request. Neither inherits from the other.

**`skip`.** A skip rule applies only to a read's first request: the first page, a `for_each`
item's first page, or a direct file download. A skip rule that matches a later page, or the first
request of a resumed attempt, fails the read. Skipped `for_each` items are counted in the read's
end notice together with `on_missing` skips. Restrictions:

- A skip rule without `body_contains` must name exact codes, and none of `401`, `403`, `408` or
  `429`.
- `skip` is refused with `export`, and on a dataset that is or could be incremental: one with a
  raw `cursor`, a `{{ watermark }}` or `{{ window_upper }}` reference, an `incremental:` block,
  or a `columns:` contract (a contract column can be the cursor of a SQL-declared incremental).
  A skipped window would land nothing while the watermark moved past it. At run time, a skip
  rule that matches a read carrying a watermark fails the read instead.
- One case slips through: the first run, or a `--full-refresh`, of a raw-mode dataset made
  incremental in SQL with an upper bound, where no watermark is sent yet.

A skipped read lands an empty table. An output in `replace` mode fed only by it is emptied for
that run.

A skip suits a non-incremental report that answers "no data" with an error on some days:

```yaml title="connections.yml"
    daily_report:
      read:
        path: /reports/daily
        query: { day: "{{ run_date }}" }
        run_date: { offset_days: -1 }
        on_status:
          - { status: 400, body_contains: "no data for period", action: skip }
```

**Export jobs.** Rules apply to the start, poll and download requests of an
[export job](#export-jobs). A transient rule that matches the start request fails the read
instead, since a retry would send the start again and could create a second job.

### Files

A dataset with a `file:` block reads the response body as a file instead of a JSON page:

```yaml title="connections.yml"
vendor:
  connector: http
  base_url: https://api.vendor.example
  auth: { type: bearer, token: "${VENDOR_TOKEN}" }
  entities:
    daily_sessions:
      read:
        path: /exports/daily/{{ run_date }}.zip
        run_date: { offset_days: -1 }
        file: { format: csv, members: "sessions_*.csv" }
        columns: { session_id: varchar, started_at: timestamp, duration_s: int }
```

| Key | Default | Meaning |
|---|---|---|
| `format` | required | `csv`, `tsv`, `json`, or `xml`. |
| `archive` | `auto` | `auto` detects a zip or gzip from the first bytes. `zip`, `gzip` or `none` force it. |
| `members` | — | A glob such as `sessions_*.csv` matched against each zip entry's full path: `*` and `?` match within one `/`-separated segment, `**` matches any number of segments, and matching is case-sensitive. Required for a zip. Needs `archive: zip` or `auto`. |
| `if_missing` | `error` | `error` fails when no member matches and lists the entries. `empty` reads zero rows and emits a notice naming the dataset and glob (for an export with several files, one notice counting the files with no match). |
| `file_column` | — | Contract mode only: adds a `varchar` column with the member path (or the file name). |
| `encoding` | `utf-8` | `utf-8`, `utf-16`, or `iso-8859-1`. A byte-order mark wins over it. |
| `delimiter` | `,` | `csv` only: one character. `tsv` always uses a tab. |
| `header` | `true` | `csv`/`tsv`: whether the first line holds column names. |
| `skip_lines` | `0` | `csv`/`tsv`: lines discarded before the header. |
| `layout` | `lines` | `json`: `lines` for NDJSON, or `document` for one JSON document whose records `items` points at. |
| `records` | required for `xml` | `xml`: the absolute element path of one record, for example `/report/items/item`. |

Several datasets can read different members of the same archive, each with its own format and
columns, so one daily zip becomes several tables.

How records map to columns:

- **CSV/TSV with a header** locate contract columns by name; without a header, by position.
- **JSON** records are objects, as for JSON pages.
- **XML** matches a column to a direct child element of that name, else to an attribute.
  Namespaces are ignored, and a DTD is refused.

With no `columns:`, a file dataset lands this raw envelope:

| Column | Type | Meaning |
|---|---|---|
| `payload` | `varchar` | The record as JSON text. A CSV row becomes an object keyed by header name, or `c1`..`cN` without a header. |
| `pz_file` | `varchar` | The archive member path, or the downloaded file's name. |
| `pz_row` | `bigint` | The record's 1-based position in that file. |
| `pz_fetched_at` | `timestamp` | Request-time UTC of the download. |
| `pz_item` | `varchar` | `for_each` datasets only. |
| *(cursor name)* | *(`cursor_type`)* | Present only when `cursor`/`cursor_type` are set. |

Downloads stream through a temporary file that is always deleted. `max_download_mb` caps the
download, and decompressed bytes are capped at 20 times that, so a zip bomb fails instead of
filling the disk. A `200` response with an error-page content type (`text/html`, or a JSON error
type for a non-JSON format) is refused instead of landed as rows.

A redirect or download to another host carries no credentials and no connection headers, and its
query string is hidden in messages. A file is read in one request, so a file dataset takes no
checkpoint, and `pagination`, `delta_pointer` and `max_pages` are refused.

### Export jobs

An `export:` block covers APIs that build a file asynchronously. The dataset's own request (often
`method: post`) starts the job; `status_path` is polled with `GET` until the job is ready; then the
file is downloaded and read per `file:`.

```yaml title="connections.yml"
analytics:
  connector: http
  base_url: https://analytics.example.com/api
  allow_hosts: [exports.s3.amazonaws.com]
  auth:
    type: oauth2_client_credentials
    token_url: https://analytics.example.com/oauth/token
    client_id: ${ANALYTICS_CLIENT_ID}
    client_secret: ${ANALYTICS_CLIENT_SECRET}
  entities:
    traffic:
      read:
        method: post
        path: /reports
        body: { metrics: [visits, bounces], day: "{{ run_date }}" }
        run_date: { offset_days: -1 }
        export:
          job_id: /id
          status_path: /reports/{job_id}
          status_pointer: /state
          ready: [done]
          failed: [failed, cancelled]
          message_pointer: /error/message
          download_pointer: /result/url
        file: { format: csv }
        columns: { day: date, visits: bigint, bounces: bigint }
```

| Key | Required | Default | Meaning |
|---|---|---|---|
| `job_id` | Yes | — | JSON pointer to the job id (a string or number) in the start response. |
| `status_path` | Yes | — | Path polled for the job's state, starting with `/`. `{job_id}` (at most once) and the [bindings](#bindings) expand in it. |
| `status_pointer` | Yes | — | JSON pointer to the state in the status response. |
| `ready` | Yes | — | Non-empty list of state values meaning the file is ready. |
| `failed` | No | `[]` | State values meaning the job failed. The read fails, quoting `message_pointer`. |
| `message_pointer` | No | — | JSON pointer to the failure message in the status response. |
| `download_pointer` | One of these two | — | JSON pointer to the download URL, or a list of URLs, in the ready status response. A relative URL resolves against `base_url`. See [Several result files](#several-result-files). |
| `download_path` | One of these two | — | Download path, starting with `/`. `{job_id}` and the bindings expand in it. |
| `poll_interval_seconds` | No | `10` | 1–3600. A `Retry-After` on a status response replaces it, up to 10 minutes. |
| `timeout_minutes` | No | `30` | 1–1440. A job not ready by then fails with a transient error, so the engine's retry starts a new job. |
| `cancel_path` | No | — | Path that cancels an unfinished job, starting with `/`, with `{job_id}` exactly once. The [bindings](#bindings) expand in it. See [Cancelling a job](#cancelling-a-job). |
| `cancel_method` | No | `delete` | `delete`, `post`, `put` or `patch`, in any case. Requires `cancel_path`. No body is sent. |

A pre-signed download URL on another host must be in `allow_hosts`, and is fetched without
credentials. `export:` cannot be combined with `for_each:`.

The start request is not retried on its own. A `5xx`, a dropped connection or a timeout on it is
still transient, so the engine's node retry sends a new start and begins a new job. Only a job
whose id pz knew can be [cancelled](#cancelling-a-job).

The job id is inserted into `status_path`, `download_path` and `cancel_path` escaped as one path
segment, so `projects/1/jobs/2` is sent as `projects%2F1%2Fjobs%2F2`. An id that is empty, has a
`/`-separated segment that is exactly `.` or `..`, or contains `\` or a control character, fails
the read before any poll.

#### Cancelling a job

With `cancel_path`, pz cancels a job that never became ready: one that ran past
`timeout_minutes`, reported a `failed` state, failed a poll, or was still running when the run was
cancelled. This keeps abandoned jobs from piling up on the vendor's side.

```yaml title="connections.yml"
        export:
          job_id: /id
          status_path: /reports/{job_id}
          status_pointer: /state
          ready: [done]
          failed: [failed]
          download_pointer: /result/url
          cancel_path: /reports/{job_id}
          cancel_method: delete
```

- A job that reached a `ready` state is never cancelled, even when its download or file read
  fails later.
- The cancel is sent at most once per job and never retried. It waits at most 10 seconds (5 once
  the run is cancelled, by a node timeout or Ctrl-C), and never longer than `timeout_seconds`.
- Only its status is read. Its outcome, success included, is a notice; the read fails with its own
  error.
- A job whose start request failed has no id, so it cannot be cancelled.

#### Several result files

When the API splits a result into several files, point `download_pointer` at the list of URLs:

```yaml title="connections.yml"
        export:
          job_id: /id
          status_path: /reports/{job_id}
          status_pointer: /state
          ready: [done]
          download_pointer: /result/files
        file: { format: csv }
        columns: { day: date, visits: bigint, bounces: bigint }
```

- Files are downloaded and read in list order, one at a time. Each gets the full single-file
  limits (`max_download_mb`, the decompression cap, the idle timeout), and only one is on disk at
  a time.
- Every URL is checked (a string, a valid URL, `allow_hosts`) before the first download.
- A URL listed twice is read once, with a notice that counts the duplicates. More than 1000
  entries fails the read.
- An empty list reads as no rows, with a notice.
- A `404` on any file of several fails the read.
- `file_column` names each row's own file. Under `if_missing: empty`, one notice counts the files
  with no matching member.
- There is no checkpoint: a retry starts a new job.

### One request per record (`for_each`)

For APIs that expose child data only per parent (`/orders/{id}/lines`), `for_each:` describes a
list request, and the dataset's own `path`, `query`, `body`, `pagination`, `items` and `file:`
describe the item request sent once per list record.

```yaml title="connections.yml"
shop:
  connector: http
  base_url: https://api.shop.example
  auth: { type: bearer, token: "${SHOP_TOKEN}" }
  entities:
    order_lines:
      read:
        for_each:
          path: /orders
          query: { updated_since: "{{ watermark }}" }
          items: /data
          pagination: { strategy: cursor, param: cursor, pointer: /next_cursor }
          fields: { order_id: /id, updated_at: /updated_at }
        path: /orders/{{ item.order_id }}/lines
        items: /lines
        columns: { order_id: varchar, updated_at: timestamp, sku: varchar, qty: int }
        sync: { mode: incremental, cursor: updated_at }
```

The list request takes the usual request keys: `path`, `query`, `method`, `body`, `body_format`,
`content_type`, `items`, `pagination`, `error_pointer`, `on_status` and `max_pages`. It can use
`{{ watermark }}`, `{{ window_upper }}` and `{{ run_date }}`; `run_date:` stays at dataset level and
is shared by both requests.

| `for_each` key | Required | Default | Meaning |
|---|---|---|---|
| `path` | Yes, unless `values` | — | The list request's path. |
| `fields` | Yes, unless `values` | — | Map of name to JSON pointer into each list record. Names use lowercase letters, digits and `_`, and do not start with a digit or `pz_`. |
| `values` | No | — | A literal list of item maps, used instead of a list request. See [Fixed item lists](#fixed-item-lists-values). |
| `dedupe` | No | `false` | Skip a record whose fields match an earlier record of the same read. See [Duplicate list records](#duplicate-list-records-dedupe). |
| `on_status` | No | — | [Status rules](#status-rules-on_status) for the list request. The dataset's own rules cover the item requests. |
| `on_missing` | No | `error` | `skip` moves on when an item's first request returns `404` or `410`, and reports the count in a notice at the end of the read. A `404` on a later page of an item still fails. |
| `max_items` | No | — | Stop after this many list records, with a notice. No further list page is fetched once it is reached. |
| `concurrency` | No | `1` | 1–16. Run up to this many items of one list page at once. See [Parallel fetching](#parallel-fetching). |

`{{ item.<name> }}` is valid in the item request's `path`, `query` and `body` only.

- **Escaping.** A value from the API is escaped by position and never expanded again. A path
  segment that item values turn into `.`, `..` or nothing is refused. Numbers are sent with their
  JSON text.
- **Missing values.** A referenced field that is missing, null, an object or an array fails the
  read, naming the list page, the record and the field.
- **No `?` or `#` in the item path.** Put query parameters in `query:`.
- **String JSON bodies.** In a string `body` with a JSON content type (`application/json`, the
  default, or any `+json` type), `{{ item.* }}` is refused at validation, since a value spliced
  into JSON text could change its structure. Write the body as a map; there the reference is a
  typed JSON value.

Item fields land on rows. In contract mode, a `columns:` entry named like a field is filled from
the item. In raw mode, the `pz_item` column holds every declared field as a JSON object (a field
missing from the record as `null`). The cursor may be an item field in either mode.

Each item crawl pages to its last page before the next item starts. In file mode the item request
is a download, so "list the exports, then download each one" works. An item-level `max_pages`
that stops items before their last page is reported in one notice at the end of the read. Notices
for `max_items` and item `max_pages` count per attempt.

**Resume.** A retried read resumes from a checkpoint at the item and page it reached. The list
page is fetched again. If the record the checkpoint was taken at is no longer at the same
position (the list shifted), the list page is read again from its first record, rather than
mislabelling items or skipping records. Duplicates are therefore possible: land a `for_each`
dataset into a `strategy: merge` sink keyed on the item and record ids. Skipped-item counts are
carried in the checkpoint, so they are reported across retries. A file-mode item checkpoints only
between items.

#### Fixed item lists (`values`)

For "the same endpoint per region, account or metric", list the items in the YAML instead of
fetching them:

```yaml title="connections.yml"
    regional_sales:
      read:
        for_each:
          values:
            - { region: eu, currency: EUR }
            - { region: us, currency: USD }
            - { region: apac, currency: USD }
        path: /sales/{{ item.region }}
        query: { currency: "{{ item.currency }}", day: "{{ run_date }}" }
        items: /rows
        columns: { region: varchar, currency: varchar, sku: varchar, amount: decimal }
```

- Each map's keys are the item fields, named like `fields` names. Every entry must have the same
  keys. Values are strings, numbers, booleans or null.
- The item request, escaping, `pz_item`, `on_missing`, `dedupe` and `concurrency` work as with a
  list request.
- The list-request keys (`path`, `query`, `method`, `body`, `body_format`, `content_type`,
  `items`, `pagination`, `error_pointer`, `max_pages`, `fields`, `max_items`, `on_status`) are
  refused next to `values`.
- At `concurrency: 1` a checkpoint falls after every item. With `concurrency` N above 1, the
  values are read in groups of 4×N with a checkpoint after each group, so a retry re-reads at
  most one group. If the `values` list was edited before a retry, the read starts again from the
  first value, with a notice.

#### Duplicate list records (`dedupe`)

Some list endpoints return the same record more than once, for example when records move between
pages during the crawl. `dedupe: true` skips a list record whose declared fields all equal those of
an earlier record of the same read:

- The first occurrence wins. Fields compare as JSON values, so `"1"` and `1` differ, and a
  missing field equals a null one.
- One notice at the end of the read gives the count and the first duplicate.
- Skipped duplicates do not count toward `max_items`.
- It is per attempt: a retry that resumes mid-list remembers only the records before its position
  on the resumed list page, so it may read an item first seen on an earlier page again.
- The set of seen items costs roughly 30–60 bytes per distinct item, with no cap.

**Refusals.**

- On an incremental dataset (a declared watermark, a raw `cursor:`, or a `{{ watermark }}`/
  `{{ window_upper }}` reference in either request), `for_each.max_items`, `for_each.max_pages`
  and the item-level `max_pages` are refused at validation. An item cut short would be skipped
  for good once the watermark passes it.
- The 50,000-page ceiling stays an error everywhere.
- `for_each` cannot be combined with `delta_pointer` or `export:`.

### Parallel fetching

Two opt-in keys fetch in parallel within one read. Both are integers from 1 to 16; the default `1`
behaves exactly as a sequential read.

`pagination.concurrency` reads up to N pages at once. Pages still land in order, and the crawl
ends on the same signal as a sequential one; requests issued past the end are cancelled. It needs
`strategy: page`, applies only to datasets without `for_each` (use `for_each.concurrency` there),
and cannot be combined with `delta_pointer`.

`for_each.concurrency` runs up to N items of one list page at once:

- Rows from different items interleave; each item's rows stay in page order.
- The next list page is fetched only after every item of the current page has finished.
- Checkpoints are taken only at these list-page boundaries, so a retry re-fetches the current
  list page's items. A list page whose items yield no rows gets no checkpoint of its own.
- The first failing item in record order is reported, and the other running items are cancelled.
- File items use one scratch directory per worker, so disk use can reach N times the size of one
  download.

When concurrency is above 1, a `429` or `503` response with `Retry-After` pauses every request of
that read until that time, capped at 600 seconds. With concurrency 1 there is no shared pause; the
engine's retry still honours `Retry-After` for the failed request.

Set [`rate_limit:`](/how-to/throttle-a-source/) on the connection when using concurrency. The
shared pause only reacts after the API has refused requests; `rate_limit:` keeps the read under
the API's limit in the first place.

### Incremental extraction

Reference the stored watermark in `query`, `path` or `body` with `{{ watermark }}`. On the first
run, or under `--full-refresh`, a query parameter is omitted entirely rather than sent empty (see
[Bindings](#bindings) for `path` and `body`). For a large historical range, declare
`sync: { max_window: ... }` and reference `{{ window_upper }}` to extract bounded `(lower, upper]`
windows one run at a time instead of one open-ended pull. See
[Incremental loads](/concepts/incremental-loads/) for the full watermark and window model.

To re-read a margin for late-arriving records, declare the incremental in the pipeline's SQL with
the margin subtracted: `WHERE updated_at > {{ watermark('api', 'orders') }} - interval 2 hour`. The
engine evaluates that expression before the read, so `{{ watermark }}` in the request carries the
lowered value. See [Re-read a margin (lookback)](/concepts/incremental-loads/#re-read-a-margin-lookback).

To catch up a long backlog with `max_window` and `until:`, repeat `pz run` until the node reports
`caughtUp: true`. Each run commits its own window. See [Backfill in slices](/how-to/backfill-in-slices/).

A daily file with a date column can catch up one missed day per run with a window:

```yaml title="connections.yml"
    daily_sessions:
      read:
        sync: { mode: incremental, cursor: day, initial: "2026-10-01", max_window: 1d }
        path: /exports/daily/{{ window_upper }}.zip
        file: { format: csv, members: "sessions_*.csv" }
        columns: { day: date, session_id: varchar, started_at: timestamp, duration_s: int }
```

The window's upper bound can reach today, whose file may not be published yet. That download
fails (`404`) and nothing is lost: the watermark stays, and a later run fetches the day. Use
`until:` or schedule the run after the vendor publishes.

#### Watermark formats

By default a timestamp watermark is sent as ISO 8601 in UTC, to whole seconds
(`2026-11-09T08:00:00Z`). `watermark_format` sends it in the form the API expects:

| Value | Sends |
|---|---|
| `iso8601` | The default, `2026-11-09T08:00:00Z`. |
| `epoch_s` | Unix time in seconds, `1794211200`. |
| `epoch_ms` | Unix time in milliseconds, `1794211200000`. |
| `date` | The date only, `2026-11-09`. |
| A custom format | Built from the letters `y M d H m s f`, for example `yyyy-MM-dd HH:mm:ss`. |

A custom format may use:

- `yy` or `yyyy`, `M` or `MM`, `d` or `dd`, `H` or `HH` (24-hour), `m` or `mm`, `s` or `ss`, and
  one to seven `f` for fractions of a second;
- the separators `-`, `_`, `/`, `.`, `:`, `,` and space, the literal letters `T` and `Z`, and
  `'quoted text'` (without `\` or `"`).

Each letter appears once, and the letters must run from the year down without a gap: `yyyy-MM` and
`yyyyMMddHH` are accepted, `MM-dd` and `yyyy-MM-dd mm` are not. Month and day names, 12-hour
clocks and UTC offsets are not supported.

Every format has a unit, its finest letter. The lower bound (`{{ watermark }}`) is rounded down
to that unit, and the upper bound (`{{ window_upper }}`) is rounded up to the next one, so a window
is never narrower than asked: with `date`, a window ending at 08:00 on 9 November sends
`2026-11-10` as its upper bound. Rounding past the year 9999 fails the read.

Where the binding is a whole value in a JSON body, an epoch format is sent as a JSON number
rather than a string.

- A `date` cursor takes only `date` or a custom format with no time of day.
- A numeric or `varchar` cursor refuses the option.
- The option is refused when no request references `{{ watermark }}` or `{{ window_upper }}`.

A unit of a day or longer (`date`, `yyyy-MM`, `yyyyMMdd`) re-reads up to a whole day, month or year
on every run or window. Into an `append` sink those rows land again, so `pz validate` reports a
[`PZ0364`](/reference/error-codes/) warning for an incremental dataset whose cursor is not a date.
Use a finer format if the API takes one, or write with `strategy: merge`.

`date` assumes the API reads a date as the start of that day. An API that reads
`since=2026-11-09` as "after that whole day" would skip rows.

#### Time zones

`date` and custom formats render in UTC. For an API that reads its dates in local time, set
`watermark_time_zone` to an IANA zone id:

```yaml title="connections.yml"
        query: { modified_since: "{{ watermark }}" }
        watermark_format: yyyy-MM-dd HH:mm
        watermark_time_zone: Europe/Bucharest
```

The bounds are rounded in that zone's wall time. When a bound falls in an hour that a daylight
saving change skips or repeats, it moves to the safe side in 3-hour steps (earlier for the lower
bound, later for the upper), so the window only grows. A change that no step within 48 hours clears
fails the read rather than narrowing the window.

`watermark_time_zone` needs a `date` or custom `watermark_format`. It is refused with `iso8601` and
the epoch formats, with a format that writes `Z` or `UTC`, and on `date` cursors.

#### Epoch timestamps

An API that returns times as Unix numbers (`"updated": 1794211200`) needs `epoch_unit` to land them
in a `timestamp` column:

```yaml title="connections.yml"
    events:
      read:
        path: /events
        query: { since: "{{ watermark }}" }
        items: /data
        columns: { id: bigint, updated: timestamp }
        epoch_unit: s
        watermark_format: epoch_s
        sync: { mode: incremental, cursor: updated }
```

With `epoch_unit` set to `s` or `ms`, JSON numbers in `timestamp` contract columns, in a raw
`cursor_type: timestamp` cursor and in `for_each` item fields are read as Unix time. Strings are
still parsed as text. Pair it with the matching `watermark_format` so the watermark goes back in
the same unit.

- Values that look like the other unit are refused: under `ms`, anything below 1e11 (before
  1973-03-03) except exactly `0`; under `s`, anything after the year 3000.
- Microsecond and nanosecond epochs are not supported.
- Without `epoch_unit`, a JSON number in a `timestamp` column fails with a message naming
  `epoch_unit`.
- The option is refused with no timestamp column, and with `csv`, `tsv` and `xml` files.

#### Newest-first feeds

Some feeds serve the newest records first and have no "since" filter. `stop_at_watermark` reads
such a feed only down to what the last run already landed:

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

- The crawl stops at the first page that holds a record at or below the stored watermark. Those
  records are dropped, the newer ones on that page land, and a notice gives the page and the
  dropped count.
- Without a watermark (the first run, or `--full-refresh`) the whole feed is read.
- The feed must really be newest-first: within one attempt, a cursor value greater than the one
  before it fails the read. A retry that resumes mid-crawl checks from its resume page on.
- Records with a null cursor land on the pages read. Null-cursor records past the stop page are
  not read; the notice says so.
- It requires `cursor_order: desc` and `cursor` (with `cursor_type` in raw mode, or naming a
  `columns` entry in contract mode). `cursor` must be the incremental cursor.
- It is refused with `for_each`, `file`, `delta_pointer`, `max_pages` and `pagination.concurrency`
  above 1, so the crawl always ends at the watermark or at the end of the feed.
  [`PZ0229`](/reference/error-codes/) already refuses `max_pages` with `cursor_order: desc`.

## Write options

Per-write options are keyword arguments on the `sink()` call, alongside `strategy` and `keys`.

```sql title="pipelines/events_out.sql"
INSERT INTO {{ sink('webhook', 'events_out', strategy: 'append', path: '/events') }}
SELECT * FROM {{ ref('events_shaped') }}
```

| Option | Applies to | Default | Meaning |
|---|---|---|---|
| `path` | both | — | Required. Request-relative path, must start with `/`. Under `strategy: merge` it must contain a `{key}` token; under `append` the token is not allowed. |
| `method` | both | `post` (append), `put` (merge) | `post`, `put`, or `patch`. |
| `body_format` | `append` only | `json_array` | `json_array` (one `[...]` array per request) or `ndjson` (one JSON object per line). Setting it on `merge` is an error. |
| `rows_per_request` | `append` only | `500` | Rows chunked into each request. Setting it on `merge` is an error. |

`append` chunks rows into `rows_per_request`-sized requests; `merge` requires exactly one key
column and sends one keyed `PUT`/`PATCH` per row. `replace` is not supported: there is no way to
atomically overwrite an arbitrary endpoint's prior state. The connection's `auth`, `proxy` and
`tls` apply to writes as they do to reads.

## Capabilities

| Flag | Meaning |
|---|---|
| `BoundedWindow` | Honors an entity's upper watermark bound. |
| `SyncState` | Supports delta-link / change-feed reads via `delta_pointer`, for APIs with no orderable cursor. |
| `GatedOperations` | Every request routes through `rate_limit` pacing. |
| `StablePartitionIds` | Each page-fetch partition carries a stable id, enabling partition-scoped retry. |
| `CheckpointableReads` | A retried read can resume mid-crawl rather than restarting from page one. |
| `Merge` | The sink supports `strategy: merge`. |
| `CheckpointableWrites` | A retried write resumes past whatever prefix the destination already confirmed, instead of re-sending rows. |

## Notes

- Reads send `GET` or `POST`; there is no native scan or copy path in either direction.
- One partition per entity. Parallelism within it is opt-in through `pagination.concurrency` and
  `for_each.concurrency`.
- Redirects are followed by hand, at most 5 hops, and each hop is checked against
  [allowed hosts](#allowed-hosts).

## Related

- [Extract from an HTTP API](/how-to/extract-from-http-api/) for a worked walkthrough with
  auth setup and a full pagination example.
- [Download files and exports from an API](/how-to/download-files-from-an-api/) for zip
  archives, dated URLs and export jobs.
- [Call an API once per record](/how-to/call-an-api-per-record/) for `for_each` reads.
- [Connections.yml reference](/reference/connections-yml/) for the shared `read:`/`write:` keys.
- [Incremental loads](/concepts/incremental-loads/) for watermarks, bounded windows, and sync
  state.
- [Secure connection config](/how-to/secure-connection-config/) for keeping `auth` credentials out
  of the repository.
