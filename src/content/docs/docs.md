---
title: "Documentation"
description: "The map of the pz documentation: where to start, how the concept pages, how-to guides, connector pages, and reference fit together, and where contributors go."
sidebar:
  order: 1
---

pz is a command-line engine that moves data in batches. You describe a project as SQL files
plus one YAML file of connections, and pz compiles them into a dependency graph that DuckDB
executes. This page is the map of the documentation. Pick the row that matches what you need.

## Start here

| If you want to | Read |
|---|---|
| Install the tool | [Install pz](/install/) |
| See a project run in ten minutes | [Quickstart](/quickstart/) |
| Build a real pipeline step by step | [Tutorial](/tutorial/) |
| Learn the vocabulary | [Key concepts](/concepts/key-concepts/) |

## Learn how pz works

The concept pages explain one idea each, in the order you meet them when writing a project.

- [Project layout](/concepts/project-layout/): the files in a project and what each one does.
- [Connections and entities](/concepts/connections-and-entities/): the one YAML declaration that describes a place and the things you read from or write to it.
- [Pipelines](/concepts/pipelines/): SQL files that read with `source()` and `ref()` and load with `sink()`.
- [Checks](/concepts/checks/): assertions that run inside the graph and gate what gets written.
- [Incremental loads](/concepts/incremental-loads/): watermarks, bounded windows, change data capture, and merge.
- [Selecting nodes](/concepts/selecting-nodes/): running part of a project with `--select`.
- [How a run works](/concepts/how-a-run-works/): compile, plan, execute, and the artifacts a run leaves behind.
- [Delivery guarantees](/concepts/delivery-guarantees/): what pz promises when something fails halfway.
- [Validation and errors](/concepts/validation-and-errors/): the five validation tiers and how to read an error.
- [State](/concepts/state/): the `.pz/` directory, watermarks, and remote state backends.
- [Schema contracts](/concepts/schema-contracts/): column contracts, drift detection, and schema policy.
- [Connectors](/concepts/connectors/): builtin and third-party connectors, restore, and lock files.

## Do a specific task

The [how-to guides](/guides/) are grouped by job: ingest, reliability, production, AI agents,
and extending pz. Each guide states its goal, prerequisites, steps, and how to verify the result.

## Look something up

- [Connectors](/connectors/): one reference page per builtin connector, with every key and capability.
- [CLI](/reference/cli/): every verb, flag, and exit code.
- [project.yml](/reference/project-yml/) and [connections.yml](/reference/connections-yml/): the complete key sets.
- [Pipeline config](/reference/pipeline-config/), [template functions](/reference/template-functions/), and [error codes](/reference/error-codes/).
- [Environment variables](/reference/environment-variables/), [run events](/reference/events/), and the [MCP contract](/reference/mcp-contract/).
- [Versioning](/versioning/): what stays stable and how breaking changes are announced.

## Contribute to pz

The [Internals](/internals/architecture/) section explains the engine for people who change it:
architecture, the two-tier data plane, execution and resume internals, the connector ABI, a code
tour, and the [contributing guide](/internals/contributing/).

## Background reading

[Data Pipelines: An Article Series](/book/) is a ten-part introduction to pipelines in general,
with the last article showing how pz maps onto each idea.
