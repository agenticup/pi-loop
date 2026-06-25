# pi-loop — Product Overview

A tool for Pi that runs a recursive decompose-solve-critique-iterate-synthesize
loop on complex tasks. Instead of answering immediately, pi-loop breaks your
problem into sub-problems, solves each one, critiques the results, iterates on
weak spots, and only then gives you a final answer.

**One sentence:** pi-loop trades speed for thoroughness — it takes longer but
catches mistakes the model would miss on a first pass.

---

## What Problem Does It Solve?

A single LLM call has blind spots:
- It answers the *first* interpretation of your question, not necessarily the
  *best* one
- It doesn't check its own work
- It doesn't break complex problems into manageable pieces
- It optimizes for speed, not depth

pi-loop fixes this by adding **deliberate structure** to how the model thinks.

---

## How It Works (User-Facing)

```
Your prompt "Compare Temporal vs Hatchet for agent infrastructure"
  │
  ▼ DECOMPOSE — break into sub-problems
  ├─ How does Temporal handle agent workflows?
  ├─ How does Hatchet handle agent workflows?
  ├─ What are the key differences in durability?
  ├─ Which has simpler infrastructure?
  └─ Which is better for a startup?
  │
  ▼ SOLVE — answer each one independently (in parallel)
  │
  ▼ CRITIQUE — check each answer for gaps and errors
  │
  ▼ ITERATE — fix anything the critic flagged
  │
  ▼ SYNTHESIZE — combine into one coherent comparison
  │
  Final answer delivered
```

### Parameters You Can Control

| Parameter | What It Does | Default |
|---|---|---|
| `prompt` | The task to analyze | required |
| `maxDepth` | How deep to decompose (1-3). Level 2 means sub-problems themselves get broken down further. Each level roughly doubles cost. | 1 |
| `concurrency` | How many sub-problems to solve in parallel (1-8). Higher = faster but more API calls at once. | 4 |
| `model` | Which model sub-agents use. Leave empty to use your session's current model. | session model |

### Timeout

Each sub-agent has a 20-minute timeout. If a sub-problem takes longer, it fails
with `[Solution unavailable]` and the loop continues with the remaining
sub-problems. This prevents one slow sub-agent from blocking the whole run.

## Live Progress

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

Phase 1.5/5: Checking for critical missing preconditions...
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
At the end, a full execution summary shows verdicts per sub-problem.

---

## When Should You Use It?

### Good for pi-loop:
- **Complex analysis** — "Compare these 3 frameworks across 8 dimensions"
- **Architecture decisions** — "Design an auth system for a SaaS app"
- **Multi-step reasoning** — "What's the best deployment strategy for my stack?"
- **Anything where a single pass feels shallow** — trust your instinct here
- **Code reviews** — "Review this PR for correctness, security, and edge cases"
- **Research synthesis** — "Summarize these 5 papers and highlight contradictions"

### Not good for pi-loop:
- **Simple lookup** — "What's the capital of France?"
- **Single-file edits** — "Add error handling to this function"
- **Quick answers** — "What port does Postgres run on?"
- **Creative writing** — "Write a poem about AI"
- **Any task where a single agent response is sufficient**

**Rule of thumb:** If you'd normally ask Pi and then immediately say "critique
your answer" — use pi-loop. It does both in one shot.

---

## What Makes It Different from Regular Pi

| | Regular Pi | pi-loop |
|---|---|---|
| **Number of passes** | One | Five (decompose → solve → critique → iterate → synthesize) |
| **Sub-agents spawned** | 0 | Several (one per sub-problem) |
| **Self-critique** | No | Yes, adversarial review with mechanical gate |
| **Iteration** | Manual ("critique your answer") | Automatic (max 2 rounds per sub-problem) |
| **Latency** | Seconds | Minutes (but catches more errors) |
| **When to use** | Everything | Only for complex/deep work |

---

## How It Connects to Loop Engineering

pi-loop is a practical implementation of the ideas from the
[Loop Engineering](https://agenticup.dev/posts/loop-engineering-production-agent-loops/)
article on Agentic Up:

- **Gain-cost sweet spot:** Max 2 iterations per sub-problem. The first
  refinement catches most remaining issues. The third oscillates.
- **Reflexion pattern:** Self-critique after every solve phase. Reduces
  repeated mistakes by 30-50% on the failure subset.
- **Verifier-critic:** The critique phase uses an adversarial prompt that
  must respond with "PASS" or "ITERATE: <feedback>". The `startsWith("ITERATE")`
  check is a mechanical gate — the critic can't weasel out.
- **Three-layer architecture:** The loop engine (Layer 1), the pi-loop
  extension as a composable skill (Layer 2), and Pi's extension runtime
  as the orchestrator (Layer 3).

---

## Relationship to Other Pi Extensions

| Extension | What It Does | How pi-loop Differs |
|---|---|---|
| **pi-dynamic-workflows** | User writes JS scripts that fan out work across many sub-agents | pi-loop is a fixed pipeline — no scripting needed. You just give a prompt. |
| **pi-subagents** | General-purpose sub-agent spawning with queue management | pi-loop is purpose-built for one reasoning pattern. Sub-agents are implementation detail. |
| **context-mode** | Compresses context to save tokens (~98% savings) | Orthogonal — they work together |
| **ponytail** | System prompt injection for lazy/YAGNI mindset | Different behavior change. Ponytail changes *how* Pi thinks. pi-loop changes *the structure* of how it answers. |

---

## What People Use It For (Examples)

**"Design an auth system for my SaaS"**
→ pi-loop decomposes into provider selection, DB schema, login/logout endpoints,
session management. Solves each in parallel, critiques each, iterates on weak
spots, synthesizes a complete auth design.

**"Compare Temporal, Hatchet, and Restate for durable execution"**
→ pi-loop researches each engine independently, then compares across
infrastructure complexity, durability guarantees, cost, and community maturity.
The critic catches one-sided comparisons and forces balanced tradeoffs.

**"Review this PR for security issues"**
→ pi-loop decomposes into authentication flows, data validation, injection
vectors, dependency risks. Each gets solved, critiqued, and iterated. The
synthesis produces a prioritized list of findings.

---

## Limitations

- **Latency.** pi-loop takes longer than a single Pi response. Each sub-problem
  requires its own model call. Complex tasks can take 2-5 minutes.
- **No persistence.** If Pi restarts mid-loop, progress is lost. The loop runs
  entirely in memory.
- **Token cost.** Sub-agents use tokens independently. A 4-problem loop costs
  roughly 5-8x a single response (decompose + 4 solves + 4 critiques + iterations + synthesize).
- **Not for trivial tasks.** If a single Pi answer suffices, pi-loop is overkill.
  The overhead of decomposition and critique adds no value when the answer is
  straightforward.
