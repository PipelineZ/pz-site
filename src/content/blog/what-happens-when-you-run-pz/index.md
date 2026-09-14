---
title: "What happens when you run pz"
description: "The seven phases between typing pz run and seeing a result: load, compile, validate, plan, dispatch, finalize, report, and what each one leaves on disk."
date: 2026-09-11
heroImage:
  dark: ./hero-dark.svg
  light: ./hero-light.svg
  alt: "The word Inside above the accent-colored words 'a run', next to a yellow circuit path over a dot grid."
---

`pz run` looks like one command. Underneath it's seven phases, each one narrowing what could
still go wrong before any byte of data actually moves. Knowing the shape of a run tells you
where to look when something fails, and why a retry is usually cheap.

<figure style="overflow-x:auto">
<svg viewBox="0 0 1200 190" role="img" aria-label="Seven phases of a run: Load, Compile, Validate, Plan, Dispatch, Finalize, Report, connected left to right by arrows" xmlns="http://www.w3.org/2000/svg" style="width:100%;min-width:640px;height:auto;display:block">
	<defs>
		<marker id="pz-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
			<path d="M 0 0 L 10 5 L 0 10 z" fill="var(--sl-color-text-accent)"/>
		</marker>
	</defs>
	<g fill="none" stroke="var(--sl-color-text-accent)" stroke-width="3">
		<line x1="170" y1="115" x2="200" y2="115" marker-end="url(#pz-arrow)"/>
		<line x1="335" y1="115" x2="365" y2="115" marker-end="url(#pz-arrow)"/>
		<line x1="500" y1="115" x2="530" y2="115" marker-end="url(#pz-arrow)"/>
		<line x1="665" y1="115" x2="695" y2="115" marker-end="url(#pz-arrow)"/>
		<line x1="830" y1="115" x2="860" y2="115" marker-end="url(#pz-arrow)"/>
		<line x1="995" y1="115" x2="1025" y2="115" marker-end="url(#pz-arrow)"/>
	</g>
	<g font-family="Arial, sans-serif" text-anchor="middle">
		<rect x="40" y="80" width="130" height="70" rx="10" fill="var(--sl-color-gray-6)" stroke="var(--sl-color-gray-5)" stroke-width="1.5"/>
		<circle cx="105" cy="80" r="15" fill="var(--sl-color-text-accent)"/>
		<text x="105" y="86" font-size="15" font-weight="700" fill="var(--sl-color-black)">1</text>
		<text x="105" y="122" font-size="19" font-weight="700" fill="var(--sl-color-white)">Load</text>
		<text x="105" y="174" font-size="13" fill="var(--sl-color-gray-3)">parse files</text>
		<rect x="205" y="80" width="130" height="70" rx="10" fill="var(--sl-color-gray-6)" stroke="var(--sl-color-gray-5)" stroke-width="1.5"/>
		<circle cx="270" cy="80" r="15" fill="var(--sl-color-text-accent)"/>
		<text x="270" y="86" font-size="15" font-weight="700" fill="var(--sl-color-black)">2</text>
		<text x="270" y="122" font-size="19" font-weight="700" fill="var(--sl-color-white)">Compile</text>
		<text x="270" y="174" font-size="13" fill="var(--sl-color-gray-3)">build the DAG</text>
		<rect x="370" y="80" width="130" height="70" rx="10" fill="var(--sl-color-gray-6)" stroke="var(--sl-color-gray-5)" stroke-width="1.5"/>
		<circle cx="435" cy="80" r="15" fill="var(--sl-color-text-accent)"/>
		<text x="435" y="86" font-size="15" font-weight="700" fill="var(--sl-color-black)">3</text>
		<text x="435" y="122" font-size="19" font-weight="700" fill="var(--sl-color-white)">Validate</text>
		<text x="435" y="174" font-size="13" fill="var(--sl-color-gray-3)">dry-compile SQL</text>
		<rect x="535" y="80" width="130" height="70" rx="10" fill="var(--sl-color-gray-6)" stroke="var(--sl-color-gray-5)" stroke-width="1.5"/>
		<circle cx="600" cy="80" r="15" fill="var(--sl-color-text-accent)"/>
		<text x="600" y="86" font-size="15" font-weight="700" fill="var(--sl-color-black)">4</text>
		<text x="600" y="122" font-size="19" font-weight="700" fill="var(--sl-color-white)">Plan</text>
		<text x="600" y="174" font-size="13" fill="var(--sl-color-gray-3)">pick a path</text>
		<rect x="700" y="80" width="130" height="70" rx="10" fill="var(--sl-color-gray-6)" stroke="var(--sl-color-gray-5)" stroke-width="1.5"/>
		<circle cx="765" cy="80" r="15" fill="var(--sl-color-text-accent)"/>
		<text x="765" y="86" font-size="15" font-weight="700" fill="var(--sl-color-black)">5</text>
		<text x="765" y="122" font-size="19" font-weight="700" fill="var(--sl-color-white)">Dispatch</text>
		<text x="765" y="174" font-size="13" fill="var(--sl-color-gray-3)">run in parallel</text>
		<rect x="865" y="80" width="130" height="70" rx="10" fill="var(--sl-color-gray-6)" stroke="var(--sl-color-gray-5)" stroke-width="1.5"/>
		<circle cx="930" cy="80" r="15" fill="var(--sl-color-text-accent)"/>
		<text x="930" y="86" font-size="15" font-weight="700" fill="var(--sl-color-black)">6</text>
		<text x="930" y="122" font-size="19" font-weight="700" fill="var(--sl-color-white)">Finalize</text>
		<text x="930" y="174" font-size="13" fill="var(--sl-color-gray-3)">commit or fail</text>
		<rect x="1030" y="80" width="130" height="70" rx="10" fill="var(--sl-color-gray-6)" stroke="var(--sl-color-gray-5)" stroke-width="1.5"/>
		<circle cx="1095" cy="80" r="15" fill="var(--sl-color-text-accent)"/>
		<text x="1095" y="86" font-size="15" font-weight="700" fill="var(--sl-color-black)">7</text>
		<text x="1095" y="122" font-size="19" font-weight="700" fill="var(--sl-color-white)">Report</text>
		<text x="1095" y="174" font-size="13" fill="var(--sl-color-gray-3)">exit code</text>
	</g>
