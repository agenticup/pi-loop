# pi-loop

[![npm version](https://img.shields.io/npm/v/pi-loop?color=3cffd0&label=pi-loop)](https://npmjs.com/package/pi-loop)
[![License: MIT](https://img.shields.io/badge/license-MIT-3cffd0)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-3cffd0?logo=typescript)](https://www.typescriptlang.org/)
[![Read the article](https://img.shields.io/badge/Read-Loop%20Engineering-3cffd0)](https://agenticup.dev/posts/loop-engineering-production-agent-loops/)
[![Blog post](https://img.shields.io/badge/Blog-Building%20pi--loop-3cffd0)](https://agenticup.dev/posts/pi-loop-dot-ai/)

<img src="pi-loop-diagram.svg" alt="pi-loop 5-stage diagram" width="600"/>

pi-loop makes Pi think deeper about complex tasks.

Implements a research-backed recursive loop with:

- **Decompose** — MAKER-style extreme decomposition into 8-15 tiny sub-problems
- **DRIP backward pass** — checks for missing preconditions after decomposition
- **Solve** — sub-agents produce solutions in parallel via semaphore concurrency
- **Critique** — adaptive MAKER voting: 1 critic, escalates to 3 on disagreement
- **Iterate** — ADaPT-style: deeper decompose flagged sub-problems when possible
- **Synthesize** — DRAGON-style conflict detection between sub-solutions

> **This is a Pi extension.** Install with `pi install`, not `npm install`.

## When to use

| Good for | Not good for |
|---|---|
| Complex analysis, architecture decisions | Simple lookups, quick answers |
| Multi-step reasoning, code reviews | Single-file edits |
| Research synthesis, tradeoff comparisons | Creative writing |
| Anything where one pass feels shallow | Tasks a single prompt handles fine |

## Install

```bash
pi install npm:pi-loop
```

Then reload Pi:

```
/reload
```

## Quick start

Tell Pi you want a deep dive:

```
Use loop: design an auth system for my SaaS app
```

Pi calls the `loop` tool, runs the 5-stage pipeline, and returns a synthesized answer. The model decides when to use the tool based on task complexity.

### Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `prompt` | string | required | The task to recursively decompose and solve |
| `maxDepth` | number | 1 | Recursion depth (1-3). Each level further decomposes sub-problems. ~2x cost per level. |
| `concurrency` | number | 4 | Parallel sub-agents (1-8). Higher = faster, more API calls in-flight. |
| `model` | string | session | Override the sub-agent model (e.g. `claude-sonnet-4`) |

Each sub-agent has a **20-minute timeout**. If a sub-problem takes longer, it
fails gracefully and the loop continues with the remaining sub-problems.

## How it works

pi-loop shows real-time progress as it works through each phase:

```
Phase 1/5: Decomposing task into 12 sub-problems...
  → token-bucket: Token bucket algorithm choice
  → redis-backend: Redis-backed rate limit store
  → free-tier-limits: Rate limits for free tier
  → paid-tier-limits: Rate limits for paid tier
  → header-format: Rate limit response headers
  → burst-handling: Burst allowance strategy
  → distributed: Cross-instance coordination
  → error-codes: HTTP 429 response format
  → cost-tracking: Usage tracking per customer
  → key-design: Rate limit key structure
  → alerting: Rate limit monitoring and alerts
  → migration: Migrating from old rate limiter
Phase 1 done: Task broken into 12 sub-problems — token-bucket, redis-backend, ...

Phase 1.5/5: Backward-checking for missing preconditions...
  DRIP found 1 missing precondition(s) — added to sub-problems
  → tier-definition: Define free vs paid tier boundaries

Phase 2/5: Solving 13 sub-problems...
  ✓ token-bucket — Token bucket with refill rate 10/s per key... (1/13)
  ✓ redis-backend — Redis Sorted Sets with atomic Lua increment... (2/13)
Phase 2 done: All 13 sub-problems solved

Phase 3/5: Critiquing 13 solutions...
  ✓ token-bucket — ✓ PASS (1/13)
  ✗ free-tier-limits — ✗ ITERATE: No burst allowance for free tier... (4/13)
  ✗ distributed — ✗ PASS (2/3 critics voted PASS) (9/13)
Phase 3 done: 11 passed, 2 flagged for iteration — free-tier-limits, alerting

Phase 4/5: Checking 13 sub-problems for refinement...
  ⟳ free-tier-limits: decomposing deeper (depth 1 → 2)...
  ⟳ free-tier-limits: recomposed from 3 deeper parts (v1)
Phase 4 done: 2 sub-problems refined — free-tier-limits (1x), alerting (1x)

Phase 5/5: Synthesizing final answer...
  (conflict check: free tier "no bursts" vs paid tier "unlimited bursts" — resolved)
```

Everything stays visible — truncated to 40 lines if the run is very long.
At the end, a full **execution summary** shows verdicts per sub-problem.

## The gain-cost sweet spot

Each iteration provides diminishing returns:
- **First pass** (solve) captures ~80% of the value
- **Second pass** (critique → iterate) catches ~15% of remaining issues
- **Third pass** → diminishing returns, model often oscillates

The critique gate enforces this — a sub-problem only iterates if the critic
flags issues, and caps at 2 iterations. Most problems pass on the first try
or need exactly one refinement.

## Limitations

- **Latency.** Each sub-problem requires its own model call. Complex tasks take
  2-5 minutes instead of seconds.
- **Token cost.** A 4-problem loop costs roughly 5-8x a single response
  (decompose + 4 solves + 4 critiques + iterations + synthesize).
- **No persistence.** If Pi restarts mid-loop, progress is lost. The loop runs
  entirely in memory.
- **Overkill for simple tasks.** If a single Pi answer suffices, pi-loop adds
  overhead without benefit.

## Related

- [Loop engineering: the production agent loop nobody talks about](https://agenticup.dev/posts/loop-engineering-production-agent-loops/) — the article this tool implements.
