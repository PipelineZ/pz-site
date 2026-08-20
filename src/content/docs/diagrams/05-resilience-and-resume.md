---
title: "05 — Resilience & resume: what happens when things fail"
description: "This diagram is the failure story end to end: how damage is contained, what a failure cannot destroy, and what the destination is promised."
---

This diagram is the failure story end to end: how damage is contained, what a failure cannot
destroy, and what the destination is promised.

[![Resilience: four containment tiers, the progress records that survive a failure, and the delivery-guarantee matrix](/diagrams/05-resilience-and-resume.png)](/diagrams/05-resilience-and-resume.png)

**The main idea:** when something breaks, pz contains the damage at the narrowest tier that can
absorb it, keeps only progress that was *proven* durable, and resumes from that proof — so the
delivery guarantees hold even through failures.

The summary strip at the top says it in one line: a failure is contained at the narrowest tier
that can absorb it → progress already proven durable survives in a record → the next attempt
resumes from it → the guarantees hold.

## Reading the diagram

**Left: the containment ladder — four tiers, ordered by blast radius.** The red bar under each
row shows how much work a failure at that tier can cost you; it grows as you move down the
ladder. Blast radius means exactly that: the most work a single failure can force you to redo.

1. **Operation gate** — blast radius: one request. For connectors that opt in, the engine
   retries and paces a single idempotent request (idempotent = safe to repeat; re-sending the
   same request converges on the same result), honoring the server's `Retry-After`. A flaky HTTP
   call costs one request, never the whole node. The connector *declares* which operations are
   gate-safe; the engine does the retrying — connectors never retry internally.
2. **Node retry** — blast radius: one node attempt. The connector diagnoses the error (transient
   or permanent, and how long the server asked to wait); the engine owns the policy — attempts,
   exponential backoff, jitter. One diagnosis brain, one policy brain, never two retry loops
   multiplying each other.
3. **Circuit breaker** — blast radius: one instance (one configured external system, e.g. "this
   SQL Server"). When a system is clearly dying, pz stops hammering it: its queue pauses, a
   probe fires after cool-down, work resumes on success. Every other instance keeps running the
   whole time.
4. **`pz retry`** — blast radius: one run, and even that isn't paid twice. Retry re-runs only
   failed and skipped nodes, reuses the failed run's staged tables, and carries
   already-committed sinks forward.

**Right: what survives a failure.** Containment is half the story; the other half is the
progress records a failure cannot destroy. They live in two homes, chosen by lifetime:

- **`.pz/state/` — outlives runs** (left card). Two files with different trust models but the
  same discipline. `watermarks.json` holds the watermark: an ordered cursor value the engine
  computed and *verified* from landed rows. `sync-state.json` holds the sync token: an opaque
  "call this next time" pointer the connector issued, which the engine stores and replays
  verbatim without inspecting it.
- **`staging.duckdb`, schema `pz_meta` — travels with the run** (right card). Mid-slice
  progress. On the read side: which partitions landed, and each partition's checkpoint token (a
  page cursor stored after each durably staged chunk). On the write side: how many rows the
  destination actually *acknowledged*, fingerprinted against the content it was counted over.
  These ledgers are written in the same database transaction as the data they account for, so
  the ledger and the data can never disagree. `pz retry` attaches the failed run's staging
  database and resumes from them.

Between the two sits the **commit gate** (the yellow diamond): every long-lived record passes
one rule — a candidate value advances only after every downstream sink for that dataset has
committed. A half-landed run advances nothing. That is why a crash can never strand a watermark
past data a sink never received. The ledgers in `pz_meta` have a different lifecycle on purpose:
they're written at attempt teardown and cleared once the sink commits — they exist precisely
*for* the window when a run is incomplete.

The small `run_results.json` card completes the picture: the run receipt records each node's
provenance (`reused`, `carried_forward`), and that's what `pz retry` reads to decide what to
reuse and what to carry forward.

**Bottom: the promise — what the destination sees.** All the machinery above exists to keep
three commitments:

- **merge / replace → effectively-once.** Retries converge on the same final state: a replayed
  merge upserts the same keys, a replayed replace overwrites with the same result.
- **append → at-least-once.** A replay can deliver a row twice, so pz makes you say so
  explicitly: pairing an incremental dataset with an append sink requires
  `write: { duplicates: accept }`, enforced at compile time (PZ0214).
- **A mode the sink can't honor is refused before any data moves** — an unknown mode at compile
  time (PZ0228), an unsupported one at plan time (PZ0324).

The terminal card at the far right shows the honesty rule: when a sink still fails mid-write, pz
reports exposure truthfully — "delivery stopped: up to 45 row(s) already visible at the
destination" — and the next attempt resumes past exactly those 45. Honesty first, then
continuity.

## Key points

- Blast radius is a budget: one request, one attempt, one instance, one run — never more.
- Only proven progress survives: acknowledged rows, committed sinks, verified cursors.
- The ledger is written in the same transaction as the data — they can't disagree.
- State advances only after every downstream sink commits.
- Honesty, then continuity: pz says what's visible at the destination, then resumes past it.

## Common questions

- **Is the checkpoint machinery exactly-once?** No, and pz won't claim it. Resume delivers
  strictly *after* the acknowledged prefix, so nothing confirmed is ever re-sent — but a request
  the server processed without acknowledging (a timeout after the write landed) can be re-sent.
  That's why the matrix says at-least-once for append; keyed merge absorbs the replay and gets
  effectively-once.
- **What if the staged data changed between attempts?** The delivery record carries a content
  fingerprint (row count plus an order-independent hash). If the relation isn't the same
  multiset of rows, the recorded prefix means nothing and pz starts that sink from scratch.
  Resume never wins over correctness.
- **Who writes the checkpoints — the connector or the engine?** The engine owns every record on
  this diagram. Connectors only answer questions: "how many rows has the destination
  acknowledged?", "can you resume from row N?", "what's your page token?" A connector that can't
  prove its position doesn't pretend — the fallback is always to re-extract or re-deliver a
  bounded slice.
- **Why two state files instead of one?** Different trust models. A watermark is engine-verified
  against landed rows; a sync token is connector-issued and opaque. Keeping them separate keeps
  the trust boundary visible; both advance through the same commit gate.

This is the last diagram in the set. The arc across all five: declare in YAML and SQL (01–02),
move data through the hub (03), dispatch and observe it (04), and survive everything that goes
wrong along the way (05) — none of it configuration you have to remember; it's the default shape
of every `pz run`.
