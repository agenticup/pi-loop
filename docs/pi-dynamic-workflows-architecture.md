# pi-dynamic-workflows — Architecture Reference

**Package:** `@quintinshaw/pi-dynamic-workflows` v2.8.0
**Downloads:** 1.7K/mo
**Source:** `~/.pi/agent/npm/node_modules/@quintinshaw/pi-dynamic-workflows/`

Claude Code-style dynamic workflow orchestration for Pi. Instead of one
agent doing everything sequentially, the model writes a JavaScript script
that fans out work across many isolated sub-agents, then synthesizes results.

---

## What It Does

Registers one LLM-callable tool:

| Tool | Purpose |
|---|---|
| `workflow` | Execute a JavaScript workflow script that orchestrates sub-agents |

The model writes scripts using a sandboxed API:

```javascript
export const meta = { name: 'audit', description: 'Audit the codebase' };

phase('Scan');
const inventory = await agent('Inspect structure', { label: 'inventory' });

phase('Analyze');
const results = await parallel(
  items.map(item => () => agent(`Analyze ${item}`, { label: item }))
);

return { inventory, results };
```

---

## Architecture

### File Overview

| File | Size | Role |
|---|---|---|
| `workflow.ts` | 45 KB | Script parsing, sandboxed execution, runtime globals |
| `workflow-ui.ts` | 26 KB | Progress rendering, TUI components |
| `workflow-editor.ts` | 23 KB | In-editor workflow composition UI |
| `workflow-manager.ts` | 21 KB | Background run lifecycle, pause/resume, journaling |
| `workflow-tool.ts` | 21 KB | Tool definition, prompt guidelines, schema |
| `agent.ts` | 20 KB | Sub-agent session creation (createAgentSession wrapper) |
| `task-panel.ts` | 18 KB | Result delivery panel |
| `run-persistence.ts` | 10 KB | Journaled persistence for resume |
| `display.ts` | 10 KB | Snapshot rendering for progress display |
| `workflow-commands.ts` | 11 KB | Slash commands (/workflows, /ultracode, etc.) |

### Data Flow

```
User: "Audit the codebase"
  │
  ▼ Pi model calls workflow tool
  │   params: { script: "export const meta = {...} ..." }
  │
  ▼ workflow-tool.ts: execute()
  │   Creates WorkflowManager → parses script → runs
  │
  ▼ workflow.ts: runWorkflow()
  │   Creates VM sandbox with globals:
  │     agent(), parallel(), pipeline(), phase(), log()
  │     args, cwd, budget
  │
  ▼ agent.ts: WorkflowAgent.run()
  │   Wraps createAgentSession → spawns sub-agent
  │
  ▼ Results flow back: agent → workflow → tool → user
```

### The Sandbox (workflow.ts)

Scripts execute in a Node.js `vm` context — not `eval()`. The sandbox
injects deterministic globals only:

```typescript
import vm from "node:vm";

const context = {
  agent: async (prompt, opts) => { ... },
  parallel: async (thunks) => { ... },
  pipeline: async (items, ...stages) => { ... },
  phase: (title) => { ... },
  log: (message) => { ... },
  args: options.args,
  cwd: options.cwd,
};

const script = new vm.Script(userScript, { filename: "workflow.js" });
script.runInNewContext(context);
```

**Determinism enforced:** `Date.now()`, `Math.random()`, and `new Date()`
are intercepted and throw. This guarantees reproducible workflow runs for
the journal/resume system.

### The Semaphore (createLimiter)

Located in `workflow.ts` (~line 1008). Controls concurrency across all
agent calls in a workflow:

```typescript
function createLimiter(limit: number) {
  let active = 0;
  const queue: Array<() => void> = [];
  const next = () => {
    active--;
    queue.shift()?.();
  };
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= limit) {
      await new Promise<void>((resolve) => queue.push(resolve));
    }
    active++;
    try {
      return await fn();
    } finally {
      next();
    }
  };
}
```

Default limit: `min(16, navigator.hardwareConcurrency - 2)`. The limiter
is shared across nested workflow calls via `SharedRuntime` so nesting
doesn't double the concurrency cap.

### parallel() and pipeline()

**parallel():**
- Takes an array of **thunks** (`() => agent(...)`), not promises
- Each thunk is wrapped in error handling — recoverable errors return null
- Non-recoverable errors (budget exhausted, agent limit reached) halt the run
- Returns results in input order

