---
title: "Use pz with an AI agent"
description: "How to connect an MCP client such as Claude Code, VS Code, or GitHub Copilot CLI to pz mcp, and what the server does and does not expose by default."
sidebar:
  order: 16
---

`pz mcp` serves the current project to any [Model Context Protocol](https://modelcontextprotocol.io)
client, such as Claude Code, VS Code, GitHub Copilot CLI, or opencode, as a set of typed tools:
introspect the project, run `pz validate`/`pz compile`/`pz plan` as a fix loop, author
`connections.yml`/`pipelines/*.sql` with self-verifying edits, and, only if you opt in, actually
run the project. pz never calls an LLM itself; the agent lives entirely on the other side of the
protocol. Read this guide to connect a client. The full envelope and tool table live in the
[MCP contract reference](/reference/mcp-contract/).

## Prerequisites

- A `pz` project. Follow the [quickstart](/quickstart/) if you don't have one yet.
- One of the four supported clients, or any MCP client that can launch a local stdio server.

## Steps

1. **Wire up one or more clients in one command**, from the project directory:

   ```bash
   pz mcp init claude-code
   pz mcp init vscode claude-code copilot-cli opencode   # several at once
   pz mcp init --all                                     # all four
   ```

   This is merge-preserving: existing config files keep every other key and every other server
   entry, and only the `pz` entry is written or updated. Re-running is idempotent.

   For each client, `pz mcp init` also installs the embedded `pz-pipelines` skill, a `SKILL.md`
   plus an authoring guide, into the locations that client's ecosystem looks for skills in. Pass
   `--skill-locations` to override which locations get installed; see the
   [CLI reference](/reference/cli/#pz-mcp-init) for the full token list.

2. **Decide whether the agent may run the project.** Without `--allow-run`, the server exposes
   only introspection, verification, and authoring tools. It can read your project, validate its
   own edits, and iterate on `connections.yml`/pipeline SQL, but it cannot move data, hit a real
   database, or advance a watermark. The three execution tools are absent from the tool listing
   entirely when the flag is off, not present-but-refusing, so a connected agent never plans
   around a capability it doesn't have.

   Add `--allow-run` only when you want the agent to run the project itself:

   ```bash
   pz mcp --allow-run                    # direct invocation
   pz mcp init claude-code --allow-run   # baked into the generated client config
   ```

   That's a server-start flag, decided by whoever launches `pz mcp`, not something a model can
   toggle from inside a conversation. A gated run reports once, when it finishes, with the full
   node-by-node summary; its events do not stream to the client as progress notifications in this
   version. Watch a long run live with the CLI's own output or the NDJSON event stream instead.

3. **If your client isn't one of the four**, wire it up by hand. Every client needs the same two
   things: a command to launch (`pz mcp`, optionally with `--allow-run`) and a working directory
   at the project root.

   | Client | Config file | Top-level key |
   |---|---|---|
   | `vscode` | `<project>/.vscode/mcp.json` | `servers.pz` |
   | `claude-code` | `<project>/.mcp.json` | `mcpServers.pz` |
   | `copilot-cli` | `~/.copilot/mcp-config.json` | `mcpServers.pz` |
   | `opencode` | `<project>/opencode.json` | `mcp.pz` |

   For a generic client: `command: pz`, `args: [mcp]` (add `--allow-run` if the client supports
   execution tools), and `cwd` set to the project root. A client that can't set `cwd` can pass the
   directory explicitly instead: `args: [mcp, --project, /path/to/project]`.

## Verify

Ask the connected client to call `pz_project_overview`. A working connection returns the
project's name, flows, connections, and pipelines; a failed one means the client couldn't launch
`pz mcp` or reach it over stdio, usually a wrong command path or working directory.

## Concurrency

The server takes no long-lived project lock. Mutation tools are atomic per call, writing to a
temp file and renaming over the original, but there is no cross-call transaction, and a gated run
takes the same run lock a CLI-invoked `pz run` does. Two agents (or an agent and a human) pointed
at one project behave like two humans with two terminals: last write wins on files, and a run
racing a concurrent run excludes the loser rather than corrupting shared state. Running two agents
against the same project concurrently and expecting them to merge cleanly is not supported.

## Secrets

The MCP surface extends the project's existing secret-hygiene rule to authoring. Connection
config values never leave the server: `pz_project_overview` returns connection names and
connector types only, never a config value. The mutation tools that write connection config
require any option whose key name contains `password`, `secret`, `token`, `key`, or
`connection_string` to be a `${VAR}` reference, the whole value and nothing else. A literal value
in that shape is refused before any file is written.

A newly exported environment variable does not reach a running server: `pz mcp` resolves `${VAR}`
against the environment it was launched in, inherited from the client at launch. Set the variable
where the client will pick it up, then restart the server. See
[Secure connection config](/how-to/secure-connection-config/) for getting a secret into that
environment in the first place.

## Paths stay inside the project

Under `pz mcp`, a `localfiles` `path:`/`root:`/`base_dir:` that resolves outside the project
directory, `../` traversal or an absolute path elsewhere, is refused, whether it sits in existing
config or in a block an authoring tool proposes to write. The plain `pz` CLI is unchanged: a
project that legitimately reads outside its own directory still runs from the terminal, it just
isn't drivable through an agent.

## Troubleshooting

| If you see | Do |
|---|---|
| `PZ0605` from `pz mcp init` | No client was named and no `--all` was passed, an existing config file failed to parse as JSON, or `--skill-locations` named an unrecognized token. The message names which. |
| `PZ0601` from a mutation tool | The proposed connection config carries a credential-shaped value that isn't a `${VAR}` reference. Move it into the environment and reference it with `${VAR}` instead. |
| `PZ0103` after exporting a new secret | The running server never saw it. Set the variable where the client launches `pz mcp` from, then restart the server. |
| `PZ0604` on a run tool | Another run already holds the project's run lock, from the CLI or another MCP call. Wait for it to finish. |
| `PZ0606` from a mutation tool | A `localfiles` path resolves outside the project directory. Point it back inside the project, or make the edit from the CLI instead. |

## Related

- [MCP contract reference](/reference/mcp-contract/): the full result envelope, every tool's inputs and results, and the PZ06xx error codes.
- [Secure connection config](/how-to/secure-connection-config/): getting a secret into the environment the MCP server reads.
- [CLI reference](/reference/cli/#pz-mcp): every `pz mcp` and `pz mcp init` flag.
- [Author a connector](/how-to/author-a-connector/): what an agent using the authoring tools is ultimately editing.
