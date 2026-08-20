---
title: "Project structure"
description: "A PipelineZ project is a directory of YAML and SQL files. This article explains what each file kind does. The rule throughout is convention over..."
---

A PipelineZ project is a directory of YAML and SQL files. This article explains what each file
kind does. The rule throughout is **convention over configuration**: every `.sql` file under
`pipelines/` is a pipeline named after its file, every connection in `connections.yml` is
loaded, and sidecar configs are optional and matched by name. There are no registration lists
to maintain.

```
my-project/
├── project.yml                  # identity, connector requirements, engine config, vars
├── pz.lock.json                 # generated: resolved package graph (commit this)
├── connections.yml              # every place pz talks to, and each one's entities
├── pipelines/
│   ├── stg_orders.sql
│   ├── orders_enriched.sql
│   └── configs/
│       └── orders_enriched.yml  # optional sidecar config per pipeline
├── profiles.yml                 # OPTIONAL local overrides — gitignored; secrets live
│                                # in env vars or ~/.pz/profiles.yml (deferred — not in v0.1/v0.2)
└── .pz/                         # generated, gitignored
    ├── packages/                # restored connector assemblies
    ├── target/                  # compiled SQL, manifest.json, plan.json
    ├── runs/<run_id>/           # run_results.json, logs, staging.duckdb
    └── state/                   # incremental watermarks
```

## project.yml

The project's identity, connector requirements, variables, and engine settings:

```yaml
name: acme_warehouse_sync
version: 0.3.0
pz: ">=1.0 <2.0"                  # engine version constraint, checked at load

connectors:
  - package: Pz.Connector.Postgres   # NuGet package id
    version: 2.1.4                     # exact or range; lock file pins exactly
  - package: Pz.Connector.S3
    version: 1.8.0

vars:
  lookback_days: 30

engine:
  threads: 4                # max concurrent DAG nodes
  batch_bytes: 33554432     # universal-path batch target, bytes (default 32MB; 1MB..512MB)
  duckdb:
    memory_limit: 8GB
    threads: 8
    temp_directory: .pz/tmp

retention:
  keep_last: 10             # after each run, delete staging.duckdb from all but the newest 10 runs

state:
  backend: sqlserver        # local (default) | sqlserver -- see reference/project-yml.md
```

`retention:` bounds how much disk `.pz/runs` keeps. After every run, `staging.duckdb` (and its
`.wal`) is deleted from all but the newest `keep_last` runs; every `run_results.json` is kept
forever, so run history and `pz retry` are unaffected. It defaults to `keep_last: 10` when the key
is absent. Write `retention: off` to disable it and manage disk with `pz clean` by hand. `keep_last`
must be at least 1 — the run that just finished is never swept.

That "staging.duckdb only" description is the local-backend behavior. When `state.artifacts`
resolves to a SQL Server store (see [Move state off the local disk](/how-to/remote-state/)),
retention and `pz clean` sweep that store's `pz.runs`/`pz.run_nodes`/`pz.run_events` rows as well —
and a swept run there is always deleted **whole**, regardless of whether `--purge` was passed: its
rows *and* its local `.pz/runs/<id>/` directory, which under that backend holds nothing but
`staging.duckdb`. Staging never leaves the machine whatever the backend, so it is always the local
sweep that reclaims it.

> [!IMPORTANT]
> **One version per connector package per project** is enforced at load time. This mirrors
> dbt's one-adapter-version model, keeps resolution deterministic, and eliminates an entire
> class of "which version handled this table?" ambiguity.

## connections.yml

One file at the project root, three levels deep. A **connection** is a place with credentials.
An **entity** is a thing in that place, named the way that place names it. A **direction** —
`read:` or `write:` — is how to move data that way. Direction nests inside the entity so an
entity that is written and later read back appears once.

Connector config is **flat**: everything at connection level that is not `connector`, `entities`,
`max_concurrency`, `rate_limit`, or `retry` is passed to the connector. Those five names are
reserved, and a connector declaring one is refused (PZ0345).

