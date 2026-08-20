---
title: "Versioning and breaking changes"
description: "v0.x is a public preview. It is installable, tested, and usable for real work — and its surfaces may still change between minor versions (v0.1 → v0.2)...."
---

`pz` and every first-party package version together, computed by MinVer from git tags
(`v*`). This page is the public promise behind those numbers: what you can rely on
during v0.x, and what `v1.0.0` will freeze.

## What v0.x promises

v0.x is a public preview. It is installable, tested, and usable for real work — and
its surfaces may still change **between minor versions** (v0.1 → v0.2). Concretely:

- **Breaking changes land only at minor version bumps**, never at patches. A patch
  release (v0.1.x) only fixes bugs in already-shipped behavior.
- **Every breaking change is called out in the release notes** with a migration
  note: what changed, why, and the exact edit your project needs.
- **Your data is never silently reinterpreted.** A change that would alter what an
  existing project reads or writes (formats, delivery guarantees, type mapping)
  is a breaking change even when no API changed, and is treated as above.
- **Error codes (`PZ####`) are append-mostly**: a code's meaning does not change;
  retiring or renumbering one is a breaking change.

## What v1.0.0 freezes

`v1.0.0` is a promise, not a party. It ships when the surfaces below have each held
stable through a full public release cycle, and from then on they follow semver: no
breaking change without a major version.

| Frozen surface | Contract lives in |
|---|---|
| Connector ABI (the ecosystem's contract) | `Pz.Connectors.Abstractions` + [author-a-connector](/how-to/author-a-connector/) |
| Project YAML schema (`project.yml`, `connections.yml`) | [project-yml reference](/reference/project-yml/) |
| CLI verbs, flags, and exit codes | [CLI reference](/reference/cli/) |
| NDJSON run-event stream | [events.md](/events/) (already append-only by policy) |
| Error-code registry (`PZ####`) | reference docs |
| MCP tool surface and `ToolEnvelope` | [mcp-contract.md](/reference/mcp-contract/) (already append-only by policy) |

Two of these — the event stream and the MCP envelope — are already governed by
append-only stability contracts today, enforced by tests that diff the docs against
the code. v1.0 extends that discipline to the rest.

## What is never covered

- Internal APIs of non-packable projects (`Pz.Core`, `Pz.Engine`, …) — reference
  them at your own risk.
- The exact text of log lines, console rendering, and hints — only the NDJSON
  stream is a machine contract.
- `.pz/` internals other than the documented artifacts (`run_results.json`,
  `plan.json`, `pz.lock.json`).

## How changes are announced

Every release gets release notes on the GitHub release for its tag, with breaking
changes listed first. Deprecations, when possible, warn for at least one minor
version before removal.
