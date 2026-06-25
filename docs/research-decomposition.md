# Research Foundation — pi-loop

Twelve papers analyzed for how their decomposition, iteration, synthesis, and
loop architecture strategies apply to pi-loop. Each paper's core idea, key
results, and specific relevance to pi-loop's codebase.

---

## Quick Reference

| Paper | Applied to pi-loop | Status |
|---|---|---|
| **MAKER** — Extreme decomposition + voting | Decompose into 8-15 tiny sub-problems, adaptive 3-critic voting | ✅ Implemented |
| **DRIP** — Backward precondition checking | Phase 1.5: check for missing preconditions after forward decompose | ✅ Implemented |
| **ADaPT** — As-needed deeper decompose | Phase 4: deeper decompose flagged sub-problems when maxDepth > 1 | ✅ Implemented |
| **DRAGON** — Conflict detection in reconstruction | Synthesis: conflict detection + critic-weighted merging | ✅ Implemented |
| **Self-Refine** — Iterative self-feedback | Phase 3-4: critique → refine loop, MAX_ITERATIONS=2 | ✅ Implemented |
| **AgentDiet** — Trajectory reduction | appendLog bounded to 40 lines, old entries truncated | ✅ Implemented |
| **SGH** — Structured Graph Harness | Fixed pipeline, explicit phases, bounded recovery | ✅ Architecture matches |
| **Self-Healing Orchestrator** — Bounded recovery | Timeout + fallback + decompose escalation | ✅ Architecture matches |
| **ACONIC** — Constraint complexity | Complexity-guided decomposition | 🔲 Future |
| **AgentSpawn** — Dynamic memory inheritance | Cross-phase context sharing | 🔲 Future |
| **Focus** — Active context compression | Sub-agent context inheritance | 🔲 Future |
| **GSA** — Generative self-aggregation | Critic feedback in synthesis prompt | ✅ Implemented |

---

## Table of Contents