### `root:` — where the place is

A connection that addresses a location — `localfiles`, `s3` — takes a `root:`. It says *where the
lake is*; the entity says *which dataset*:

```yaml
lake:
  connector: localfiles
  root: out          # relative to the project, or absolute
```

```sql
INSERT INTO {{ sink('lake', 'orders_curated', format: 'parquet', strategy: 'replace') }}
```

lands in `out/orders_curated/`. The rules:

| | resolves to |
|---|---|
| a source with no `path:` | `<root>/<entity>.<format>` |
| a sink with no `path:` | `<root>/<entity>/` |
| a relative `path:` | `<root>/<path>` |
| an absolute `path:` | itself — `root:` is ignored |

For `s3`, `root:` is `<bucket>` or `<bucket>/<prefix>`. An output naming its own `bucket:` does not
inherit the root's prefix — that prefix belongs to the root's bucket.

This is composition, not the either/or of the previous section: a connection-level base and an
entity-level name are two different things, so declaring both is normal.

```yaml
crm:
  connector: postgres                 # logical name resolved from installed connectors
  host: ${CRM_PG_HOST}              # env interpolation; never literal secrets
  database: crm
  user: ${CRM_PG_USER}
  password: ${CRM_PG_PASSWORD}
  entities:
    public.customers:                 # the dataset key IS the object name
      read:
        columns:                        # optional schema contract, enforced per policy
          id: bigint
          email: varchar
          updated_at: timestamp
    orders_active:                    # a query dataset: the key is just a label
      read:
        query: "select * from public.orders where status <> 'draft'"
```

### The dataset key names the object

A dataset is named exactly the way its own system names it — `public.customers`,
`dbo.orders`, `curated`. There is no `schema:` or `table:` key; the name carries its own
qualification, and an unqualified name takes the connector's default schema (`public` for
postgres, `dbo` for SQL Server). Declaring the retired keys is an error (PZ0348) whose hint
names the key to rename to.

A dataset that needs no options is written as a bare key:

```yaml
entities:
  dbo.orders:
```

Two limits are worth knowing:

- **Two parts, not three.** `db.schema.table` is refused rather than read as a table literally
  called `db.schema.table`. Cross-database qualification is not supported.
- **A name pz cannot spell in SQL is folded.** The staging relation for a read is
  `src_<source>__<dataset>` with every character outside `[A-Za-z0-9_]` turned into `_`, so
  `dbo.orders` stages as `src_crm__dbo_orders`. Two datasets of one source that fold together
  (`dbo.orders` and `dbo_orders`) are refused (PZ0110) rather than sharing a table.

The same rule holds on the write side: `sink('mart', 'mart.orders_current')` names the target,
and `schema:`/`table:` are not `sink()` keyword arguments.

## pipelines/*.sql and sidecar configs

Each SQL file is one pipeline, and the file names its whole story — **extract, transform,
load** — as pure SQL, no YAML frontmatter:

