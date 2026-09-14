---
title: "Introducing PipelineZ"
description: "Why we built pz: a lightweight, SQL-based batch pipeline engine powered by DuckDB, for the pipelines that don't need a whole data platform."
date: 2026-09-09
heroImage:
  dark: ./hero-dark.svg
  light: ./hero-light.svg
  alt: "The PipelineZ wordmark over a grid-lined background with a glowing yellow pipeline diagram."
---

Welcome to the pz blog. This is the first post, so it's the obvious one to write: what pz
actually is, why it exists, and how to try it.

## Most pipelines are just a few SQL queries

A lot of "we need a data pipeline" starts out modest: pull yesterday's orders, join them
against a customer table, load the result somewhere a dashboard can read it. That's three or
four SQL statements. But by the time it's running reliably, it's often grown a scheduler, a
container image, a warehouse account, and a service the team now has to keep patched, because
the tools built for that job assume you also want the platform underneath it.

Sometimes you do want that platform. If you're coordinating hundreds of pipelines across a
data org, [Airflow](https://airflow.apache.org/) or a managed warehouse's own orchestration
earns its keep. But plenty of teams, and plenty of solo projects, never get there. They just
need the three SQL statements to run on a schedule, fail loudly when the data looks wrong, and
not lose an afternoon to setup first.

| | A full platform | pz |
|---|---|---|
| First thing you set up | A scheduler, a service, a warehouse account | A `project.yml` |
| What runs it | A container image you deploy and patch | A binary you invoke |
| Where it runs | Wherever the platform is deployed | Your laptop, CI, or any scheduled job |
| Right for | Coordinating hundreds of pipelines org-wide | The pipelines that don't need a platform |

pz is for that second case.

## What pz actually does

pz is a command-line engine that moves data in batches. You write your project as SQL files
plus one YAML file describing where data comes from and goes:

```sql title="pipelines/orders_enriched.sql"
INSERT INTO {{ sink('lake', 'orders_curated', strategy: 'replace', format: 'parquet') }}
SELECT
    o.id,
    o.amount,
    c.email
FROM {{ ref('stg_orders') }} AS o
JOIN {{ source('raw', 'customers') }} AS c
    ON c.id = o.customer_id
```

```yaml title="connections.yml"
raw:
  connector: localfiles
  entities:
    customers:
      read:
        path: data/customers.csv
        format: csv

lake:
  connector: localfiles
  root: out
```

`pz run` reads those files, compiles them into a dependency graph from the `source()`, `ref()`,
and `sink()` calls, and hands execution to [DuckDB](https://duckdb.org/). There's no separate
service to deploy and no warehouse to provision first: DuckDB runs in-process, so the whole
thing works on your laptop, in CI, or as a scheduled job wherever you can run a binary.

<figure style="overflow-x:auto">
<svg viewBox="0 0 1100 160" role="img" aria-label="SQL and YAML files compile into a dependency graph, which DuckDB executes, writing to destinations such as files, a warehouse, or a database" xmlns="http://www.w3.org/2000/svg" style="width:100%;min-width:560px;height:auto;display:block">
	<defs>
		<marker id="pz-arrow-3" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
			<path d="M 0 0 L 10 5 L 0 10 z" fill="var(--sl-color-text-accent)"/>
		</marker>
	</defs>
	<g fill="none" stroke="var(--sl-color-text-accent)" stroke-width="3">
		<line x1="230" y1="80" x2="260" y2="80" marker-end="url(#pz-arrow-3)"/>
		<line x1="490" y1="80" x2="520" y2="80" marker-end="url(#pz-arrow-3)"/>
		<line x1="750" y1="80" x2="780" y2="80" marker-end="url(#pz-arrow-3)"/>
	</g>
	<g font-family="Arial, sans-serif" text-anchor="middle">
		<rect x="30" y="45" width="200" height="70" rx="10" fill="var(--sl-color-gray-6)" stroke="var(--sl-color-gray-5)" stroke-width="1.5"/>
		<text x="130" y="75" font-size="18" font-weight="700" fill="var(--sl-color-white)">SQL + YAML</text>
		<text x="130" y="98" font-size="13" fill="var(--sl-color-gray-3)">your project files</text>
		<rect x="260" y="45" width="230" height="70" rx="10" fill="var(--sl-color-gray-6)" stroke="var(--sl-color-gray-5)" stroke-width="1.5"/>
		<text x="375" y="75" font-size="18" font-weight="700" fill="var(--sl-color-white)">Dependency graph</text>
		<text x="375" y="98" font-size="13" fill="var(--sl-color-gray-3)">from source()/ref()/sink()</text>
		<rect x="520" y="45" width="230" height="70" rx="10" fill="var(--sl-color-gray-6)" stroke="var(--sl-color-text-accent)" stroke-width="2"/>
		<text x="635" y="75" font-size="18" font-weight="700" fill="var(--sl-color-white)">DuckDB</text>
		<text x="635" y="98" font-size="13" fill="var(--sl-color-gray-3)">runs in-process</text>
		<rect x="780" y="45" width="290" height="70" rx="10" fill="var(--sl-color-gray-6)" stroke="var(--sl-color-gray-5)" stroke-width="1.5"/>
		<text x="925" y="75" font-size="18" font-weight="700" fill="var(--sl-color-white)">Destinations</text>
		<text x="925" y="98" font-size="13" fill="var(--sl-color-gray-3)">files, warehouse, database</text>
	</g>
</svg>
<figcaption>No separate service and no server to run: the whole path from files to written data happens inside one process.</figcaption>
</figure>

A few things follow from that shape:

- **The pipeline is the diff.** SQL and YAML are text your team already reviews like any other
  change. A join that goes wrong, or a load strategy that quietly switches from `merge` to
  `replace`, shows up in a pull request instead of in next week's numbers.
- **Correctness is part of the graph, not an afterthought.** [Checks](/concepts/checks/) are
  assertions that run inside the same dependency graph and can gate what gets written, so bad
  data fails the run instead of landing in the sink.
- **Incremental loads are a first-class case**, not a pattern you rebuild per pipeline:
  watermarks, bounded windows, and merge strategies are covered by
  [Incremental loads](/concepts/incremental-loads/).
- **Connectors are pluggable.** Local files today, and the [connector](/connectors/) list is
  where sources and sinks beyond `localfiles` live as they're added.

None of this requires believing pz is the right tool for every pipeline. It's the right tool
when the honest answer to "do we need a platform for this" is no.

## Try it

The fastest way to see this land is the [quickstart](/quickstart/), a real project running in
about ten minutes. From there, the [tutorial](/tutorial/) builds one up step by step, and
[key concepts](/concepts/key-concepts/) covers the vocabulary this post used without
stopping to define.

If pipelines in general are newer territory for you, [Data Engineering Introduction](/book/)
is a ten-part series that starts from "what is a data pipeline" and ends by mapping every idea
it covers onto pz specifically.

We'll use this blog for the things that don't fit a docs page: design decisions, what we're
building next, and notes from actually running pz. More soon.