- [1. Decomposition Papers](#1-decomposition-papers)
  - [MAKER — Extreme Decomposition](#maker--extreme-decomposition-arxiv-251109030)
  - [ADaPT — As-Needed Decomposition](#adapt--as-needed-decomposition-arxiv-231105772)
  - [DRIP — Backward Precondition Checking](#drip--backward-precondition-checking-openreview-2025)
  - [ACONIC — Constraint Complexity](#aconic--constraint-complexity-arxiv-251007772)
- [2. Iteration Papers](#2-iteration-papers)
  - [Self-Refine — Iterative Self-Feedback](#self-refine--iterative-self-feedback-arxiv-230317651)
  - [MAKER Voting — Error Correction](#maker-voting--error-correction-arxiv-251109030)
  - [Iteration Limits Across Research](#iteration-limits-across-research)
- [3. Synthesis Papers](#3-synthesis-papers)
  - [DRAGON — Decomposition & Reconstruction](#dragon--decomposition--reconstruction-arxiv-260106502)
  - [Generative Self-Aggregation](#generative-self-aggregation-arxiv-250304104)
- [4. Loop Architecture Papers](#4-loop-architecture-papers)
  - [SGH — Critique of the Agent Loop](#sgh--critique-of-the-agent-loop-arxiv-260411378)
  - [Self-Healing Orchestrator](#self-healing-orchestrator-arxiv-260601416)
  - [Focus — Active Context Compression](#focus--active-context-compression-arxiv-260107190)
  - [AgentDiet — Trajectory Reduction](#agentdiet--trajectory-reduction-arxiv-250923586)
- [5. Sub-Agent Spawning Patterns](#5-sub-agent-spawning-patterns)
- [6. Full Architecture Checklist](#6-full-architecture-checklist)

---

# 1. Decomposition Papers

## MAKER — Extreme Decomposition (arxiv 2511.09030)

**Core idea:** Massively decomposed agentic processes (MDAPs). Break tasks into
the smallest possible sub-tasks — each microagent does exactly ONE thing.

**Key result:** First system to solve 1M+ LLM steps with zero errors.

**Three components:**
1. **Extreme decomposition** — each sub-task is trivially simple
2. **Error correction via voting** — 3-5 agents independently solve the same
   sub-task, majority vote
3. **Red-flagging** — split vote or low confidence → flag for human review

**Key insight:** "State-of-the-art reasoning models are not required; relatively
small non-reasoning models suffice" if decomposition is fine enough.

**Scaling law:** Error probability is LINEAR under extreme decomposition,
EXPONENTIAL without it.

**pi-loop implementation:**
- Decompose prompt asks for 8-15 tiny sub-problems instead of 4-6
- Each sub-problem must cover exactly ONE concern
- Design tasks: solvable in 2-3 sentences
- Review tasks: covers ONE file or ONE concern area
- Adaptive voting: 1 critic first, escalate to 3 on ITERATE

**Current prompt:**
```
- Aim for 8-15 sub-problems — finer granularity means fewer mistakes
- For design/architecture: solvable in 2-3 sentences
- For review/analysis: covers ONE file or ONE concern area
```

---

## ADaPT — As-Needed Decomposition (arxiv 2311.05772)

**Core idea:** Don't decompose everything upfront. Start coarse, decompose
further ONLY when the LLM can't execute a sub-task.

**Key result:** 28% higher success on ALFWorld, 27% on WebShop, 33% TextCraft.

**How it works:**
1. Start with coarse high-level sub-tasks
2. Attempt execution
3. If LLM fails → decompose that sub-task further
4. Recurse until all executable or max depth reached

**pi-loop implementation:**
- Phase 4 checks `problem.depth < maxDepth`
- If true: ADaPT path — decompose flagged problem into 3-5 smaller parts,
  solve in parallel, synthesize back
- If false: refine path — re-prompt with critic feedback
- Default maxDepth=1 (refine only). Set maxDepth=2+ for ADaPT behavior.

**Code (simplified):**
```
if (problem.depth < maxDepth):
  → decompose into sub-sub-problems (2-4 parts)
  → solve each in parallel (runConcurrent)
  → synthesize sub-solutions into refined solution
  → re-critique
else:
  → refine directly (re-prompt with feedback)
```

---

## DRIP — Backward Precondition Checking (OpenReview 2025)

**Core idea:** Start from the goal and ask "what preconditions must be true?"
Decompose those recursively. Catches what forward decomposition misses.

**pi-loop implementation:**
- Phase 1.5: after forward decompose, ask the model:
  "For each sub-problem, what precondition must be true before this can be
  solved? If a precondition isn't covered by any other sub-problem, add it."
- Missing preconditions are appended to the sub-problem list with `pre-` prefix
- Runs as a single cheap subAgent call

**Example:**
```
Forward decompose produces:
  → db-schema: Design database schema for multi-tenant isolation
  → auth: Build login/logout with JWT
  → api: Build REST endpoints

DRIP backward check:
  → pre-1: Define tenant identification strategy before schema design
  → pre-2: Choose JWT signing algorithm before building auth
```

---

## ACONIC — Constraint Complexity (arxiv 2510.07772)

**Core idea:** Model tasks as constraint satisfaction problems (CSPs). Use
**treewidth** — a formal measure of coupling — to guide decomposition. Lower
treewidth = more independent sub-problems.

**How it works:**
1. Reduce task to CSP: variables, domains, constraints
2. Build constraint graph
3. Compute treewidth (minimum possible maximum bag size)
4. Tree decomposition → weakly-coupled sub-problems

**Key result:** 3-8% accuracy improvement on Spider NL2SQL.

**Not implemented in pi-loop** — requires formal constraint modeling that
doesn't generalize to all LLM tasks. The principle is applied indirectly:
the decompose prompt asks for "no cross-dependencies."

---

# 2. Iteration Papers

## Self-Refine — Iterative Self-Feedback (arxiv 2303.17651)

**Core idea:** Same LLM generates, provides self-feedback, and refines
iteratively. No training data or RL needed.

**Three steps per iteration:**
1. **Generate** — produce initial output
2. **Feedback** — model critiques against quality criteria
3. **Refine** — regenerate incorporating feedback

**Key result:** Outperforms single-pass on math and reasoning. Gains largest
where errors are identifiable.

**Gap identified by the paper:** "Feedback quality degrades after 2-3 rounds" —
the same model tends to agree with itself, reducing critique value.

**pi-loop implementation:**
- MAX_ITERATIONS=2 (the sweet spot from the paper)
- Mechanical STARTSWITH("ITERATE") gate — more reliable than asking the LLM
  to self-assess
- Model parameter can route critics to a different model than the solver,
  reducing the confirmation bias Self-Refine identified

---

## MAKER Voting — Error Correction

MAKER's error correction via voting is applied to pi-loop's critique phase:

```
Phase 3 critique flow:

1. Run 1 critic (subAgent)
2. If critic says PASS → accept, done
3. If critic says ITERATE → escalate:
   - Run 2 more critics in parallel (Promise.allSettled)
   - 3 votes total, majority wins
   - Tie → PASS (don't iterate on uncertainty)
   - Majority ITERATE → enter Phase 4 refinement
```

This saves ~66% of critique calls on passing solutions while getting the
reliability benefit of majority voting on flagged solutions.

---

## Iteration Limits Across Research

| Method | Max Iterations | Stop Condition |
|---|---|---|
| Self-Refine | 2-3 (paper recommends 2) | Diminishing returns |
| MAKER | 1 + voting | Error correction per step |
| **pi-loop** | **2** (MAX_ITERATIONS) | **Mechanical STARTSWITH("ITERATE")** |
| Reflexion (Shinn et al.) | 3 (episodic) | Task completion signal |
| LoopCoder-v2 | 2 (empirical max) | SWE-bench degrades at 3 |

**Consensus:** 2 iterations is the sweet spot. First catches most issues.
Second catches a few more. Third oscillates or degrades. This is the
gain-cost tradeoff from the loop engineering article.

---

# 3. Synthesis Papers

## DRAGON — Decomposition & Reconstruction (arxiv 2601.06502)

**Core idea:** Decompose → solve independently → **reconstruct** with conflict
resolution. Reconstruction is NOT concatenation — it requires detecting and
reconciling contradictions between sub-solutions.

**Key mechanism:**
1. Identify high-optimization-potential regions → prioritize
2. Solve independently
3. Reconstruction agent reconciles conflicts
4. Iterate if residual issues

**pi-loop implementation:**
Synthesis prompt now includes:
- **Solutions** section — all sub-problem outputs
- **Critic Verdicts** section — PASS/FAIL per sub-problem with feedback
- **Conflict check instruction** — "if two solutions contradict, flag and
  resolve with reasoning"
- **Weight by critic** — PASS solutions preferred over WEAKNESS solutions

---

## Generative Self-Aggregation (arxiv 2503.04104)

**Core idea:** Selection-based aggregation (pick the best answer) fails because
LLMs are bad at discriminative judgment. Synthesis-based aggregation (generate
a NEW answer from all candidates) works because LLMs are good at generative
combination.

**pi-loop implementation:** Phase 5 uses synthesis (generative) not selection.
The synthesis model creates a new answer from all sub-solutions rather than
picking the "best" one. Critic feedback is also fed into the synthesis prompt
so weak points are addressed in the combined answer.

---

# 4. Loop Architecture Papers

## SGH — Critique of the Agent Loop (arxiv 2604.11378)

**Core thesis:** The standard agent loop has three structural weaknesses that
SGH fixes with an explicit DAG, bounded recovery, and immutable execution plans.

| Weakness | Standard Loop | pi-loop |
|---|---|---|
| Implicit dependencies | LLM reads context to decide | Fixed pipeline, 7 explicit phases |
| Unbounded recovery | Retry forever | MAX_ITERATIONS=2, timeout, fallback |
| Mutable history | Can revisit decisions | Phase output frozen once complete |

**pi-loop's trade:** The fixed pipeline trades expressiveness (can't do
arbitrary agent conversations) for controllability, verifiability, and
reliability. This exactly matches SGH's recommendation.

**SGH's three-layer separation** (planning ≠ execution ≠ recovery) maps to
pi-loop as: Phase 1 (plan) ≠ Phases 2-3 (execute) ≠ Phase 4 (recovery).

---

## Self-Healing Orchestrator (arxiv 2606.01416)

**Core idea:** Reliability as a bounded runtime control problem. Map failure
signals to failure classes, select recovery actions under explicit budgets.

| Failure Class | pi-loop handling |
|---|---|
| Tool timeout (>20min) | ✅ agentTimeoutMs=1200000 |
| Malformed arguments | ✅ extractJson() fallback |
| Stale context | ⚠️ Not yet handled |
| Contradictory evidence | ✅ DRAGON conflict check |
| Retry loops | ✅ MAX_ITERATIONS=2 |

**Improvement suggested:** Expose a total token budget to the user so the
loop stops spending after a cap, rather than running to completion regardless
of cost.

---

## Focus — Active Context Compression (arxiv 2601.07190)

**Core idea:** Let the agent actively decide when to consolidate learnings and
prune raw history, rather than passive external summarization.

**pi-loop's approach:** Avoid context bloat entirely by giving each sub-agent a
fresh session. No history to compress. Tradeoff: sub-agents can't learn from
earlier phases. Currently mitigated by passing decomposition context through
prompts.

---

## AgentDiet — Trajectory Reduction (arxiv 2509.23586)

**Core finding:** Agent trajectories contain widespread useless, redundant,
and expired information. Removing it cuts tokens 39.9-59.7% without harming
performance (validated on SWE-bench).

**Three waste types identified:**
| Type | Definition | pi-loop equivalent |
|---|---|---|
| Useless | Irrelevant to task | N/A — sub-agents have focused prompts |
| Redundant | Duplicate copies | appendLog sends full history on each update |
| Expired | Relevant only to completed steps | Phase-summary messages after phase done |

**pi-loop implementation:**
- `appendLog` bounded to 40 lines
- When exceeded: keep last 39 lines, insert `"⋯ truncated N lines · ..."`
- Prevents unbounded growth while keeping recent activity visible

---

# 5. Sub-Agent Spawning Patterns

### Phil Schmid's 4 Patterns (May 2026)

| Pattern | Tools | Lifetime | pi-loop |
|---|---|---|---|
| 1. Inline Tool | `call_agent` | Single task | ✅ subAgent() |
| 2. Fan-Out | `spawn` + `wait` | Single task | ✅ runConcurrent |
| 3. Agent Pool | `spawn`, `send`, `wait`, `list`, `kill` | Multi-turn | 🔲 Future |
| 4. Teams | Cross-agent messaging | Persistent | 🔲 Future |

**Key insight:** "Start with Pattern 1. Most tasks that feel like they need a
multi-agent system work fine with a well-prompted inline tool call."
pi-loop's Pattern 1 + Fan-Out approach is where most use cases belong.

### AgentSpawn — Dynamic Memory Inheritance (arxiv 2602.07072)

Adaptive spawning triggered by runtime complexity metrics. 34% higher
completion on SWE-bench. Child agents inherit relevant parent context.

**Relevance:** ADaPT deeper decompose currently creates stateless child
agents. AgentSpawn suggests inheriting the parent sub-problem's full context
(solutions, critique history, phase metadata) to give child agents more
context for their refined solutions.

### Subagent Inheritance Security (arxiv 2605.08460)

Inherited memory can carry malicious instructions from compromised parents.

**pi-loop benefit:** Stateless sub-agents (fresh session per call) are more
secure — no cross-contamination between sub-problems. Tradeoff: higher
createAgentSession overhead.

---

# 6. Full Architecture Checklist

| Dimension | pi-loop status | Reference Paper |
|---|---|---|
| Explicit dependencies | ✅ Fixed pipeline (7 phases) | SGH |
| Bounded recovery | ✅ MAX_ITERATIONS=2 | SGH, Self-Healing |
| Immutable execution | ✅ Phase output frozen | SGH |
| Error escalation | ✅ Timeout → fallback → ADaPT | SGH |
| Token budget | ❌ Not exposed to user | Self-Healing |
| Context freshness | ✅ Fresh session per sub-agent | Focus |
| Conflict detection | ✅ DRAGON-style in synthesis | DRAGON |
| Cost optimization | ✅ appendLog bounded to 40 lines | AgentDiet |
| Adaptive voting | ✅ 1 critic → escalate to 3 | MAKER |
| Precondition checking | ✅ DRIP backward pass | DRIP |
| As-needed depth | ✅ ADaPT path in Phase 4 | ADaPT |
| Extreme decomposition | ✅ 8-15 tiny sub-problems | MAKER |
| Iteration sweet spot | ✅ MAX_ITERATIONS=2 | Self-Refine, LoopCoder-v2 |

---

### Future / Not Implemented

| Paper | Reason | When to revisit |
|---|---|---|
| **ACONIC** — Constraint complexity | Requires formal constraint modeling — doesn't generalize to all LLM tasks | If pi-loop is extended to SAT/SQL/planning tasks specifically |
| **AgentSpawn** — Memory inheritance | ADaPT child agents currently stateless. Inheritance would add context but risk cross-contamination | If ADaPT deeper decompose shows quality gaps from missing parent context |
| **Focus** — Active context compression | Sub-agents already fresh-session (no bloat). Focus would help if pi-loop evolves to multi-turn agents | If Pattern 3 (Agent Pool) is implemented |
| **Token budget** — Cost cap | Not exposed to user. Would need a total token counter passed through all phases | If users report unexpected costs |
