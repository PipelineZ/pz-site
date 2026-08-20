---
title: "7. Data validation and quality"
sidebar:
  order: 7
---
There are two ways a pipeline can fail. It can **crash** - loud, obvious, fixed by
breakfast. Or it can **succeed with wrong data** - silent, invisible, discovered three weeks
later by the owner asking why the dashboard says a bakery sold negative croissants. The
second kind is worse in every way that matters: wrong numbers drive wrong decisions and,
once caught, poison trust in every *right* number the pipeline ever produced.

Data validation is how you convert failures of the second kind into failures of the first.

## Where bad data comes from

Not, usually, from your code. The recurring culprits:

- **Humans upstream.** A clerk fat-fingers `2,400.00` instead of `24.00`. A test order from
  the staff party lands in production data.
- **Systems upstream.** An app deploy starts writing `NULL` customer IDs for guest
  checkouts. The API starts returning amounts in cents where it used to send euros.
- **The pipeline's own seams.** An at-least-once retry delivers the same rows twice
  (article 4 warned you). A join you assumed was one-to-one is quietly one-to-many, and row
  counts double.
- **Time.** Timezone drift, daylight saving, late-arriving records landing in last week's
  totals.

Notice the pattern: none of these throw errors. Every one of them flows through an unguarded
pipeline and comes out the other side looking like data.

## Checks: assertions about data

The fix is the same idea software engineers use everywhere - **assertions** - pointed at
data instead of code. A **check** is a rule the data must satisfy; the run fails (loudly!)
when it doesn't. A small vocabulary covers most real-world damage:

| Check | Plain meaning | The disaster it catches |
|---|---|---|
| `not_null` | This column always has a value | Guest-checkout NULLs making revenue vanish from customer reports |
| `unique` | No two rows share this value | Duplicated orders doubling revenue |
| `accepted_values` | Only these values allowed | A new `'refunded'` status silently uncounted by old logic |
| relationship | Every value exists in that other table | Orders pointing at customers the CRM extract missed |
| range | Value between sensible bounds | The €2,400 croissant; negative amounts |
| **freshness** | Newest row is recent enough | The extraction that's been silently pulling nothing for a week |
| **volume** | Row count in a plausible band | The half-empty extract from a source that hiccuped mid-pull |

The last two deserve emphasis because they're the ones beginners skip: freshness and volume
checks catch problems *in the pipeline itself*, not just in the rows. "Zero new orders on a
Saturday" is technically valid data and almost certainly a broken extraction.

In modern tools these are one line of configuration next to the transformation they guard:

```yaml
# checks on the orders_enriched table
checks:
  - not_null: [id, email]
  - unique: [id]
```

One line. Compare that to the cost of the failure it prevents, and data validation becomes
the best deal in this series.

## Where to put checks: the seams

Checks belong at the **boundaries** - the same layer seams article 5 built:

<figure class="dgm">
  <a href="/diagrams/book/07-checks-as-gates.png">
    <img class="dgm-light" loading="lazy" decoding="async" src="/diagrams/book/07-checks-as-gates.png" alt="Checks drawn as gates on the edges between stages, with the assertions each gate enforces, plus what happens when one fails: the run stops and the dashboard keeps yesterday's correct number.">
    <img class="dgm-dark" loading="lazy" decoding="async" src="/diagrams/book/07-checks-as-gates-dark.png" alt="" aria-hidden="true">
  </a>
  <figcaption>Click the diagram to open it full size.</figcaption>
</figure>

- **At ingestion** - validate what the *source* sent, before anything transforms it. This is
  where schema expectations (article 4's drift posture) live: is `amount` still a number?
- **After each transformation layer** - validate what *you* made. `unique order_id` after
  staging's dedup proves the dedup worked; a row-count comparison across a join catches the
  one-to-many surprise on the night it appears.
- **Before the final load** - the last gate before numbers become visible. The cardinal
  rule sits here: **a table that fails its checks should never reach the dashboard.** In
  DAG terms (article 6): checks are nodes, and the final write depends on them passing.

Checks-as-DAG-nodes is the elegant bit - no new machinery. A failed check behaves exactly
like a failed step: its downstream cone is skipped, everything independent completes,
and the run reports honestly.

## Fail or warn? Calibrating severity

Not every rule deserves to stop the presses:

- **Fail** when acting on the data would be worse than not having it: duplicate order IDs,
  negative revenue, an empty orders extract. Blocking beats publishing fiction.
- **Warn** when the data is imperfect but usable: 2% of orders missing a store assignment.
  The run continues; the issue is logged and visible, and stakeholders see numbers with a
  known caveat instead of no numbers.

Two failure modes to steer between: check *nothing* (silent corruption flows freely) and
fail on *everything* (the dashboard is down weekly for trivia, and people start ignoring
red - the worst outcome of all, because ignored alarms are how the real one gets missed).
A useful calibration question: *"if this rule breaks, should the owner see no data or this
data?"* Let the answer pick the severity.

A refinement for the warn-ish middle ground: **quarantine**. Route rows that fail a check
into a side table (`orders_quarantine`) instead of dropping or passing them - the 98% good
rows flow on, the 2% weird ones wait, visible, for a human. Nothing silently vanishes,
which is the property you're really buying.

## Beyond checks: contracts and reviews

Two habits extend validation past the run itself:

- **Data contracts** - an explicit agreement with the *producer*: "the orders table has
  these columns, these types; `id` is unique; you'll warn us before changing it." Even
  informally agreed and enforced by your ingestion-time checks, a contract transforms the
  conversation from "your dashboard is broken" to "the source broke the contract on
  Tuesday" - with receipts.
- **Test data changes like code changes.** When you edit the revenue logic, run the old and
  new versions side by side and diff the totals *before* shipping. Checks guard against bad
  data; this guards against bad *logic*, which checks can't see.

## Sunrise Bakery, guarded

The night the shop deploys guest checkout, the pipeline fails at 06:04:
`not_null check failed: customer_id - 47 of 512 rows null (stg_orders)`. The dashboard
shows yesterday's trusted numbers with a "data delayed" note. By 09:30 the team has decided
guest orders are real revenue, added a `guest` placeholder customer, adjusted the check,
and rerun. Total cost: one morning coffee's worth of delay - and the owner never saw a
wrong number. That is data validation working *exactly* as designed: the crash you
configured, instead of the silent lie you didn't.

## The takeaway

- The dangerous failure is the silent one; checks convert it into a loud one.
- A small vocabulary - not_null, unique, accepted values, relationships, ranges, freshness,
  volume - catches most real damage for one line of config each.
- Put checks at the seams: ingestion, after each layer, and as a gate before anything
  user-visible. Checks are DAG nodes; failed checks block their downstream.
- Calibrate fail vs warn deliberately; quarantine the borderline rows.
- Trust is the product. Checks are how a pipeline earns it back every single night.

---

*Next: [8. Monitoring and observability](../08-monitoring-and-observability/)*
