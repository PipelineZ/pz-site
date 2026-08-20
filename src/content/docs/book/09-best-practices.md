---
title: "9. Best practices"
sidebar:
  order: 9
---
Eight articles of machinery deserve a synthesis. This article is the habits - most of them
already earned the hard way somewhere in articles 1–8 - that separate pipelines people
*trust* from pipelines people *fear touching*. None of them require a bigger budget; all of
them require deciding early, because each gets more expensive to retrofit the longer you
wait.

## 1. Everything in version control

The whole pipeline - SQL, configuration, check definitions, documentation - lives in a git
repository, like any other software. This one habit quietly delivers half the article:

- **Review**: a second pair of eyes on the revenue definition *before* it ships.
- **History**: "when did cancelled orders stop being excluded?" is `git log`, not memory.
- **Rollback**: the bad Tuesday deploy is one revert away.
- **Reproducibility**: a new machine (or a new colleague) gets the *entire* pipeline by
  cloning. If it's not in the repo, it doesn't exist.

The corollary: **no manual edits to production data or config**. The 3 a.m. "quick fix"
applied by hand is invisible to review, to history, and to the rerun that overwrites it
next night. If the fix matters, it goes in the repo.

## 2. Design for rerunning (idempotency above all)

The single most valuable property a pipeline can have: **running it twice is safe**.
Everything hard in articles 3–6 gets easy on top of it - retries (rerun freely), backfills
(rerun the past), disaster recovery (rerun the world), debugging (rerun and watch).

The recipe, assembled from earlier articles:

- Idempotent loads: **merge or replace**, never bare append, unless duplicates were
  consciously accepted (article 4).
- **Deterministic** transforms: no `NOW()` inside logic; "as of when" is an input
  (article 5).
- Watermarks advance **only after** delivery commits (article 4).
- Rebuild tables from upstream; never patch them in place (article 5).

A useful drill: *pick any step and ask "what happens if this runs twice tonight?"* If any
answer is "numbers double," that's your next bug, currently scheduled.

## 3. Keep raw data, and keep steps small

Two structural habits that pay compound interest:

- **Land raw before transforming** (article 2's landing zone). Storage is cheap;
  re-extracting data the source no longer has is impossible. Raw data is your undo button
  and your evidence locker.
- **Many small steps over one clever step** (article 5's layers). Small steps are testable
  at the seams, debuggable by walking the chain, and cheap to change. If a SQL file needs
  scrolling to understand, it's asking to become two files.

## 4. Validate at the seams, monitor for absence

The two-sentence summary of articles 7–8, stated as practice:

- Every table that something depends on gets **checks** - at minimum `not_null` and
  `unique` on its key - and nothing user-visible is written from a table whose checks
  failed.
- Monitoring watches for the run that **didn't happen**, not just the one that failed; the
  dashboard admits its own age ("data as of…"); alerts are few enough that each one is
  read.

## 5. Be honest about failure (and gentle with sources)

- Classify errors: transient → retry with backoff, capped; permanent → fail *immediately*
  with a message naming the file, the cause, and the next step. An error message is
  documentation someone reads at their worst moment - write it for them. And report **all**
  the configuration errors at once, not one per attempt; nobody enjoys fix-run-fix-run
  whack-a-mole.
- Fail loudly or not at all. The forbidden option is the *silent* failure - the caught
  exception that logs nothing, the empty extract that "succeeds" (article 7's villain).
- Respect the systems you read from: off-peak schedules, incremental extraction, pushdown,
  concurrency caps, backoff on throttling (article 4). Pipelines borrow other people's
  databases; be the tenant who gets their deposit back.

## 6. Secrets are not configuration

Passwords, API keys, and tokens never go in the repository - one leaked git history is
forever. Reference secrets from the environment (or a secret manager) and let config point
at *names*:

```yaml
shop_db:
  connector: postgres
  host: ${SHOP_DB_HOST}
  password: ${SHOP_DB_PASSWORD}   # resolved at runtime, never stored
```

And make sure the *tooling* cooperates: connection strings and credentials must not leak
into logs, error messages, or run artifacts. (Better still, where the platform allows it,
use identity-based auth - e.g. cloud managed identities - and have no password at all.)
Adjacent habit: least privilege - the pipeline's database user can read the sources and
write the analytics schema, and nothing else. Extraction code with delete rights is a typo
away from a very bad day.

## 7. Test the pipeline, not just the data

Checks (article 7) validate data at runtime. Also test the *logic* before it ships:

- Keep a **sample project** - tiny CSVs, seconds to run - and run the full pipeline
  against it on every change. Most logic bugs surface here for free.
- **Diff before deploy** for changes to important tables: run old and new side by side,
  compare totals, explain every difference *before* stakeholders see it. Determinism
  (habit 2) is what makes byte-for-byte comparison possible at all.
- Treat compile-time validation as a gift: a tool that can parse, resolve, and sanity-check
  the whole project *without running it* turns a class of 3 a.m. failures into red squiggles
  at 3 p.m.

## 8. Write down the why

Six months from now, someone - probably you - will stare at `WHERE store_id <> 99` with no
idea that store 99 is the staff-training till. Code says *what*; only documentation says
*why*. The economical version: a README per project (what this is, how to run it, where
outputs go), a comment on every non-obvious rule, and descriptions on the tables people
query. Write for the person debugging at 3 a.m.; it's usually future-you.

## 9. Grow complexity only on demand

The quiet theme of the whole series. Batch before streaming (article 3). Full refresh before
incremental (article 3). Cron before an orchestration platform (article 6). Three layers
before a medallion-architecture diagram. One machine before a cluster. Every rung of
complexity has real daily costs in operation and understanding - climb when a *named,
current* pain demands it, and write down which pain, so you can climb back down if it goes
away.

## The checklist

For printing out, or for interrogating an existing pipeline:

- [ ] Everything is in git; nothing is hand-edited in production
- [ ] Any step, run twice, changes nothing (idempotent loads, deterministic SQL)
- [ ] Raw data is landed and kept; transforms are small and layered
- [ ] Key tables have not_null + unique checks; failed checks block visible outputs
- [ ] Someone finds out if the run *doesn't start*; the dashboard shows its data's age
- [ ] Transient errors retry with backoff and a cap; permanent errors fail fast, all at
      once, with next steps
- [ ] No secrets in the repo, logs, or artifacts; least-privilege credentials
- [ ] A tiny sample project runs the whole pipeline in seconds; big changes get diffed
- [ ] The *why* behind every odd rule is written next to it
- [ ] Every piece of complexity can name the pain that justified it

Ten boxes. A pipeline that ticks them is one Dana could hand over, one a new hire could
debug, and one the owner can believe. Which was the point all along.

---

*That closes Part I. Part II makes it concrete with a real tool:
[10. Meet pz](../10-meet-pz/)*
