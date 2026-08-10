---
title: "11. What pz doesn't do"
sidebar:
  order: 11
---
Every tool is a set of bets, and honest documentation tells you which bets were made
*against* you. This closing article is that list for `pz`: its real limitations, the
trade-offs behind them, and - following article 9's "complexity on demand" rule in
reverse - the signals that you've outgrown it and what to reach for next.

## It's batch, all the way down

`pz` runs to completion and exits. There is no daemon, no always-on service, no streaming
mode. Even CDC - the closest it gets to "live" data - is batch-shaped: each run drains
whatever accumulated in the source's change log since the last run's position, then stops.
Freshness is therefore bounded by how often your scheduler invokes it; minutes-fresh via
frequent runs is realistic, seconds-fresh is not.

Article 3 argued most analytical needs are batch needs, and Sunrise Bakery's certainly are.
But if a real decision genuinely hangs on sub-minute data - fraud blocking, live inventory,
operational alerting on events - that's a streaming problem, and the honest answer is a
streaming system (Kafka plus a stream processor like Flink, or a managed equivalent), not a
batch tool run in a tight loop.

## It's one machine

The engine is DuckDB inside a single process on a single machine. That's a bet *on* the
article 2 observation that modern single machines are shockingly capable - and a bet
*against* distributed computation. There is no cluster mode, no way to spread one run
across ten machines.