- **E**(xtract) is `{{ source(...) }}` (a loaded dataset) or `{{ ref(...) }}` (another
  pipeline's output) in the `FROM`.
- **T**(ransform) is the `SELECT` itself.
- **L**(oad) is a leading `INSERT INTO {{ sink(...) }}` — see
  [Loading: INSERT INTO sink()](#loading-insert-into-sink) below. A pipeline with
  no `INSERT INTO` is an **intermediate**: it materializes `staging.<name>` and stays fully
  valid as long as some other pipeline consumes it via `ref()`.

```sql
-- pipelines/orders_enriched.sql
INSERT INTO {{ sink('lake', 'orders_curated') }}
select
    o.id,
    o.amount,
    c.email
from {{ ref('stg_orders') }} as o
join {{ source('crm', 'customers') }} as c
  on c.id = o.customer_id
```

Template calls resolve to real table names and are the **only** place DAG edges come from —
`ref()`/`source()` for what feeds the pipeline, `sink()` for where it loads.

An optional sidecar config — matched by name under `pipelines/configs/` — sets
materialization, tags, and data-quality checks:

```yaml
# pipelines/configs/orders_enriched.yml
pipeline: orders_enriched
materialization: table          # table | view | ephemeral
tags: [daily, crm]
checks:
  - not_null: [id, email]
  - unique: [id]
  - row_count: { min: 1 }
  - freshness: { column: updated_at, max_age: 24h }
  - accepted_values: { column: status, values: [pending, shipped, delivered] }
  - custom_sql:
      name: no_negative_totals
      sql: select * from staging.orders_enriched where total < 0
```

Check types and their options (invalid definitions are compile-time errors, PZ0113):

| Check | Options | Fails when |
|---|---|---|
| `not_null: [cols]` | — | any listed column has a NULL |
| `unique: [cols]` | — | any key group appears more than once |
| `row_count` | `min`, `max` (at least one) | count falls outside the bounds |
| `freshness` | `column`, `max_age` (`30m`/`24h`/`7d`) | `max(column)` is older than `max_age` ago — or the table is empty |
| `accepted_values` | `column`, `values` (non-empty list) | a non-NULL value falls outside the list (NULLs pass — that's `not_null`'s job) |
| `custom_sql` | `name` (`[a-z][a-z0-9_]*`), `sql` | the query returns any rows |

`custom_sql` runs its SQL verbatim against the staging database — query your own pipeline's
table (`staging.<pipeline>`). The check node only orders after its owning pipeline, so
referencing other pipelines' tables has undefined ordering. Every check also accepts
`sample_values: false` to suppress per-row values in failure reports.

Checks are **observational**: a failing check fails the run (exit 1) but does not block the
pipeline's sink writes — checks and `SinkWrite` nodes are both children of the pipeline, with
no edge between them, so the flagged rows still land in the destination. Treat a red check as
an alarm on data that has already shipped, not as a gate in front of the load. When a gate is
what you need, run `pz test && pz run`: `pz test` executes the checks and their required
ancestors without any sinks, so the sinks only ever run behind a fully green check pass.

## Writing to a connection

A connection written to declares **a place with credentials** — the connector and its config, plus
the instance-level `retry:`, `max_concurrency:`, and `rate_limit:` knobs. It does not have to say
anything about the write:

```yaml
lake:
  connector: localfiles
  # ...host, credentials, connector options -- flat
```

### Two surfaces, one declaration

This is the rule for **both** directions. Read options — `columns`, `sync`, `partition_column`,
`partitions`, `retry`, and every connector read option — and write options — strategy, merge keys,
`schema_policy`, `retry:`, `format`, `path`, … — can each be declared in **either** place:

```sql
-- at the call site: the option and the query it governs are in one file
INSERT INTO {{ sink('warehouse', 'mart.orders_current', strategy: 'merge', keys: ['order_id']) }}
```

```yaml
# or in connections.yml: the property of the entity, shared by everything that writes it
warehouse:
  connector: postgres
  entities:
    mart.orders_current:
      write:
        strategy: merge
        keys: [order_id]
```

The read side is the same shape:

```sql
-- at the call site: the whole read is where the query that needs it is
select id, email from {{ source('crm', 'customers', path: 'data/customers.csv', format: 'csv') }}
```

```yaml
# or in connections.yml
crm:
  connector: localfiles
  entities:
    customers:
      read:
        path: data/customers.csv
        format: csv
```

> **Declare in one place.** An entity-*side*'s options live in `entities:` **or** at the call site,
> never split, never overridden. Declaring both is **PZ0341**.

The unit is the entity *side*, not the entity: an entity may perfectly well declare its `read:` in
YAML and its write options at a `sink()` call, because those are two independent declarations.

There is deliberately **no effective-config assembly** — pz never merges a YAML default with a
call-site override. That is the property that keeps two surfaces from becoming a precedence
problem: a reader of one file always sees the whole story for that entity-side. Every kwarg name
equals the YAML key at every nesting level, so moving an option between the two is cut-and-paste.

Neither direction has a fan-in problem to resolve: two pipelines cannot write one entity
(**PZ0206**), and a source entity is read by exactly one pipeline (**PZ0349**). So there is never a
question of which call site's options win.

**An entity exists because something reads or writes it.** A `source()` or `sink()` naming an entity
that appears nowhere in `connections.yml` is not an error — the call declares it. Only an unknown
*connection* is (**PZ0201**). Whether the entity exists in the remote system stays `--connect` work;
pz does not pretend to know a catalog offline.

A leftover `outputs:` block, or a `sources/`/`sinks/` directory, is refused with **PZ0346**, whose
hint reconstructs the equivalent `connections.yml` block for you to paste.

## Loading: INSERT INTO sink()

A pipeline loads its result by leading with `INSERT INTO {{ sink(...) }}` — this is the **only**
way to load; there is no YAML equivalent. `sink('<sink>', '<output>')` must be the pipeline's
leading statement. Comments and whitespace before it are fine; CTEs go *inside* the query, after the marker.

The common case is 1:1 — a scalar marker, carrying this write's options:

```sql
-- pipelines/order_totals.sql
INSERT INTO {{ sink('lake', 'order_totals', strategy: 'replace', format: 'csv', path: 'out/totals/') }}
select customer_id, sum(amount) as total
from {{ ref('stg_orders') }}
group by customer_id
```

Every keyword argument is named exactly as its YAML key was, at every nesting level — a nested block
becomes a Scriban object literal, so `retry: { max_attempts: 5 }` reads the way `retry:` did. Passing
none of them means what an output with no `write:` block meant: `strategy: 'append'`, no keys, no
duplicate consent, `schema_policy: 'fail_on_change'`.

**The call must fit on one line.** Scriban ends a statement at the newline, so a `sink()` call split
across lines is a template parse error (PZ0104), not a continuation.

Names pz owns are checked: a strategy outside `replace`/`append`/`merge`, `keys` that is not a list of
strings, `duplicates` that is not the literal `'accept'`, an `on_delete` without `strategy: 'merge'`,
and the retired `mode:`/`accept_duplicates:`/`write:`/`input:`/`rate_limit:` names are all errors
naming the line. Any *other* name is a connector write option and is passed through unchecked — pz
has no way to know one connector's option vocabulary from another's. Because that leaves a typo of a
pz key (`strategyy: 'merge'`) able to silently default the strategy, a kwarg one edit away from a name
pz owns draws a **warning** naming both. It is a warning and not an error on purpose: a connector may
legitimately have an option called `keyz`.

One transform feeding **N** outputs uses an array of markers in the same `INSERT INTO` — no
second mechanism, just a list instead of a single value:

```sql
-- pipelines/stg_orders.sql
INSERT INTO [{{ sink('ok', 'ok', strategy: 'replace') }}, {{ sink('flaky', 'flaky', strategy: 'replace') }}]
select * from {{ source('crm', 'orders') }}
```

> [!NOTE]
> The compiler strips the `INSERT INTO {{ sink(...) }}` prefix at compile time — **execution
> is still staged materialize-then-drain, never statement-scoped DML** (mode `replace` ≈
> overwrite; a failed drain leaves staging intact). `order_totals` materializes
> `staging.order_totals` exactly like a SELECT pipeline (and stays `ref()`-able), then a
> normal SinkWrite node drains it into `lake.order_totals`. The array form materializes its
> query **once** and drains it into every listed output — fan-out is free at execution time,
> purely authoring syntax. The compiled artifact under `.pz/target/compiled/` keeps a
> generated `-- output: lake.order_totals (csv, replace)` header recording the binding, since
> the authored INSERT-form text is not what actually runs.

Binding rules, enforced at compile time:

- An output is claimed by **at most one** pipeline's `sink()` call; two pipelines claiming the
  same output is `PZ0206` (error).
- `sink()` must appear only in the leading `INSERT INTO` position, and never on an `ephemeral`
  pipeline (which produces no node for a sink to depend on) — either shape is `PZ0208`.
- There is no orphan-output case left to flag: the `sink()` call is what creates the output, so
  an output without a writer cannot be written down.

## Incremental reads: watermark()

A pipeline can declare a source dataset **incremental** — read only the rows newer than the
last run — directly in its SQL, by comparing the dataset's cursor column against
`{{ watermark('<source>', '<dataset>') }}` in the `WHERE` clause:

```sql
-- pipelines/orders_curated.sql
INSERT INTO {{ sink('mart', 'orders_curated') }}
select o.id, o.amount, o.updated_at
from {{ source('crm', 'orders') }} as o
where o.amount > 0
  and o.updated_at > {{ watermark('crm', 'orders') }}
```

The compiler reads that comparison with DuckDB's own parser and infers that `crm.orders` is
incremental with cursor `updated_at`. At run time the engine pushes the same
`updated_at > <last watermark>` bound down to the source connector that a YAML
`sync: { mode: incremental }` declaration would, captures the new watermark as `MAX(updated_at)`
after the data lands, and
advances it once every downstream sink commits. Nothing about the *machinery* changes —
`watermark()` moves the **declaration** out of YAML and into the SQL, so the `.sql` file names
its whole story: extract, transform, load, **and** that the read is a delta.

> [!NOTE]
> The compiled artifact under `.pz/target/compiled/` records the inference with a generated
> comment header naming the dataset and cursor (`crm.orders (cursor updated_at, declared in
> SQL)`, prefixed with a compiled-artifact marker — the same convention as the `-- output:`
> binding note above, unrelated to any YAML key) — the authored `{{ watermark(...) }}` text is
> not what
> actually runs.

### The recognized shape

A recognized watermark comparison is an **ordered bound on the cursor column** — `<cursor column>`
followed by `>`, `>=`, `<` or `<=` and an expression (the flipped spellings, with the expression on
the left, mean the same and are also accepted). `>`/`>=` are floors, the resume point; `<`/`<=` are
ceilings, which is how [a bounded window](#declaring-the-window-in-sql) is spelled in SQL. The cursor
side must be a bare or alias-qualified column that resolves — through this pipeline's own `source()`
call — to a column of the named dataset. The value side is any scalar expression containing exactly
one `watermark()` call and **no column references**.

Anything else fails compilation with `PZ0224` (naming the pipeline, the offending expression,
and the accepted shape) rather than guessing: `=`/`!=`, a function on the cursor side, a column
on the value side, or a `watermark()` outside a comparison. Equality is rejected because watermark
advancement (`MAX(cursor)` after sinks commit) is only coherent against an ordered cut;
cursor-side functions are rejected because the bound must run inside the *source* database before
data moves, and inverting an arbitrary function to recover a raw-column bound isn't generally
possible.

### Value-side expressions: lookback

Because the value side takes any column-free scalar expression, you can widen the read to catch
late-arriving rows. A **lookback** subtracts an interval from the watermark:

```sql
where o.updated_at >= {{ watermark('crm', 'orders') }} - interval 2 hour
```

reads everything from two hours before the last watermark forward. The rows inside that window
are re-read every run — an inclusive (`>=`) bound is at-least-once by construction; see
[Delivery guarantees](/concepts/delivery-guarantees/#sql-declared-incremental-datasets-and--re-reads).
`date_trunc('day', {{ watermark('crm', 'orders') }})` and other DuckDB scalar functions are
equally valid on the value side. Value expressions must be deterministic — volatile functions
such as `now()` are rejected at compile time (they would evaluate differently at extraction-bound
time and pipeline-filter time, silently skipping rows).

### Declaring the window in SQL

`initial`, `max_window` and `until` — the YAML bounded-window trio, see
[Backfill in slices](/how-to/backfill-in-slices/) — can live in the pipeline's own `WHERE`
instead, with no `sync:` block at all.
`{{ watermark(source, dataset) }}` is the resume point: the stored value, or `NULL` on the first run.

```sql
select id, amount, updated_at
from {{ source('crm', 'orders') }}
where updated_at >  coalesce({{ watermark('crm','orders') }}, TIMESTAMP '2026-01-01')
  and updated_at <= least(coalesce({{ watermark('crm','orders') }}, TIMESTAMP '2026-01-01') + interval 7 day,
                          TIMESTAMP '2026-06-01')
```

- **`initial`** is the `coalesce` fallback — where a first run starts.
- **`max_window`** is a ceiling written relative to the resume point, so a large backfill arrives one
  slice per run.
- **`until`** is the constant arm of that `least(...)` — the point past which the backfill stops.

> [!IMPORTANT]
> **A ceiling has to be written *inside* an expression containing the `watermark()` call.** Only a
> comparison whose value side holds a `watermark()` call is folded into a bound, so a separate
> `and updated_at <= TIMESTAMP '2026-06-01'` is an ordinary pipeline filter, not an `until`: the
> extraction stays bounded by `max_window` alone, and on every run whose window comes back empty the
> watermark advances a further `max_window` straight past the constant. Fold the constant into the
> same expression with `least(...)` and the tightest-ceiling rule below does the rest.

A ceiling with no floor is `PZ0351`: that is a filter, not an increment, and it would advance the
watermark straight to the ceiling on the first run, after which every run would extract nothing.

Unlike ordinary filters, which pz pushes to the source when it can and otherwise applies in DuckDB, a
ceiling **must** be applied by the source: pz refuses to run one against a connector that cannot
bound its reads (`PZ0313`). Watermark advancement reads the *staged* table, which the pipeline's
`WHERE` never filters — so rows landing past the ceiling would advance the cursor past rows the
pipeline never processed. Several ceilings on one dataset reduce to the **tightest** for the same
reason; several floors reduce to the **loosest**, because over-extracting is safe.

### The cursor's type

The cursor column may appear in the dataset's `columns:` contract with an allowed cursor type
(`int`, `bigint`, `decimal`, `date`, or `timestamp`), and when a contract is declared it must —
a contract prunes reads to exactly its columns, so a cursor outside it would never be extracted
(`PZ0227`). With no contract at all, nothing is pruned and the type is discovered at run time: from
the stored watermark, or on a first run by asking DuckDB what the bound expression evaluates to.

### Either/or with YAML — never both

Incrementality is declared **either** in `connections.yml` (`sync: { mode: incremental }` under
`entities: <e>: read:`) **or**
in pipeline SQL via `watermark()`, never both for the same dataset — declaring both is `PZ0225`.
That includes pointing a `watermark()` at a **windowed** dataset (`initial`/`max_window`/`until` in
YAML); to declare a window in SQL, write it in the `WHERE` as above and drop the YAML block.

A dataset can also skip ordered cursors entirely by leaving `sync:` absent (or declaring
`mode: auto`) on a connector whose natural read for that dataset is an opaque, connector-owned
continuation token (a change-feed delta link) the engine stores verbatim instead of a comparable
cursor value — see [Delivery
guarantees](/concepts/delivery-guarantees/#sync-state-another-commit-gated-state-kind). There's no
separate mutual-exclusion rule to state here any more: `sync:` is one block with one `mode` field,
so an ordered cursor and an opaque token can never both be declared for the same dataset — the
old cross-block conflict this used to need a dedicated error for (`PZ0315`) is no longer
representable.

### One reader, so the SQL is the whole story

A source dataset is read by exactly one pipeline (`PZ0349` — see
[Execution model](/concepts/execution-model/)), so the pipeline that declares `crm.orders` incremental in
SQL is also the only pipeline that reads it. There is no second consumer to keep in agreement, and
what that one file's `WHERE` asks for *is* what pz extracts. To share the delta, `ref()` the
declaring pipeline rather than `source()`-ing the dataset again.

Inside an **ephemeral** pipeline, a `watermark()` filter is attributed to each consumer that
inlines it — the consumer's assembled SQL visibly carries the filter; the ephemeral itself, having
no node, contributes no duplicate bound.

### First run and `--full-refresh`

Under `--full-refresh` no bound is pushed at all: extraction reads everything, and the pipeline
predicate passes all rows. On a **first run** (no stored watermark) the watermark substitutes as
`NULL`, so a bare `{{ watermark(...) }}` likewise pushes no bound — while a
`coalesce({{ watermark(...) }}, <initial>)` resolves to its `initial` and *is* pushed, which is how
[a SQL-declared window](#declaring-the-window-in-sql) starts somewhere other than the beginning of
time. Either way no row is wrongly filtered: each recognized comparison compiles to a NULL-guard —
`(<value-expr> IS NULL OR <cursor> <op> <value-expr>)` — so where the expression is NULL the guard's
first arm fires. Capture and advancement then behave exactly as on a normal run.

### Joins: the delta×delta hazard

A watermark filter is strictly **per dataset**: a pipeline reading several sources carries one
`watermark()` per incremental dataset, each cutting only its own staged table. Joining an
incremental dataset to a **full-extract** dataset (delta fact × full dimension) is the
recommended pattern and works as read.

Joining **two incremental datasets** is legal but is a *delta×delta join*: each side sees only
its own slice, so a new row on one side finds no match when its counterpart didn't change in
the same run (an inner join drops it; a left join yields nulls). This hazard exists identically
with two YAML-declared incremental datasets — the SQL form at least makes both filters visible
in the file. The compiler deliberately does not detect or "fix" it: the remedy is a modeling
choice (keep the dimension full-extract, or accumulate deltas in a merge target and join
downstream), not an inference the engine can make safely.

## Templating: deliberately less than Jinja

dbt's Jinja is both its superpower and its biggest source of non-determinism and confusion.
PipelineZ uses **Scriban in sandboxed mode** with a small whitelisted function set:

| Function | Does |
|---|---|
| `source('src','dataset')`, `ref('pipeline')` | Resolve to staging table names *and* declare DAG edges |
| `sink('sink','output')` | Records the pipeline's load binding and renders a placeholder the compiler recognizes as the pipeline's leading `INSERT INTO` marker (or one entry in an array of markers, for fan-out) |
| `watermark('src','dataset')` | Renders the dataset's stored incremental watermark for a cursor comparison, declaring the dataset incremental *in the SQL* — see [Incremental reads](#incremental-reads-watermark). Creates **no** DAG edge (the `source()` call does that) |
| `var('name')`, `env('NAME')` | Project variables; `env` only for variables declared in `project.yml` |
| `this`, `run_id`, `run_started_at` | Injected constants (one timestamp per run, so renders are stable within a run) |

> [!IMPORTANT]
> The sandbox allows no file I/O, no network, no wall clock, no arbitrary .NET calls. Loops
> and conditionals over vars are allowed (Scriban gives them for free); macros can come later
> as project-local `.sql` includes.

**Dependencies are extracted from `ref`/`source` calls during rendering** — exactly dbt's
trick — so the engine never needs to parse SQL to build the DAG. It *does* hand the rendered
SQL to DuckDB's own parser for validation; see [Validation and errors](/concepts/validation/).

The alternatives considered: a hand-rolled `{{ }}` micro-parser (simpler, but users
immediately want loops and a worse Scriban gets re-grown), and full Jinja fidelity via a
Python-compatible engine (maximum dbt familiarity, maximum non-determinism risk). Sandboxed
Scriban is the balance point: mature, fast, MIT-licensed, and restrictable.

## Next steps

- [Key concepts](/concepts/key-concepts/) — the vocabulary these files use.
- [The execution model](/concepts/execution-model/) — what happens when this project runs.
- [Quickstart](/quickstart/) — scaffold a working example of all of this with `pz init`.
