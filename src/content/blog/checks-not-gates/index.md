---
title: "Checks, not gates"
description: "A check is a data-quality assertion that runs inside the same dependency graph as your pipeline, close enough to free to run. It observes, it doesn't block, unless you tell it to."
date: 2026-09-12
heroImage:
  dark: ./hero-dark.svg
  light: ./hero-light.svg
  alt: "The words Checks, not gates, next to a large translucent PipelineZ Z-mark watermark."
---

The instinct with data quality is to bolt on a separate test suite: a different tool, a
different schedule, a different place to look when something's wrong. pz takes a smaller step:
a check is a data-quality assertion attached to a pipeline, declared right next to it, that
compiles into its own node in the same dependency graph the pipeline already runs in.

## Six check types, one place to declare them

Checks live under the `checks:` key in a pipeline's sidecar config:

```yaml title="pipelines/configs/orders_current.yml"
pipeline: orders_current
checks:
  - not_null: [order_id, status]
  - unique: [order_id]
  - row_count: { min: 1 }
  - freshness: { column: updated_at, max_age: 24h }
  - accepted_values: { column: status, values: [pending, shipped, delivered] }
  - custom_sql:
      name: no_negative_amounts
      sql: select * from staging.orders_current where amount < 0
```

`not_null`, `unique`, `row_count`, `freshness`, and `accepted_values` cover most of what a table
needs asserted about it. `custom_sql` is the escape hatch: it runs verbatim against the staging
database, so anything expressible as "this query returns zero rows" is a check.

| Check | Asserts |
|---|---|
| `not_null` | Named columns never contain a null. |
| `unique` | Named columns never repeat a value. |
| `row_count` | The result has at least (or at most) a given number of rows. |
| `freshness` | A timestamp column's newest value is within a max age. |
| `accepted_values` | A column's values all fall inside a fixed set. |
| `custom_sql` | Any query that should return zero rows. |

A check runs inside the staging database, right where its pipeline's data already sits. There's
no export step, no separate connection, no second copy of the row to keep in sync. That's what
makes it close to free to run.

## Checks observe, they don't gate

Here's the part that surprises people coming from a test suite: a check node depends only on
the pipeline it checks. It has no edge to that pipeline's sink writes. A failing check fails the
run, but it does not stop the flagged rows from landing at their destination. The check and the
write are siblings, not a gate in front of a door.

<figure style="overflow-x:auto">
<svg viewBox="0 0 1100 300" role="img" aria-label="A pipeline and its check drawn as siblings, both feeding a sink write that a failing check does not block; contrasted below with a gate pattern where the check sits in front of the write" xmlns="http://www.w3.org/2000/svg" style="width:100%;min-width:560px;height:auto;display:block">
	<defs>
		<marker id="pz-arrow-2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
			<path d="M 0 0 L 10 5 L 0 10 z" fill="var(--sl-color-gray-3)"/>
		</marker>
	</defs>
	<g font-family="Arial, sans-serif">
		<text x="30" y="30" font-size="14" font-weight="700" fill="var(--sl-color-text-accent)">pz: checks are siblings</text>
		<rect x="30" y="55" width="160" height="55" rx="8" fill="var(--sl-color-gray-6)" stroke="var(--sl-color-gray-5)" stroke-width="1.5"/>
		<text x="110" y="88" font-size="16" font-weight="700" fill="var(--sl-color-white)" text-anchor="middle">Pipeline</text>
		<rect x="30" y="135" width="160" height="55" rx="8" fill="var(--sl-color-gray-6)" stroke="var(--sl-color-gray-5)" stroke-width="1.5"/>
		<text x="110" y="168" font-size="16" font-weight="700" fill="var(--sl-color-white)" text-anchor="middle">Check</text>
		<rect x="330" y="95" width="160" height="55" rx="8" fill="var(--sl-color-gray-6)" stroke="var(--sl-color-text-accent)" stroke-width="2"/>
		<text x="410" y="128" font-size="16" font-weight="700" fill="var(--sl-color-white)" text-anchor="middle">Sink write</text>
		<path d="M 190 82 L 260 82 L 330 118" fill="none" stroke="var(--sl-color-text-accent)" stroke-width="3" marker-end="url(#pz-arrow-2)"/>
		<path d="M 190 162 L 260 162 L 260 118" fill="none" stroke="var(--sl-color-gray-4)" stroke-width="2" stroke-dasharray="5 5"/>
		<text x="265" y="180" font-size="13" fill="var(--sl-color-gray-3)">observes, never blocks</text>
		<line x1="0" y1="225" x2="1100" y2="225" stroke="var(--sl-color-hairline)" stroke-width="1"/>
		<text x="30" y="250" font-size="14" font-weight="700" fill="var(--sl-color-gray-3)">a gate, if you ask for one: pz test &amp;&amp; pz run</text>
		<rect x="30" y="260" width="140" height="40" rx="8" fill="var(--sl-color-gray-6)" stroke="var(--sl-color-gray-5)" stroke-width="1.5"/>
		<text x="100" y="285" font-size="14" font-weight="700" fill="var(--sl-color-white)" text-anchor="middle">Pipeline</text>
		<rect x="230" y="260" width="140" height="40" rx="8" fill="var(--sl-color-gray-6)" stroke="var(--sl-color-gray-5)" stroke-width="1.5"/>
		<text x="300" y="285" font-size="14" font-weight="700" fill="var(--sl-color-white)" text-anchor="middle">Check</text>
		<rect x="430" y="260" width="140" height="40" rx="8" fill="var(--sl-color-gray-6)" stroke="var(--sl-color-gray-5)" stroke-width="1.5"/>
		<text x="500" y="285" font-size="14" font-weight="700" fill="var(--sl-color-white)" text-anchor="middle">Sink write</text>
		<line x1="170" y1="280" x2="230" y2="280" stroke="var(--sl-color-gray-3)" stroke-width="2" marker-end="url(#pz-arrow-2)"/>
		<line x1="370" y1="280" x2="430" y2="280" stroke="var(--sl-color-gray-3)" stroke-width="2" marker-end="url(#pz-arrow-2)"/>
	</g>
</svg>
<figcaption>Default shape on top: pipeline and check both feed the write, and a failing check can't block it. The gated shape below only happens when you chain <code>pz test &amp;&amp; pz run</code> yourself.</figcaption>
</figure>

Treat a red check as an alarm on data that already shipped, not as a precondition for shipping
it. That's a deliberate choice: checks that are always siblings, never gates, means a check can
never accidentally deadlock a pipeline on a query that used to work and now returns one
unexpected row.

When you actually want a gate, ask for one explicitly:

```console
$ pz test && pz run
```

`pz test` runs the checks and their required ancestors, the owning pipeline and its sources,
without touching any sink. Chained with `pz run`, the load only happens behind a fully green
check pass.

## What a failure looks like

By default, a failing check's report includes a sample of the offending rows, so you're not
left re-deriving what tripped it from a boolean. The project-wide default lives at
`engine.check_samples` in `project.yml`, and any check can turn it off on its own:

```yaml
checks:
  - not_null: { columns: [id], sample_values: false }
```

`pz run` and `pz test` both exit `1` when any node fails, a failing check included, right
alongside a failing pipeline or sink write. The exit code tells you something went wrong; the
console output and the sample rows tell you what.

## Try it

[Checks](/concepts/checks/) covers the full sidecar config shape and the exit code table. The
`sqlserver` [quickstart](/quickstart/) template uses all six check kinds on one pipeline, so you
can see a real one fail and read the sample it prints.
