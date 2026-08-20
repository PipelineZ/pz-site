---
title: "02 — Compile: YAML + SQL become a DAG"
description: "This diagram zooms into the first arrow of the overview: how pz compile turns project files into a dependency graph, using the real templates/sample project..."
---

This diagram zooms into the first arrow of the overview: how `pz compile` turns project files
into a dependency graph, using the real `templates/sample` project verbatim — three tiny
CSV-backed pipelines, but the mechanism is identical at any scale.

<figure class="dgm">
  <a href="/diagrams/02-compile-dag.png">
    <img class="dgm-light" loading="lazy" decoding="async" src="/diagrams/02-compile-dag.png" alt="Compile: ref(), source() and sink() calls observed during rendering declare the DAG edges">
    <img class="dgm-dark" loading="lazy" decoding="async" src="/diagrams/02-compile-dag-dark.png" alt="" aria-hidden="true">
  </a>
  <figcaption>Click the diagram to open it full size.</figcaption>
</figure>
**The main idea:** dependencies are *declared* by template calls (`ref()`, `source()`, `sink()`)
observed during rendering — the compiler never parses your SQL to discover edges. That makes the
DAG exact, cheap, and deterministic. (It's the same trick dbt uses.)

A few terms:

- **Template call** — a `{{ ... }}` placeholder inside a SQL file. Before the SQL ever runs, a
  template engine replaces each placeholder with real text (here: a concrete table name). The
  compiler watches which calls fire, and that's how it learns the dependencies.
- **Edge** — one arrow of the DAG: a data dependency, "this node's output is that node's input".
- **Rendering** — filling in those placeholders. "Discovered at render time" means dependencies
  fall out of expanding the templates, not out of understanding SQL grammar.
- **Deterministic** — the same input files always produce byte-identical output, so compiled
  artifacts can be diffed and cached safely.

## Reading the diagram

**Left column, top: the project on disk.** Convention over configuration — every `.sql` file
under `pipelines/` *is* a pipeline, named after its file, and every connection in
`connections.yml` is loaded. There is no central index of pipelines to keep in sync; dropping a file in the
folder is the registration.

**Left column: the file snippets, in order.**

- `connections.yml` declares the `crm` connection and its entities — here two CSVs. An entity is one named table-shaped thing
  a source exposes (the `orders` CSV, say). This is what `source()` points at.
- `stg_orders.sql` contains `{{ source('crm', 'orders') }}`. That one call does two jobs: it
  resolves to a staging table name (the table in the run's scratch DuckDB where that source's
  data lands), and it declares a DAG edge. `{{ var('min_amount') }}` pulls a value from
  `project.yml` vars — project-level configuration referenced from any template, so numbers like
  a threshold live in one place.
- `orders_enriched.sql` uses `ref('stg_orders')` — a pipeline-to-pipeline dependency, same
  mechanism — and opens with `INSERT INTO {{ sink('lake', 'orders_curated') }}`, which declares
  its load.
- `order_totals.sql` shows the general shape: every pipeline names its own load inline, and the
  leading `INSERT INTO {{ sink(...) }}` *is* the L of ETL. The insert is stripped at compile
  time; execution is still staged materialize-then-drain, never direct DML. That means the
  engine always writes the query result into a staging table first, then separately copies that
  table out to the destination — the query never writes to the destination directly. Why it
  matters: a half-finished query can never corrupt a destination, and one result can fan out to
  many sinks. So a single `.sql` file reads as the whole E→T→L: `source()`/`ref()` in the
  `FROM`, the `SELECT` as the transform, `sink()` in the `INSERT`.
- The fan-out form: one transform feeding many sinks is an array —
  `INSERT INTO [ {{ sink(..) }}, {{ sink(..) }} ]`. The `SELECT` materializes once; each listed
  sink drains that one table.
- the `lake` connection is purely a place with credentials. It does not name its
  input; the producer is whichever pipeline's `INSERT INTO` targets the output. A pipeline that
  loads nowhere and nobody `ref()`s is a non-blocking warning (PZ0223), never a hard stop.
  (Every user-facing diagnostic in pz has a stable `PZ####` code, so it can be documented,
  searched, and suppressed deliberately.)
- The checks note at the bottom: a sidecar config — a small YAML next to the `.sql` file —
  attaches data-quality checks to a pipeline. A check is an assertion about the data ("this
  column is never null", "ids are unique"), compiled into its own DAG node.

**Middle: rendering.** Templating is Scriban — a templating language for .NET, filling the role
Jinja fills for Python and dbt — running in a sandbox with a whitelisted function set: templates
can only call the handful of functions pz provides (`ref`, `source`, `sink`, `var`, …). No file
I/O, no network, no wall clock; one timestamp per run, so renders are stable within a run. This
is deliberately *less* than dbt's Jinja, because that extra power is where dbt's non-determinism
lives. The mapping box shows each `{{ }}` call and the text it becomes.

Dependencies come out of rendering for free, but they are not trusted blindly: DuckDB still
`EXPLAIN`s every rendered query against an empty staging schema before any data moves.
(`EXPLAIN` asks the database to parse, bind, and plan a query without executing it — a dry run;
the staging tables exist with the right columns but no rows, so validation is instant.) Typos
and type errors die at validation, not mid-run.

**Right: the compiled DAG.** Four node kinds, per the legend: orange SourceLoads — one per
*referenced* dataset, so if you declare ten datasets and reference two, only two load; blue
Pipelines (one SQL transform each); yellow Checks, which run inside DuckDB where the data
already is, so they're nearly free; green SinkWrites, which drain staging to destinations. You
can trace the sample's edge chain: `crm.orders → stg_orders → orders_enriched →
lake.orders_curated`.

Every node gets a content-addressed ID — a hash of its rendered SQL or canonical config. The
node's identity is a fingerprint of *what it does*: if the SQL didn't change, the ID didn't
change, so a later run can prove "this node is identical to the one that already succeeded" and
skip it. That's what makes `pz retry` (the verb that resumes a failed run) and incremental runs
coherent.

The artifacts box lists what `compile` writes: the rendered SQL, `manifest.json` (the full
node-and-edge graph as JSON), and `plan.json` (how each edge's data will physically move —
diagram 03's subject). All of it is inspectable before anything runs.

## Key points

- The template call is the dependency declaration — one mechanism, two jobs.
- If it compiles, it will very probably run: DuckDB validated every query before data moved.
- The manifest is table-level lineage for free — the "which data came from where" graph that
  auditors and data catalogs want.

## Common questions

- **What if I write SQL that references a table without `ref()`?** DuckDB's dry-compile fails:
  the staging schema only contains declared objects. You can't accidentally create hidden edges.
- **Are loops and conditionals available in templates?** Yes — Scriban provides them over vars,
  still inside the sandbox.
- **Why not parse the SQL to find dependencies?** Parsing every dialect corner is fragile (a
  parser must understand all of every database's SQL flavor; a template engine only has to
  expand its own placeholders). Render-time extraction is exact, and dbt has battle-tested the
  approach at huge scale.

**Next:** [03-data-plane](/diagrams/03-data-plane/) — the DAG says *what* runs; how do the bytes
actually move?