</svg>
<figcaption>The seven phases of a run, in order. Everything narrows what can still go wrong before dispatch, the only phase that touches real data.</figcaption>
</figure>

## Load and compile

`pz` first parses `project.yml` and `connections.yml`, resolving environment variables and any
`--vars` overrides. A malformed file stops here, before a run directory even exists.

Then every `.sql` file under `pipelines/` renders as a template. This is how `pz` discovers the
dependency graph: it never parses SQL to guess at edges you didn't tell it about. Each
`source()`, `ref()`, and `sink()` call declares one edge as it fires. What comes out is a graph
of exactly four node kinds:

- **SourceLoad** loads one entity into the staging database.
- **Pipeline** runs one pipeline's `SELECT`.
- **Check** runs one data-quality assertion against a pipeline's result.
- **SinkWrite** writes one entity out to its destination.

`pz compile` and `pz ls` stop right here: one writes the graph to `.pz/target/manifest.json`,
the other just prints it.

## Validate before anything runs

Before `pz run`, `pz test`, or `pz retry` opens a real staging database, every pipeline's SQL
dry-compiles against empty tables shaped by its known columns. A broken query fails here, as one
clear error, instead of surfacing as a node failure partway through a real run. This is one tier
of a five-tier validation model; see [Validation and errors](/concepts/validation-and-errors/)
for the full set, including the connectivity checks that only run with `--connect`.

## Plan

For every edge, `pz` decides how the data actually moves: a native path when the connector can
hand DuckDB the work directly, or a universal batch path otherwise. `pz plan` prints this table
without running anything, so you can see the strategy before committing to it.

## Dispatch

Nodes run as soon as every parent has succeeded, up to a configured concurrency limit. This is a
topological dispatcher, not a fixed stage-by-stage schedule, so independent branches of the
graph run in parallel without you having to say so:

```
ok stg_orders 5 rows 12ms
ok orders_enriched 5 rows 8ms
ok check_orders_enriched_not_null_id_email 5 rows 3ms
FAIL lake.order_totals 0 rows 4ms
```

## Finalize and report

Sinks commit, or the node is marked failed. The staging database sticks around either way, so a
failure doesn't cost you the work that already succeeded, only the part that didn't. `pz` then
prints a summary line naming the run ID and where its results landed, and exits with a code that
says exactly what happened:

| Exit code | Meaning |
|---|---|
| `0` | Every node succeeded. |
| `1` | The run finished, but at least one node failed. |
| `2` | A configuration or validation error stopped the run before it started. |
| `3` | An unexpected, fatal error. |

A script that only checks for `0` misses the difference between "some data didn't land" and
"nothing ran at all." Checking for `2` specifically is how you tell "my config is wrong" from
"my data was wrong" without parsing any output.

## Why this shape makes retries cheap

Every run gets its own directory under `.pz/runs/<run-id>/`, holding the staging database and a
`run_results.json` written incrementally as nodes finish. That file is what `pz retry` reads: it
re-runs only what failed or was skipped, reusing everything that already succeeded rather than
starting the whole graph over.

```console
$ pz run orders_enriched
ok stg_orders 5 rows 12ms
ok orders_enriched 5 rows 8ms
FAIL lake.order_totals 0 rows 4ms
run 20260902T101533221Z-4c1a: 2 succeeded, 1 failed, 0 skipped

$ pz retry
note: reusing staged data for 2 source load(s) from run 20260902T101533221Z-4c1a
ok lake.order_totals 5 rows 6ms
run 20260902T101602118Z-9e2f: 1 succeeded, 0 failed, 0 skipped
```

Nothing here is special-cased for this one example. It falls straight out of every phase writing
down what it did before the next one starts.

## Try it

[How a run works](/concepts/how-a-run-works/) covers the same seven phases in full, including
the exit code table and every artifact a run leaves behind. [Delivery
guarantees](/concepts/delivery-guarantees/) picks up from here: what each write strategy
promises the destination when a run dies mid-write, and what `pz retry` will and won't redo.
