---
title: "PipelineZ documentation"
description: "PipelineZ (pz) is a dbt-inspired batch ETL CLI for .NET, powered by DuckDB. Start with the quickstart, then pick the page type you need: how-to guides for..."
---

PipelineZ (`pz`) is a dbt-inspired batch ETL CLI for .NET, powered by DuckDB. Start with the
quickstart, then pick the page type you need: how-to guides for tasks, concepts for
understanding, reference for exact contracts.

## Get started

- [Quickstart: run your first pipeline](/quickstart/)
- [Key concepts](/concepts/key-concepts/) — DAG, node, source, sink, and the rest of the
  vocabulary
- [A code tour for new contributors](/concepts/code-tour/) — follows one `pz run` from the
  keystroke to the output files, naming the actual classes at every stop, in plain terms

## How-to guides

- [Inspect and validate a project](/how-to/inspect-and-validate/)
- [Handle schema drift](/how-to/handle-schema-drift/)
- [Detect schema drift at run time](/how-to/schema-drift/)
- [Run checks and retry failures](/how-to/run-checks-and-retry/)
- [Secure connection config](/how-to/secure-connection-config/)
- [Observe runs with Azure Monitor](/how-to/observe-runs-with-azure-monitor/)
- [Run scheduled on Windows](/how-to/run-scheduled-on-windows/)
- [Move state off the local disk](/how-to/remote-state/)
- [Tune retries per database](/how-to/tune-retries/)
- [Backfill in bounded slices](/how-to/backfill-in-slices/)
- [Throttle a struggling source or sink](/how-to/throttle-a-source/)
- [Extract from an HTTP API](/how-to/extract-from-http-api/)
- [Use Google Cloud Storage](/how-to/gcs/)
- [Capture changes with CDC](/how-to/capture-changes-with-cdc/)
- [Author a connector](/how-to/author-a-connector/)
- [Use pz with an AI agent](/how-to/use-with-an-ai-agent/)

## Concepts

- [Architecture overview](/concepts/architecture-overview/)
- [Project structure](/concepts/project-structure/)
- [The data plane](/concepts/data-plane/)
- [The execution model](/concepts/execution-model/)
- [Connectors](/concepts/connectors/)
- [Delivery guarantees](/concepts/delivery-guarantees/)
- [Validation and errors](/concepts/validation/)
- [Contributor internals](/concepts/contributing-internals/)

## Reference

- [CLI verbs and exit codes](/reference/cli/)
- [`project.yml` reference](/reference/project-yml/)
- [MCP contract reference](/reference/mcp-contract/)
- [Run events (NDJSON contract)](/events/)
- [Versioning and breaking changes](/versioning/)
- [Performance and memory](/performance/)
- [Diagram set](/diagrams/)
