# Planned Evaluation

What we want to measure, and why.

---

## Why evaluate this at all?

Ideas like `RPG`, `lease`, and `guard` feel intuitively right.

But intuition is not enough.

We need to know whether these ideas actually help in practice:

1. do they reduce unsafe actions?
2. do they reduce unnecessary re-observation?
3. do they reduce expensive retries and recovery loops?

---

## Evaluation questions

### Q1. Safety

Compared with a conventional `snapshot-and-act` loop, can
`RPG + lease + guard` reduce unsafe actions?

### Q2. Observation efficiency

Can it reduce repeated screenshots and other high-cost observation steps?

### Q3. Recovery quality

When the world changes, can it fail safely instead of failing silently?

---

## Scenarios we want to test

The first planned scenarios are:

- `focus-theft`
- `modal-insertion`
- `window-drift`
- `entity-replacement`
- `delayed-action`

These all express the same deeper issue:
the assumptions formed during observation are no longer valid by the time action is attempted.

---

## Metrics

The first set of metrics is intentionally small.

| Metric | Meaning |
|---|---|
| `unsafe_action_rate` | How often an action lands on the wrong target |
| `reobserve_count` | How often the agent has to observe again |
| `token_heavy_observations` | How often expensive observation is used |
| `task_success_rate` | How often the task eventually completes |
| `recovery_steps` | How many steps are needed after a problem is detected |

---

## Baseline and proposed setup

### Baseline

- observe
- think
- act
- optionally confirm

This is the simple loop that implicitly trusts the old snapshot.

### Proposed

- provisional state
- dirty / stale tracking
- lease validation
- guarded execution
- demand-driven refresh

This is the uncertainty-aware loop.

---

## Reporting format

The goal is to store results in a machine-readable format first:

- raw JSON
- summary CSV
- short Markdown report

The public page should then show only the compact tables and short explanations.

---

## Status

Current status:

- scenario definitions: in progress
- experiment command design: sketched
- automatic aggregation: not implemented yet
- public result schema: added

---

## Related files

- `site/assets/eval/README.md`
- `site/assets/eval/result-schema.json`
- `docs/github-pages-rpg-article-plan.md`
