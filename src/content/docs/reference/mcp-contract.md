---
title: "MCP contract"
description: "The result envelope, full tool table, and PZ06xx error codes for the pz mcp server, the stability contract AI agent clients can rely on."
sidebar:
  order: 9
---

`pz mcp` serves the current project to AI agents over the Model Context Protocol
(stdio only). This page is the stability contract for that surface: the result
envelope every tool returns, the full tool table, and the PZ06xx error codes the
MCP surface adds.

See [Use pz with an AI agent](/how-to/use-with-an-ai-agent/) for how to configure a
client.

## The envelope

Every tool returns one JSON object, serialized with the repo's byte-stable
`Utf8JsonWriter` discipline (fixed field order, no indentation — the example below
is pretty-printed for reading; the wire form is compact):

```json
{
  "ok": false,
  "applied": true,
  "errors": [
    {
      "code": "PZ0341",
      "message": "read option 'columns' is declared both in connections.yml and as a source() argument",
      "file": "pipelines/stg_orders.sql",
      "line": 12,
      "next_step": "declare the option on exactly one surface; remove one of the two declarations"
    }
  ]
}
```

That is a mutation whose edit was written (`applied: true`) but which left the
wider project broken, so self-verify reported errors. A success carries `result`
instead of `errors`:

```json
{"ok":true,"applied":true,"result":{"file":"connections.yml"}}
```

`errors` and `result` appear together in two places. `pz_project_overview` reports a
compile failure over an otherwise-loadable project as `ok: true` with both (see its row
below). The three **connection** mutation tools carry their `result` on the failure path
too (`ok: false`, `applied: true`), because a dropped entity is usually the very reason
self-verify now fails — a pipeline still `source()`s it — and reporting the drop only on
the success path would withhold the explanation exactly when it is needed. The entity and
pipeline mutation tools do not: on self-verify failure they emit `errors` alone.

| Field | Type | Description |
|---|---|---|
| `ok` | bool | Whether the tool call itself succeeded. For a gated execution tool this reflects whether the run *started cleanly* — a run that starts and later ends `completed_with_failures` or `fatal` is still `ok: true`, with that outcome inside `result.status`/`result.exit_code`, exactly like `pz run`'s own exit code is orthogonal to whether the invocation was well-formed. |
| `applied` | bool, optional | Present only on Author-group results — the eight mutation tools plus `pz_init_project`. `true` once the file edit has been written — including when the edit itself was fine but broke the wider project (self-verify errors ride `errors[]` while `applied` stays `true`). `false` means nothing was written. Omitted on introspect/verify/execute results, which have nothing to "apply". |
| `errors` | array, optional | Omitted when empty. Each entry is the JSON projection of the existing `PzError` aggregate — the same shape console and JSON renderers already use, now with all of `code`/`message`/`next_step` always present and `file`/`line` present only when known. |
| `errors[].code` | string | A `PZ####` code. |
| `errors[].message` | string | Human-readable cause. |
| `errors[].file` | string, optional | Omitted (never `null`) when the error has no associated file. |
| `errors[].line` | number, optional | Omitted (never `null`) when the error has no associated line. |
| `errors[].next_step` | string \| null | The error's hint text. Present as a key even when the underlying error carries no hint (some `PZ0201` forms) — in that case the value is JSON `null`, not an omitted key. |
| `result` | object, optional | Per-tool payload; shapes are listed in the tool table below. Present on success, and on the two failure paths described above: `pz_project_overview` carries a best-effort `result` alongside `errors` on a compile failure over an otherwise-loadable project (see that tool's row), and the connection mutation tools carry theirs so a `dropped_entities[]` explanation survives a failed self-verify. |

**Stability promise: fields are append-only; renaming or removing a field, a tool
name, or an error code, is a breaking change.** New fields may be added to any
result without notice; consumers must ignore fields they don't recognize. (Same
promise `docs/events.md` makes for the run-event stream — this is the equivalent
contract for the MCP surface.)

