---
title: "Data Pipelines: An Article Series"
sidebar:
  order: 0
  label: "About this series"
---
A beginner-friendly article series about data pipelines: what they are, who builds them, how they are
built, and what a modern data platform looks like - explained in plain language, with one
running example and simple diagrams throughout. The final article introduces PipelineZ
(`pz`) and shows how it addresses each problem the earlier articles raise.

No prior data engineering experience is assumed. If you can read a spreadsheet and have seen
a SQL query before, you have everything you need.

## The running example

Every article uses the same fictional company: **Sunrise Bakery**, a small chain of bakeries
with an online shop. They have orders in a database, customer signups in a CRM, and payments
in a third-party service - and every Monday someone asks, "how did we do last week?"
Following that one question from "someone copies numbers into a spreadsheet" to "a reliable,
monitored, automated pipeline" is the arc of this series.

## The articles

### Part I - Fundamentals

1. [What is a data pipeline?](01-what-is-a-data-pipeline/) - the problem pipelines solve,
   who builds them, and why "a script that copies data" grows into something more.
2. [What modern data infrastructure looks like](02-modern-data-infrastructure/) - sources,
   lakes, warehouses, transformation, orchestration, and consumers, and how the pieces fit.
3. [Common pipeline patterns](03-common-pipeline-patterns/) - ETL vs ELT, batch vs
   streaming, full refresh vs incremental, and change data capture.
4. [Data ingestion: extracting and loading](04-data-ingestion-extracting-and-loading/) -
   connectors, watermarks, file formats, load strategies, and delivery guarantees.
5. [Transforming data](05-transforming-data/) - from raw records to answers: cleaning,
   joining, aggregating, and layering transformations so they stay maintainable.
6. [Orchestrating pipelines](06-orchestrating-pipelines/) - dependency graphs, scheduling,
   retries, parallelism, and backfills.
7. [Data validation and quality](07-data-validation-and-quality/) - why bad data happens,
   the checks that catch it, and where to put them.
8. [Monitoring and observability](08-monitoring-and-observability/) - knowing your
   pipelines ran, knowing they were *right*, and finding out before your users do.
9. [Best practices](09-best-practices/) - the habits that separate pipelines people trust
   from pipelines people fear.

### Part II - PipelineZ

10. [Meet pz](10-meet-pz/) - a small batch ETL tool for .NET: its core concepts, a complete
    working project, how it answers each problem from Part I, and where its deliberate
    boundaries are.

## How to read this series

Front to back if you're new - each article builds on the previous one. If you already run
pipelines for a living, Part I will read as a refresher and you can skim to
[Meet pz](10-meet-pz/). The diagrams use [Mermaid](https://mermaid.js.org/), which
GitHub renders inline; if you're reading the raw files, the diagram code is short enough to
read as text.
