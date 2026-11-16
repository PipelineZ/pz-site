---
title: "An agent that checks its own work"
description: "A coding assistant editing connections.yml and pipeline SQL is guessing until something tells it whether the edit worked. pz mcp gives it typed tools that validate every edit as it lands, keep credentials out of the files, and run nothing unless you started the server to allow it."
date: 2026-11-16
heroImage:
  dark: ./hero-dark.svg
  light: ./hero-light.svg
  alt: "The words An agent that checks its own work, above a yellow loop of tool calls running between an agent's terminal and a project, with a dashed, locked run node sitting off to the side."
---

Ask a coding assistant to add a Postgres source to a pz project and it will usually get close. It
writes a `connections.yml` block, a pipeline that calls `source()`, and tells you it's done. Whether
it's actually done is a separate question: maybe the option it used belongs to a different
connector, maybe the entity is declared in YAML and repeated as a `source()` argument, maybe the
password went into the file in plain text.

An agent with a shell can find out for itself: run `pz validate`, read the output, fix, repeat. That
works, with three catches. The check only happens if the agent remembers to run it after every
edit. The answer comes back as console text it has to parse. And the shell that lets it run
`pz validate` also lets it run `pz run` against production, or `echo` a password into
`connections.yml`.

`pz mcp` answers each one. It serves the project over the
[Model Context Protocol](https://modelcontextprotocol.io) as a set of typed tools: the edit and the
check are one call, the errors come back as structured fields, and running the project is a tool
that only exists if you started the server with it. That last part pays off when the agent works
on the project through pz's tools rather than a shell, so you can deny the shell in your client's
permissions without losing anything pz needs. pz never calls a model. The agent lives entirely on
the other side of the protocol, and pz is just a tool server it talks to.

## One command to connect

From the project directory:

```console
$ pz mcp init claude-code
```

That writes the `pz` entry into the client's own config file, `.mcp.json` for Claude Code, and
leaves every other key and server entry in that file alone. `vscode`, `copilot-cli` and `opencode`
work the same way, several at once or `--all`. A file that uses comments or trailing commas, which
a rewrite would quietly delete, is left untouched with a `PZ0611` that hands you the exact entry to
paste in by hand.

`pz mcp init` also installs a `pz-pipelines` skill next to each client: a short `SKILL.md` that
tells the assistant when the pz tools apply and the order to use them in, plus the full authoring
guide. Any other MCP client can launch `pz mcp` directly over stdio with the project root as its
working directory.

## What the agent sees

The server registers 22 tools, all prefixed `pz_`:

| Group | Tools | Touches |
|---|---|---|
| Introspect | `pz_project_overview`, `pz_connector_reference`, `pz_entity_schema`, `pz_state` | Reads the project; `pz_entity_schema` opens a real connection |
| Documentation | `pz_docs_list`, `pz_docs_search`, `pz_docs_get` | This site, the only tools that reach the network |
| Verify | `pz_compile`, `pz_validate`, `pz_plan` | Read-only, and unlike their CLI verbs they never write `.pz/target/` |
| Author | `pz_init_project`, `pz_add_connection`, `pz_update_connection`, `pz_remove_connection`, `pz_add_entity`, `pz_set_entity_options`, `pz_remove_entity`, `pz_write_pipeline`, `pz_remove_pipeline` | Edits `connections.yml` and `pipelines/` |
| Execute | `pz_run`, `pz_retry`, `pz_run_results` | Moves data, only under `--allow-run` |

`pz_connector_reference` returns each connector's own published JSON Schema for its connection and
entity options, so the agent doesn't have to remember that `localfiles` takes `root:` and Postgres
takes `host:`. It reads the schema the validator will check against. `pz_project_overview` returns
the compiled DAG with every pipeline's `ref()`s, sources and sinks, which is the map it needs
before changing anything.

Every tool answers in the same envelope: `ok`, an optional `result`, and an `errors[]` whose
entries are the same `PZ####` errors the CLI prints, each with a `file`, `line` and `next_step`
when pz knows them. An agent doesn't have to parse console output to find out what went wrong.

## Edits that check themselves

Every authoring tool follows the same three steps. It validates the proposed input before
touching anything, so a malformed request leaves the project exactly as it was. It splices the
edit into the file as text, so comments and every untouched line stay byte-identical: a
`connections.yml` you've annotated by hand doesn't come back reformatted. Then it compiles the
project and runs offline validation, and reports what it found in the same response.

That last step is the one that changes the loop. An edit that's fine on its own can still break
the project around it, and the tool says so right away:

```json
{
  "ok": false,
  "applied": true,
  "errors": [
    {
      "code": "PZ0341",
      "message": "read option 'columns' is declared both in connections.yml and as a source() argument",
      "file": "pipelines/stg_orders.sql",
      "line": 12,
      "next_step": "declare the option on exactly one surface; remove one of the two declarations"
    }
  ]
}
```

`applied: true` means the edit was written. It isn't rolled back, the same way a hand edit isn't,
because the next edit is usually the fix. The agent reads the `next_step`, moves the option to one
surface, and calls the tool again. `PZ0602` covers the other common mistake, adding something that
already exists or updating something that doesn't, and its `next_step` names the tool it meant to
call.

`pz_update_connection` replaces a connection block wholesale, so an agent that only passes the
option it meant to change would silently drop the block's `entities:`. It doesn't drop them
silently: the result lists every `dropped_entities[]` entry and points at `pz_add_entity` to put
them back, even when the update also left the project failing to compile, because a pipeline
still reading a dropped entity is usually why it fails.

## Running is your call, not the model's

Without `--allow-run`, the server can read, author and verify, but it can't move data, connect to
a database to write, or advance a watermark. `pz_run`, `pz_retry` and `pz_run_results` aren't
refused in that mode. They're absent from the tool list, so the agent never plans around a
capability it doesn't have.

```console
$ pz mcp init claude-code --allow-run
```

`--allow-run` is a flag on the server process, decided by whoever launches `pz mcp`. Nothing said
inside a conversation turns it on. When it's on, a run takes the same run lock the CLI takes, so an
agent's run racing your own `pz run` is refused with `PZ0604` instead of corrupting state. The
result lists every node with its status and row count, and a failed node carries its error code
and message, so the agent learns why a node failed without reading `run_results.json` off disk.

A run can also succeed while something went quietly wrong: schema drift under
`on_source_drift: warn`, a corrupt watermark file that made it re-extract everything, duplicate
merge keys collapsing in a batch. The CLI prints those as `note:` and `warning:` lines. `pz mcp`
has no console, so the same facts come back in `notices[]` and `warnings[]` on every run result.
A run with `status: success` and a non-empty `warnings[]` is worth a second look, from the agent
or from you.

## Credentials stay out of the files

An assistant that has seen a password in the conversation will happily write it into YAML. The
connection authoring tools refuse that before any file is written: an option whose key looks like
a credential (`password`, `token`, `secret`, `connection_string` and similar) has to be a `${VAR}`
reference, the whole value and nothing else, or the call fails with `PZ0601`. The read side is
just as strict. `pz_project_overview` returns connection names and connector types and never a
config value.

`${VAR}` resolves against the environment `pz mcp` was launched in, which it inherited from the
client. A variable exported after the server started won't reach it, so set it where the client
starts and restart the server.

Paths get the same treatment. Under `pz mcp`, a `localfiles` `root:`, `path:` or `base_dir:` that
points outside the project directory is refused with `PZ0606`, whether it's already in the config
or in a block the agent proposes. The check is lexical, a guardrail for steering an agent rather
than a sandbox. The plain CLI still trusts its paths, so a project that reads from elsewhere on
disk keeps running from the terminal; it just isn't drivable through an agent.

## Try it

[Use pz with an AI agent](/how-to/use-with-an-ai-agent/) walks through connecting each client,
with a troubleshooting table for the `PZ06xx` codes. The [MCP contract](/reference/mcp-contract/)
lists every tool's inputs and result fields under the same append-only stability promise the
[event stream](/reference/events/) makes. [Authoring for agents](/reference/authoring-for-agents/) is the
guide the skill installs, readable by people too.