Input-shape violations (a missing argument, the wrong JSON type, an unknown
argument name) are MCP-level invalid-params (-32602) errors, not part of this
envelope — PZ codes are for project-level outcomes, mirroring how the CLI itself
splits argument parsing from validation. The server pre-validates every call
against the tool's own published input schema, so the error message names the
offending argument and the expected
type — `invalid params for 'pz_validate': argument 'connect' expects boolean,
got string` — instead of the protocol SDK's generic "An error occurred invoking
'`<tool>`'." text an agent cannot self-correct from.

The same guarantee holds one layer further in. A tool handler that throws an exception no
handler-level catch classified comes back as a normal `PZ0609` envelope carrying the
exception's type and message, rather than that SDK text with the exception discarded. It
is a backstop, never a diagnosis: a `PZ0609` in the wild means a `pz` handler is missing a
typed catch, and the message names which. Callers should treat it as a bug report to file,
not an argument to fix.

## Tool table

Every tool is prefixed `pz_`. "Gated" tools exist in the listing **only** when the
server was started with `pz mcp --allow-run` — absent, not present-but-refusing, so
an agent connected without that flag never plans around a tool it cannot call.

**Input names are snake_case**, exactly as spelled in the tables below and in each
tool's published JSON input schema (`flow_names`, `full_refresh`, `checks_yaml`,
`run_id`, ...) — the same style the envelope's own `next_step`/`run_id` fields use.
An input marked `?` (or given a default) is optional: it is absent from the schema's
`required` list and may be omitted entirely. Everything else is required. Input names
and their required-ness are part of the stability promise above.

### Introspect (read-only, always registered)