Practically: your working set flows through one machine's disk and memory. DuckDB is
disk-backed (data doesn't need to fit in RAM) and columnar-fast, so this ceiling is much
higher than intuition suggests - but it exists. When nightly volumes reach the
hundreds-of-gigabytes-per-run scale, or a single transformation genuinely needs a cluster,
you've crossed into Spark territory, or into pushing transformation down to a distributed
warehouse (Snowflake, BigQuery) with a warehouse-centric tool like dbt orchestrating it.

## It doesn't schedule, and it has no UI

`pz` is deliberately only the *what-order* half of article 6. There is no built-in
scheduler, no web console, no run-history browser, no alerting service, no catalog. You
bring the *when* (cron, Windows Task Scheduler, a CI job) and point your existing
observability at the NDJSON events and OTel metrics it emits.

For one team and one project, article 6 called that architecture honest. The limitation
bites when you have *many* pipelines with cross-project dependencies ("run marketing's DAG
only after finance's lands"), event-driven triggers, or a non-engineering team that needs a
UI to watch and rerun things. Those are exactly the problems orchestration platforms
(Airflow, Dagster, Prefect) exist for - and `pz` runs happily *under* one as a task, so
the migration is additive, not a rewrite.

Within the pz family itself, this gap has a designated heir: **PipelineX** (`px`), a
companion platform built *around* pz rather than into it. It keeps pz as the engine and
adds the platform layer this section says pz lacks: git-backed projects with an IDE view,
agents that execute pz runs, live run monitoring with cancel/retry and crash detection,
and run events and versioned watermarks kept in a central SQL store instead of one
machine's `.pz/` directory. The division of labor is deliberate - pz stays the small,
scriptable, run-to-completion CLI, and everything long-running or multi-user lives in px.
The same honesty applies as everywhere in this article, though: today px is a
development-time IDE and monitor. Authentication, platform-owned scheduling, and a real
deployment story are on its roadmap but not shipped - until they land, production
operation remains "scheduler + pz + your observability stack," with px alongside as the
place to watch and drive runs.

## The ecosystem is young, and the platform is .NET

Six first-party connectors exist today: local files, Postgres, SQL Server, S3, Azure Blob,
and HTTP. Compare that to the hundreds of prebuilt connectors in mature ingestion
platforms (Airbyte, Fivetran). If your stack leans on Salesforce, Shopify, or Google
Analytics, `pz` means writing a connector against its (documented, test-kit-backed) ABI -
a real project, not an afternoon. Relatedly, running `pz` requires the .NET runtime; it's
a natural fit in a .NET shop and an extra dependency anywhere else.

And `pz` is **pre-release** (v0.x). The event contract and delivery-guarantee matrix are
managed as stability contracts, but pre-1.0 is pre-1.0: expect surfaces to evolve, read
release notes, pin versions.

## Transformations are SQL, full stop

There are no Python/C# transformation steps in the DAG. If a transformation needs an ML
model, fuzzy text matching, or a third-party library, it doesn't belong in a `pz` pipeline -
you'd run it as a separate step in your scheduler, exchanging data through files or tables.
Article 5 argued SQL covers the overwhelming majority of tabular transformation; the
remainder is a genuine boundary here, where tools like dbt (Python models) or Dagster
(arbitrary code assets) draw it more loosely.

## Design constraints you'll feel (and why they're there)

A few of `pz`'s rules read as limitations precisely because they refuse flexibility on
purpose:

- **One pipeline reads each source dataset.** Two pipelines can't both call
  `source('shop', 'orders')`; one loads it, everyone else `ref()`s the result. That's
  extract-once discipline (article 4's be-gentle-with-sources) enforced structurally - but
  it is a rule you must arrange your files around.
- **Effectively-once, not exactly-once.** article 4's honesty applies here too: merge and
  replace give you effectively-once; append is at-least-once and demands written consent
  (`duplicates: accept`) when paired with incremental reads. Nothing offers you magic
  exactly-once, because (as article 4 explained) nothing honestly can.
- **State lives on local disk by default.** Watermarks and run history under `.pz/` are
  perfect for a VM with a disk, and wrong for a container that evaporates after each run -
  for that you must configure the SQL Server-backed remote state store. Forgetting this on
  an ephemeral host silently turns every incremental run into a full re-extract.

## The fit, stated plainly

Choose `pz` when the profile matches Sunrise Bakery's: **scheduled batch ETL, data volumes
one machine handles (most companies', remember), sources within its connector set, a team
that thinks in SQL, and an appetite for git-reviewed configuration over web consoles** - a
fit that gets even better in .NET shops. Within that profile it packs an outsized amount
of Part I - derived DAGs, engine-enforced watermarks, delivery-guarantee consent, checks
that gate outputs, structured events - into one dependency-light CLI.

Reach past it, without guilt, when a signal fires:

| Signal | Reach for |
|---|---|
| Decisions need seconds-fresh data | Streaming (Kafka + Flink or managed equivalents) |
| A run outgrows one machine | Spark, or transformation pushed into a distributed warehouse |
| Many teams, cross-pipeline dependencies, need a UI | An orchestration platform (Airflow, Dagster, Prefect) - `pz` can run underneath it; PipelineX (`px`) is the pz-native platform growing into this role |
| Long-tail SaaS sources dominate | A managed ingestion platform (Fivetran, Airbyte) feeding your warehouse |
| Warehouse-centric stack, non-.NET team | dbt over the warehouse |

## Closing: back to Monday morning

We opened this series with Dana, two hours of copy-paste, and a number nobody could quite
audit. Eleven articles later, the same Monday looks like this: a crontab line fires at
06:00; connectors extract incrementally and politely; SQL layers rebuild deterministic
tables inside a workbench database; checks gate what the dashboard is allowed to see; a
failed night is one `pz retry` from healed; and every run leaves a structured, queryable
account of itself. The owner asks "how did we do last week?" and the answer is on a screen
before the question is finished - with a timestamp that says exactly how fresh it is.

No single tool made that true, and that's the real lesson. Pipelines earn trust through a
stack of small, boring decisions - idempotent loads, derived DAGs, checks at the seams,
honest failure - applied consistently. `pz` is one compact way to get those decisions made
for you; whatever tool you use, you now know which decisions they are, and why each one is
there. That knowledge transfers. Tools change; Monday morning always comes.

---

*Back to the [table of contents](../).*