```typescript
const parallel = async (thunks) => {
  return Promise.all(
    thunks.map(async (thunk, index) => {
      try {
        return await thunk();
      } catch (error) {
        if (!wrapError(error).recoverable) throw error;
        log(`parallel[${index}] failed: ${error.message}`);
        return null;
      }
    }),
  );
};
```

**pipeline():**
- Takes an array of items and a series of stage functions
- Each stage receives `(previousValue, originalItem, index)`
- Items fan out across stages but each item flows through stages sequentially
- Useful for: fetch → parse → analyze → format workflows

### Model Routing

Three tiers configured via `/workflows-models`:

| Tier | Typical model | Use |
|---|---|---|
| `small` | DeepSeek Flash | Exploration, search, inventory |
| `medium` | MiniMax M3 | Balanced analysis |
| `big` | GLM-5.2 | Synthesis, judgment, decisions |

Agents tag their tier: `agent(prompt, { tier: "small" })`. The `tier` is
enforced at runtime — if no tier is set, it falls back to `medium`.
Explicit `opts.model` overrides tier routing entirely.

### Journal & Resume (run-persistence.ts)

Each agent call is journaled by its deterministic call index:
```
JournalEntry { index: number, hash: string, result: unknown }
```

On resume:
1. Replay journal entries for completed calls (hash match → skip)
2. Execute only new/changed calls
3. Merge results

**Cross-process leases** allow a workflow to survive Pi restart:
- `RunLease` with expiry
- A crashed run's lease expires → another process can pick it up
- Persisted to disk via JSON

### WorkflowManager (workflow-manager.ts)

Manages the full lifecycle of a workflow run:

```
createRun(script, args)
  → parse script, validate meta
  → create AbortController + ManagedRun
  → persist initial state
  → return runId

executeRun(runId)
  → acquire lease
  → load journal
  → runWorkflow(script, { resumeJournal })
  → on complete: persist result, release lease
  → on failure: persist error, release lease

pauseRun(runId)    → abort current execution, keep journal
resumeRun(runId)   → load journal, re-execute from last checkpoint
cancelRun(runId)   → abort, delete persisted state
```

### Agent Registry

`agent-registry.ts` manages named sub-agent definitions. Users define
agents in a config file with custom tools, model, and system prompts.
The `agentType` field in `agent()` calls routes to a registered definition.

---

## Key Design Decisions

**1. VM sandbox, not eval.** Scripts run in `vm.createContext()` with
determinism enforcement. Prevents infinite loops, crypto mining, or
filesystem access from user-written scripts.

**2. Thunks, not promises.** `parallel()` requires `() => agent(...)` not
`agent(...)`. This ensures the semaphore controls when each agent actually
starts, rather than all promises being created immediately.

**3. Journaled resume.** Every agent call is checkpointed by its
deterministic index. This is a lightweight alternative to full durable
execution (Temporal/Hatchet) — doesn't survive process death but survives
workflow cancellation and resumption within the same process.

**4. Nested concurrency sharing.** The `SharedRuntime` passes the same
limiter and counters to nested `workflow()` calls. Prevents nesting from
doubling the effective concurrency.

**5. Error classification.** `wrapError()` tags errors as recoverable or
non-recoverable. Budget exhaustion and agent limits halt the run. Sub-agent
failures return null. This is more nuanced than our `runConcurrent` which
treats all failures as fallback-worthy.

---

## Comparison to pi-loop

| Feature | pi-dynamic-workflows | pi-loop |
|---|---|---|
| Purpose | General multi-agent orchestration | Fixed 5-stage reasoning loop |
| Scripting | User-written JS workflow scripts | Fixed pipeline in code |
| Concurrency | Semaphore + parallel() + pipeline() | Semaphore (runConcurrent) |
| Default limit | min(16, hwConcurrency - 2) | 4 |
| Resume | Journaled (survives cancellation) | None |
| Model routing | Tier-based (small/medium/big) | Single model override |
| Error handling | Recoverable vs non-recoverable | All → fallback |
| Determinism | Enforced (no Date/Math.random) | Not enforced |
| UI | Live progress, TUI, editor | Tool output only |
| File size | 51 KB | ~15 KB |

pi-dynamic-workflows is a **general orchestration platform** where the model
writes ad-hoc workflows. pi-loop is a **single opinionated pattern**
(decompose → solve → critique → iterate → synthesize) with no scripting.
They solve different problems — pi-dynamic-workflows for codebase-wide
audits and refactors, pi-loop for focused reasoning tasks inside a session.