| Tool | Inputs | Result fields |
|---|---|---|
| `pz_project_overview` | — | `name`, `flows[]` (flow labels), `connections[]` (`name`, `connector`, `entities[]` of `{name, has_read, has_write}` — never a connection's config values), `pipelines[]` (`name`, `refs[]`, `sources[]` of `"<connection>.<entity>"`, `sinks[]` of `"<connection>.<entity>"`), `dag.nodes[]` (`id`, `name`, `kind`, `dependsOn[]`). On a compile failure over an otherwise-loadable project: `ok: true` with both a top-level `errors[]` and a best-effort `result` (flows/dag empty, connections/pipelines still list names). Only a load failure (e.g. malformed `project.yml`) falls back to a plain `ok: false` envelope. |
| `pz_connector_reference` | — | `connectors[]` of `{name, source, sink, capabilities, dataset_schema, connection_schema}`. `capabilities` is the `ConnectorCapabilities` flags enum's own `.ToString()` (e.g. `"ColumnPruning, PredicatePushdown, NativeScan, NativeCopy"`) — verbatim, not a machine vocabulary. `dataset_schema`/`connection_schema` are the connector's own published JSON Schemas, re-emitted verbatim. |
| `pz_entity_schema` | `connection` (string), `entity` (string) | `columns[]` of `{name, type}`, `source`: `"fetched"` when the columns came from a live connectivity probe (a contract-less entity), or `"declared_contract"` when they came from the entity's own YAML `columns:` contract (`ConnectivityValidator` never populates a live fetch for an entity that already declares one). Type vocabularies differ between the two: `"fetched"` types are Arrow-derived (`ContractTypes.Describe` strings, e.g. `Decimal128(10,2)`); `"declared_contract"` types are the literal YAML contract strings (e.g. `bigint`, `double`). Unknown connection/entity, or a csv/json entity with neither a live fetch nor a declared contract (see [Detect schema drift at run time](/how-to/schema-drift/)), comes back as `PZ0330`. Opens a real connection; still read-only — never writes `.pz/target/schemas.json`. |
| `pz_state` | — | `watermarks`/`sync_state`/`schema_baselines`, each `{corrupt: bool, entries[]}` (a corrupt state file reports `corrupt: true` with empty `entries` rather than failing the tool). `watermarks.entries[]`: `{key, cursor, type, value, run_id}`. `sync_state.entries[]`: `{key, token, run_id}`. `schema_baselines.entries[]`: `{key, hints_hash, run_id, columns[]}` of `{name, type}`. `latest_run`: `{run_id, status, node_counts}` or JSON `null` when no run exists yet. `node_counts` is `{"<status>": <count>, ...}`, grouped from the latest run's nodes. **Deliberately has no `started_at`** on `latest_run` — the underlying run-artifact read model (`PriorRun`) carries no such field; omitted rather than fabricated. |

### Documentation (read-only, always registered, network-backed)

The only tools that reach the network, and the only ones that take no project —
documentation is worth consulting before a project exists. They read the published
site (`https://pipelinez.dev` by default; set `PZ_DOCS_URL` to a mirror) via its
`/llms.txt` index and `/llms-full.txt` corpus. Unreachable is `PZ0607`, a real
error naming the URL, never an empty result.

| Tool | Inputs | Result fields |
|---|---|---|
| `pz_docs_list` | — | `docs[]` of `{slug, title, description?, group?, url}`. `slug` is the stable identifier `pz_docs_get` takes (e.g. `concepts/data-plane`); `description` and `group` are omitted when the page has none. Index order is the site's own grouping. |
| `pz_docs_search` | `query` (string), `limit` (int, default 10, clamped to 1..50) | `query` echoed, plus `hits[]` of `{slug, title, url, score, excerpts[]}`, best first. Lexical, not semantic — an exact token like `PZ0214` or `force_universal` is the case it is built for. Fields are weighted title > description > headings > code > prose; `score` is that weighted count and is comparable only within one response. Ties break by `slug`, so a repeated query returns a stable order. `excerpts[]` holds at most three matching lines, each truncated at 200 characters. An empty `query` is `PZ0608`. |
| `pz_docs_get` | `slug` (string) | `doc`: `{slug, title, description?, group?, url, markdown}` — the page's full markdown. Leading/trailing slashes on `slug` are tolerated. An unknown slug is `PZ0608`. |

### Verify (read-only, always registered)

| Tool | Inputs | Result fields |
|---|---|---|
| `pz_compile` | — | `nodes[]` of `{id, name, kind, dependsOn[]}`, `notices[]` (strings), `warnings[]` of `{code, message, file?, line?, hint?}`. Never writes `.pz/target/manifest.json`. |
| `pz_validate` | `connect?` (bool, default false) | `pipelines` (count), `connections_checked` (count), `undeclared_datasets[]` (`"<connection>.<entity>"` strings — contract-less entities `SqlDryCompiler` skipped). Tiers run cheapest-first (3 → 4 → 5) and stop at the first non-empty error list, exactly like `pz validate`; `connect: true` adds tier 5 (live connectivity + schema drift) but — unlike `pz validate --connect` — never writes `.pz/target/schemas.json`. |
| `pz_plan` | — | `nodes[]` of `{node, strategy, reason, pushdown?}`, `memory_budget_bytes`. `strategy` is one of `native_scan`, `native_copy`, `arrow_stream`, `duck_sql` — the same names `plan.json` and `pz plan`'s console table use. `pushdown` (when present): `{columns_pushed?, predicate_pushed}`. `reason` is the planner's own template-only text — never SQL or connection config. Never writes `.pz/target/plan.json`. |

All three verify tools are **policy-documented read-only**: they never write a
`.pz/target` artifact, unlike their CLI counterparts. A caller that wants an
artifact written (e.g. to warm the schema-drift cache) runs the actual `pz` CLI
verb.

### Author (mutating, always registered)

Every mutation tool shares one contract: (1) validate the proposed
input before writing anything — invalid input leaves the project untouched,
`applied: false`; (2) apply the edit as a surgical, comment-preserving text splice
— untouched regions of the file stay byte-identical; (3) self-verify
(compile + offline validate) and report the result. Once step 2 has run, `applied`
is always `true` from there on — a mutation that broke the wider project (e.g.
removing a connection a pipeline still reads from) **stays applied** and reports
the resulting errors, matching how a hand edit behaves.

Inputs written as `(object)` below — `connection`, `read`, `write` — are **option maps**:
YAML keys and values for that block, nested exactly as they appear in `connections.yml`.
They publish as `{"type": "object"}` with a description in the tool's input schema, not as
an untyped "anything" schema, so a client that generates arguments from the schema knows to
send an object. Key names are the connector's own YAML key names at every nesting level
(`pz_connector_reference` returns each connector's published schema), which is what makes
moving an option between `connections.yml` and a `source()`/`sink()` kwarg cut-and-paste.

| Tool | Inputs | Result fields (success) |
|---|---|---|
| `pz_init_project` | `template?` (string, default `"minimal"`) | `created: true`, `dir`, `template` (the id that was scaffolded), `files[]` — every file the scaffold wrote, project-relative, forward-slashed and ordinal-sorted, read back off disk rather than predicted from the template. Scaffolds into the server's own project directory; the tool takes no target-directory argument. `template` is a built-in template id, the same catalog `pz init --template` uses: `"minimal"` (the default, matching a bare `pz init` — `project.yml` + `connections.yml` + README + `.gitignore`, ready to author against, nothing to run yet), `"sample"` (runnable four-pipeline demo over local CSVs, runs offline), `"incremental"` (watermark-bounded reads over local CSVs, runs offline, and running it twice lands nothing the second time), `"http"` (GitHub REST API to a parquet delta log; needs internet, no credentials), `"sqlserver"` (incremental merge with data-quality checks; needs a live SQL Server — do not pick it unless the user has one reachable). Pick `"minimal"` unless the user actually asked to see a worked example: every other template's pipelines compile and would run under `pz_run(all: true)`. `PZ0603` when the directory exists and is not empty. |
| `pz_add_connection` | `name`, `connector`, `connection` (object) | `file`, `dropped_comment?`. `PZ0601` (refused, `applied: false`) when `connection` carries what looks like a literal credential — see [Secrets](/how-to/use-with-an-ai-agent/#secrets). `PZ0602` when `name` already exists (hint points at `pz_update_connection`). |
| `pz_update_connection` | `name`, `connector`, `connection` (object) | `file`, `dropped_comment?`, plus `dropped_entities[]` and `warnings[]` when the replaced block declared entities. Replaces the connection block **wholesale** — anything else that lived under the old block (an `entities:` block, `retry:`, ...) is not carried forward, so pass every option the connection should keep, not just the changed one. `dropped_entities[]` names each entity that went with the old block, ordinal-sorted; `warnings[]` says so in prose and points at `pz_add_entity` to re-add them. Both are omitted when nothing was dropped, and both ride the failure envelope too (see [The envelope](#the-envelope)). `PZ0602` when `name` does not exist (hint points at `pz_add_connection`). |
| `pz_remove_connection` | `name` | `file`. `PZ0602` when `name` does not exist. Removing a connection a pipeline still reads from stays `applied: true` and reports the resulting compile/validate errors. |
| `pz_add_entity` | `connection`, `entity`, `read?` (object), `write?` (object) | `file`, `connection`, `entity`, `dropped_comment?`. `PZ0602` (`McpMutationTarget`) when `connection` doesn't exist yet, or `entity` already exists under it (hint points at `pz_set_entity_options`). |
| `pz_set_entity_options` | `connection`, `entity`, `read?` (object), `write?` (object) | Same shape as `pz_add_entity`. Replaces the entity's `read:`/`write:` block wholesale. `PZ0602` when `entity` does not exist under `connection` (hint points at `pz_add_entity`). |
| `pz_remove_entity` | `connection`, `entity` | `file`, `connection`, `entity`. `PZ0602` when `entity` doesn't exist under `connection`. Removing an entity a pipeline still reads/writes stays `applied: true` and reports the resulting errors. |
| `pz_write_pipeline` | `name`, `sql`, `checks_yaml?` | `sql_file`, `checks_file?`. Creates or replaces `pipelines/<name>.sql` (normalized to LF + trailing newline) and, when `checks_yaml` is given, `pipelines/configs/<name>.yml` verbatim. `name` must be a safe file stem (no path separators, no `..`) or `PZ0602`. |
| `pz_remove_pipeline` | `name` | `sql_file`, `checks_file_removed` (bool). `PZ0602` when no `.sql` file exists for `name`. Removing a pipeline another pipeline still `ref()`s stays `applied: true` and reports the resulting compile errors. |

Every add/update/set/write result above also carries `errors[]` with `applied:
true` when self-verify (step 3) found something — a well-formed edit that still
leaves the project broken is not itself a tool failure.

### Execute (registered only under `pz mcp --allow-run`)

| Tool | Inputs | Result fields (success) |
|---|---|---|
| `pz_run` | `flow_names?[]` (strings), `all?` (bool, default false), `full_refresh?` (bool, default false) | `run_id`, `status`, `nodes[]` of `{id, name, status, kind, rows, error?}`, `exit_code`, `notices[]`, `warnings[]` (same shapes as `pz_compile`'s). `nodes[].error` is `{code, message}` from `run_results.json`, present only on a failed node — an MCP caller learns WHY a node failed without shell access to the artifact file. `warnings[]` carries run-TIME warnings too: schema drift under `on_source_drift: warn` (`PZ0331`), duplicate merge keys collapsing in a staged batch (`PZ0522`), an auto-detected DOUBLE column holding only whole numbers beyond 2^53 — a >int64 integer column whose digits may have been silently lost (`PZ0523`), and a csv date column parsed with an assumed day/month order because every value was ambiguous (`PZ0524`) — the same facts the CLI prints as `warning:` lines. `notices[]` likewise carries compile notices **and** notices the run itself raised — a corrupt watermark file (which silently re-extracts the whole source), a watermark or sync-state write that failed, a retention sweep that could not reclaim disk, the resolved state backend — which the CLI prints as `note:` lines. `pz mcp` has no console, so a silently-degraded run would otherwise envelope identically to a clean one: **check `notices[]` and `warnings[]` even when `status` is `success` and `exit_code` is `0`.** Neither `flow_names` nor `all` (in a 2+-flow project) is `PZ0215` — name a flow or pass `all: true`, exactly like the CLI. A broken pipeline is refused by the same `SqlDryCompiler` pre-flight `pz run` itself runs, before any run directory or staging DB is created. |
| `pz_retry` | `full_refresh?` (bool, default false) | Same shape as `pz_run`, plus `note` when there was nothing to retry (the prior run already succeeded, or the project changed) — that case is `ok: true`, `exit_code: 0`, with no new run. |
| `pz_run_results` | `run_id?` (string) | `run_id`, `status`, `nodes[]` (same shape as above, no `exit_code` — there is no fresh exit code for a historical read), `note?`. Defaults to the latest run. An explicit `run_id` not found under a **local** state backend is `PZ0502` (`NoPriorRun`); under a **remote** state backend (no by-id read in v1) it silently is not substituted — instead the latest run is returned with `note` explicitly saying the requested id was ignored. |

`nodes[].rows` comes straight off the run-artifact read model, which carries no
duration field either — no `duration_ms` is emitted anywhere in this tool group.

All three execute tools acquire the same `RunDirLock` the CLI does; a run already
in progress (CLI or another MCP call) is refused with `PZ0604`, never blocked on
— an agent-driven caller has no interactive operator to arbitrate a lock conflict.

## Resources

The server publishes no MCP resources. Documentation is served through the
`pz_docs_*` tools above, which read the published documentation from the site
rather than an embedded copy — fetching live means the answer reflects the
current site rather than whatever was true when a given build of `pz` was cut.

The documentation was never load-bearing and still isn't: every rule it states is
also surfaced through tool `next_step` texts and `pz_project_overview`, so a
client that cannot reach the site loses nothing correctness-critical.

## PZ06xx error codes

The MCP/authoring surface's own code block. All other errors an MCP tool returns
are the project's existing codes (`PZ01xx`–`PZ05xx`), unchanged.

| Code | Meaning |
|---|---|
| `PZ0601` | A connection mutation's proposed value looks like a literal credential — a key whose name contains `password`/`secret`/`token`/`key`/`connection_string` — typed directly into YAML rather than a `${VAR}` env reference. Refused before any file is touched. (The check is that key-name heuristic alone; a connector schema marking a property `writeOnly`/`format: password` is not consulted in v1.) |
| `PZ0602` | A mutation's target is inconsistent with the requested operation: `pz_add_*`'s name already exists, or `pz_update_connection`/`pz_set_entity_options`/`pz_remove_*`'s name does not. Every such error's `next_step` names the correct sibling tool. |
| `PZ0603` | `pz_init_project`'s target directory exists and is not empty. |
| `PZ0604` | A gated execution tool was called while another run already holds `RunDirLock`. |
| `PZ0605` | The MCP client-setup surface (`pz mcp init`) is invalid: an existing client config file (`.vscode/mcp.json`, `.mcp.json`, `~/.copilot/mcp-config.json`, `opencode.json`) failed to parse as JSON (left byte-untouched), or the invocation named no client and no `--all`, or named a client outside `vscode`/`claude-code`/`copilot-cli`/`opencode`, or `--skill-locations` named a token outside `standard`/`claudecode`/`github`/`opencode`/`all`/`none`. |
| `PZ0606` | A localfiles `path:`/`root:`/`base_dir:` — in the existing config or in a proposed authoring block — resolves outside the project directory. `pz mcp` operates only on files inside the project (the same posture PZ0602 takes for `../` in mutation targets), so every tool that touches the project refuses uniformly; the plain CLI remains paths-are-trusted. The containment check is lexical, a guard for steering agents, not a symlink-proof security boundary. |
| `PZ0607` | The documentation tools could not reach the documentation site. The message names the URL that failed; the `next_step` points at `PZ_DOCS_URL` for a mirror. Only `pz_docs_*` can raise this — every other tool works offline. |
| `PZ0608` | A documentation request the catalog cannot answer as asked: `pz_docs_get` with a slug no published page carries, or `pz_docs_search` with an empty query. Distinct from `PZ0607` on purpose — "the site is unreachable" and "that page does not exist" need different fixes. |
| `PZ0609` | A tool handler failed with an exception no handler-level catch classified. The backstop that keeps "no silent failures" true across the MCP boundary: without it the SDK answers its own "An error occurred invoking '`<tool>`'." with the exception text discarded, leaving an agent nothing to act on and `pz mcp` — which wires no logger — no server-side trace either. The message carries the exception's type and text; the `next_step` says to report it. **A `PZ0609` is a `pz` defect, not a bad argument.** |

## Related

- [Use pz with an AI agent](/how-to/use-with-an-ai-agent/): how to configure a client to connect to `pz mcp`.
- [Error codes](/reference/error-codes/): the full `PZ01xx`–`PZ05xx` registry every non-MCP error in this envelope draws from.
- [connections.yml reference](/reference/connections-yml/): the option maps the Author tools' `connection`/`read`/`write` inputs mirror.
- [Template functions](/reference/template-functions/): the `source()`/`sink()` call-site spelling `pz_write_pipeline`-authored SQL uses.
