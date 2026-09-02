---
title: "Diagrams"
description: "A gallery of the five diagrams that explain how pz works, from the whole machine down to what happens when a run fails, each linked to the page that explains it in prose."
sidebar:
  order: 8
---

Five diagrams walk from overview to detail, explaining how `pz` works. Every code, YAML, or SQL
snippet in them is real content from `templates/sample`. This page is the gallery; each section
links to the page that explains its content in prose.

## Diagram 01: overview

<figure class="dgm">
  <a href="/diagrams/01-overview.png">
    <img class="dgm-light" loading="lazy" decoding="async" src="/diagrams/01-overview.png" alt="Overview: a pz project of YAML and SQL compiles to a DAG that DuckDB executes, producing data and a run receipt" />
    <img class="dgm-dark" loading="lazy" decoding="async" src="/diagrams/01-overview-dark.png" alt="" aria-hidden="true" />
  </a>
  <figcaption>Click the diagram to open it full size.</figcaption>
</figure>

The whole machine in one picture: a project of YAML and SQL compiles into a DAG, DuckDB
executes it as the hub, and the run produces both data and a machine-readable receipt. It also
lays out the eight phases every verb shares. Explained in [Architecture](/internals/architecture/).

## Diagram 02: compiling to a DAG

<figure class="dgm">
  <a href="/diagrams/02-compile-dag.png">
    <img class="dgm-light" loading="lazy" decoding="async" src="/diagrams/02-compile-dag.png" alt="Compile: ref(), source() and sink() calls observed during rendering declare the DAG edges" />
    <img class="dgm-dark" loading="lazy" decoding="async" src="/diagrams/02-compile-dag-dark.png" alt="" aria-hidden="true" />
  </a>
  <figcaption>Click the diagram to open it full size.</figcaption>
</figure>

Zooms into compilation: how `ref()`, `source()`, and `sink()` calls observed during template
rendering declare the DAG's edges, with no SQL parsing involved, using `templates/sample`
verbatim. Explained in [Execution internals](/internals/execution-internals/).

## Diagram 03: the data plane

<figure class="dgm">
  <a href="/diagrams/03-data-plane.png">
    <img class="dgm-light" loading="lazy" decoding="async" src="/diagrams/03-data-plane.png" alt="The data plane: native scan versus streamed Arrow batches, chosen per edge" />
    <img class="dgm-dark" loading="lazy" decoding="async" src="/diagrams/03-data-plane-dark.png" alt="" aria-hidden="true" />
  </a>
  <figcaption>Click the diagram to open it full size.</figcaption>
</figure>

Zooms into how bytes physically move: the two-tier data plane, native scan/copy versus the
universal Arrow batch stream with bounded channels and stall-based bottleneck diagnostics, plus
how much data a single run claims (full load, incremental, or a bounded window). Explained in
[The data plane](/internals/data-plane/).

## Diagram 04: run lifecycle

<figure class="dgm">
  <a href="/diagrams/04-run-lifecycle.png">
    <img class="dgm-light" loading="lazy" decoding="async" src="/diagrams/04-run-lifecycle.png" alt="Run lifecycle: topological dispatch, one typed event stream, and retry semantics" />
    <img class="dgm-dark" loading="lazy" decoding="async" src="/diagrams/04-run-lifecycle-dark.png" alt="" aria-hidden="true" />
  </a>
  <figcaption>Click the diagram to open it full size.</figcaption>
</figure>

Zooms into `pz run` actually executing: the topological dispatcher under `engine.threads`, the
single typed event stream that feeds both the console tree and NDJSON, and failure/retry
semantics down to exit codes. Explained in [Execution internals](/internals/execution-internals/).

## Diagram 05: resilience and resume

<figure class="dgm">
  <a href="/diagrams/05-resilience-and-resume.png">
    <img class="dgm-light" loading="lazy" decoding="async" src="/diagrams/05-resilience-and-resume.png" alt="Resilience: four containment tiers, the progress records that survive a failure, and the delivery-guarantee matrix" />
    <img class="dgm-dark" loading="lazy" decoding="async" src="/diagrams/05-resilience-and-resume-dark.png" alt="" aria-hidden="true" />
  </a>
  <figcaption>Click the diagram to open it full size.</figcaption>
</figure>

The failure story end to end: four containment tiers ordered by blast radius, the progress
records that a failure cannot destroy (watermark, sync state, partition and delivery ledgers),
and the delivery-guarantee matrix those records exist to uphold. Explained in
[Resume internals](/internals/resume-internals/).

## Related

- [Architecture](/internals/architecture/): the design principles and layering behind diagram 01.
- [Execution internals](/internals/execution-internals/): the compiler and dispatcher behind diagrams 02 and 04.
- [The data plane](/internals/data-plane/): the two tiers behind diagram 03.
- [Resume internals](/internals/resume-internals/): the ledgers behind diagram 05.
