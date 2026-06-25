# pi-loop Code Architecture — How It Works

A line-by-line walkthrough of how pi-loop is built, file by file.
Start here and follow the data flow down.

---

## The Big Picture

```
| Pi session → user types a task
  → Pi's model decides to call the "loop" tool
  → extensions/loop.ts (entry point)
    → src/loop-tool.ts (tool definition — name, schema, guidelines)
      → src/loop-tool-execute.ts (execute handler, formatting, wiring)
        → src/loop-engine.ts (the 7-stage engine)
        → subAgent() calls Pi's SDK to spawn child agents
```

Each file has ONE job. No circular dependencies. Data flows in one direction.

---

## 1. extensions/loop.ts — The Doorbell (14 lines)

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createLoopTool } from "../src/index.js";

export default function extension(pi: ExtensionAPI) {
  const loopTool = createLoopTool();
  pi.registerTool(loopTool);

  pi.on("session_start", () => {
    const active = pi.getActiveTools();
    if (!active.includes("loop")) {
      pi.setActiveTools([...active, "loop"]);
    }
  });
}
```

This is the **entry point**. Pi loads this file when your extension activates.

**What happens, step by step:**

1. Pi calls the `extension()` function, passing the `pi` object (the ExtensionAPI)
2. We call `createLoopTool()` which builds a ToolDefinition object
3. `pi.registerTool(loopTool)` tells Pi: "Hey, there's a new tool called `loop` that the LLM can call"
4. But the tool isn't active yet — it's registered but not in the active tools list
5. We hook `session_start`: every time a session starts, we check if `loop` is in the active tools. If not, we add it.

**Why the session_start hook?** Because Pi remembers active tools across sessions. If the user had the tool active, it stays active. But on first install, we need to auto-activate it. Without this, the user would need to manually enable it.

The import is `../src/index.js` not `../src/index.ts` — that's NodeNext module resolution. TypeScript compiles `.ts` to `.js`, so the import paths in source code use `.js` extensions.

---

## 2. src/index.ts — The Public Face (4 lines)

```typescript
export { createLoopTool } from "./loop-tool.js";
export type { LoopResult, SubProblemResult } from "./loop-engine.js";
export { runLoop } from "./loop-engine.js";
```

Pure re-exports. `extensions/loop.ts` only needs `createLoopTool`. The other exports exist so someone could import the library and use `runLoop()` directly in their own code.

Note: `LoopToolOptions` was removed — it wrapped a single `cwd?` field that no consumer ever passed. `SubProblem` (the internal phase-state type with 7 fields including `critique`, `needsIteration`, `depth`) is NOT exported. Consumers only get `SubProblemResult` (3 public fields: `id`, `description`, `solution?`).

---

## 3. Tool Schema — Inlined into loop-tool.ts (types.ts deleted)

The TypeBox schema and LoopToolInput type were previously in a standalone
`src/types.ts` (38 lines). Deleted — the schema is only used by `defineTool()`,
so a separate file added indirection without value.

```typescript
import { Type } from "typebox";

export const loopToolSchema = Type.Object({
  prompt: Type.String({
    description: "The task to recursively decompose and solve.",
  }),
  maxDepth: Type.Optional(Type.Integer({ minimum: 1, maximum: 3, default: 1 })),
  concurrency: Type.Optional(Type.Integer({ minimum: 1, maximum: 8, default: 4 })),
  model: Type.Optional(Type.String({
    description: "Optional model override for sub-agents.",
  })),
});

export type LoopToolInput = {
  prompt: string;
  maxDepth?: number;
  concurrency?: number;
  model?: string;
};
```

**TypeBox** generates a JSON Schema from the `Type.Object()` call. This schema is sent to the LLM so it knows what parameters the `loop` tool accepts.

**Why TypeBox, not hand-written JSON Schema?** Because Pi's tool system uses TypeBox internally. The `defineTool()` function expects a TypeBox schema for its `parameters` field. TypeBox also gives us TypeScript types for free — `LoopToolInput` is inferred from the schema structure.

**The parameters:**
- `prompt` — required, string. The task to solve.
- `maxDepth` — optional, 1-3, defaults to 1. How deep to decompose. Each level means sub-problems themselves get decomposed.
- `concurrency` — optional, 1-8, defaults to 4. How many sub-agents to run in parallel.
- `model` — optional. If set, all sub-agents use this model instead of the session's current model.

**Why defaults are in the schema:** The LLM sees `default: 4` and can decide to omit the parameter. Our code then uses `input.concurrency ?? 4` as a safety net. The schema's default is documentation for the LLM, the `??` in code is the runtime safeguard.

---

## 4. src/loop-tool.ts + src/loop-tool-execute.ts — The Tool Definition + Execution

Responsibility is split across two files:
- `loop-tool.ts` — builds the tool definition Pi registers
- `loop-tool-execute.ts` — formats I/O and calls `runLoop()`

Separation keeps each file focused: the tool definition stays declarative (name, schema, description), while the execution logic lives in its own module.

### The Helper Functions

```typescript
function textContent(text: string) {
  return { type: "text" as const, text };
}

function textResult(text: string): AgentToolResult<undefined> {
  return { content: [textContent(text)], details: undefined };
}
```

**AgentToolResult** is the format Pi expects tools to return. It's an object with:
- `content`: an array of content blocks (text or images)
- `details`: structured data (we don't use this, so `undefined`)

The `as const` on `type: "text"` tells TypeScript this is a literal `"text"` not a generic `string`. Required because the type definition expects the exact string `"text"`.

Without these helpers, every `execute` and `onUpdate` call would need to write out the full `{ content: [{ type: "text" as const, text: "..." }], details: undefined }` object.

### The Tool Definition

```typescript
export function createLoopTool(options: LoopToolOptions = {}): ToolDefinition {
  return defineTool({
    name: "loop",
    label: "Loop",
    description: "...",
    promptSnippet: "...",
    promptGuidelines: ["..."],
    parameters: loopToolSchema,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
```

`defineTool()` is Pi's function for creating tool definitions. It validates the schema at runtime and provides TypeScript types at compile time.

**The fields:**
- `name` — the tool name the LLM uses in function calls. Must match the schema.
- `label` — human-readable for Pi's UI.
- `description` — sent to the LLM as part of the tool definition. Tells the model when to use this tool.
- `promptSnippet` — a one-liner added to the "Available tools" section of Pi's system prompt.
- `promptGuidelines` — bullet points added to Pi's system prompt's "Guidelines" section. These teach the model *how* to use the tool properly.
- `parameters` — the TypeBox schema from types.ts.
- `execute` — the function called when the LLM invokes the tool.

### The Execute Function (src/loop-tool-execute.ts)

```typescript
export async function executeLoopTool(
  toolCallId: string,
  params: LoopToolInput,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<undefined> | undefined,
  ctx: { cwd: string; modelRegistry?: ModelRegistry },
): Promise<AgentToolResult<undefined>> {
  const promptPreview = params.prompt.length > 80
    ? params.prompt.slice(0, 80) + "..."
    : params.prompt;

  onUpdate?.(textResult(`Loop: decomposing "${promptPreview}"`));

  const result = await runLoop(params.prompt, {
    cwd: ctx.cwd,
    maxDepth: params.maxDepth ?? 1,
    concurrency: params.concurrency ?? 4,
    model: params.model,
    signal,
    modelRegistry: ctx.modelRegistry,
    agentTimeoutMs: 1_200_000,
    onUpdate: (text) => { onUpdate?.(textResult(text)); },
    onStreamDelta: (id, text) => { onUpdate?.(textResult(`[${id}] ${text}`)); },
  });
  return textResult(result.result);
}
```

**The parameters explained:**

| Parameter | Type | What it is |
|---|---|---|
| `toolCallId` | string | Unique ID for this tool invocation. Used for streaming updates. |
| `params` | object | The validated parameters (matching `LoopToolInput`) |
| `signal` | AbortSignal \| undefined | If the user cancels, this signal fires. We pass it down to sub-agents. |
| `onUpdate` | function \| undefined | Call this to send progress updates to the user while the tool runs |
| `ctx` | ExtensionContext | Pi's context object — gives us access to `cwd`, `modelRegistry`, etc. |

**The flow:**
1. Truncate the prompt for display
2. Send an update: "Loop is running, here's what it's working on"
3. Call `runLoop()` — the main engine. This blocks until the loop completes.
4. Return the result as a text block

**Why `LoopToolOptions` was removed:** It wrapped a single `cwd?` field that no consumer ever passed. The extension calls `createLoopTool()` with no arguments, so `ctx.cwd` always won. The dead option bag was removed — `createLoopTool()` now takes no arguments.

---

## 5. src/loop-engine.ts — The Engine (393 lines)

This is the heart. Let me walk through each piece in order.

### The Type Definitions

```typescript
export interface SubProblem {
  id: string;           // "auth-1", "db-schema-2"
  description: string;  // The sub-problem statement
  solution?: string;    // The model's answer
  critique?: string;    // The critic's evaluation
  needsIteration: boolean;  // Does this need refinement?
  iterationCount: number;   // How many times has it been refined?
  depth: number;            // Recursion depth level
}

export interface LoopResult {
  result: string;           // The final synthesized answer
  subProblems: SubProblem[]; // All sub-problems with their solutions
  iterations: number;        // Total iterations across all sub-problems
}

export interface LoopOptions {
  cwd: string;
  maxDepth: number;
  concurrency: number;
  model?: string;
  signal?: AbortSignal;
}
```

**SubProblem** is the core data model. Each item flows through all 5 phases, getting mutated at each step:
- Phase 2 sets `solution`
- Phase 3 sets `critique` and `needsIteration`
- Phase 4 increments `iterationCount` and updates `solution` and `critique`

This is a **mutable state pattern** — we create the object once and update its fields. Simpler than rebuilding objects at every phase, and the state array is small (usually 2-8 items).

### The Decomposition Schema

```typescript
const DECOMPOSITION_SCHEMA = {
  type: "object",
  properties: {
    subProblems: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string", description: "Short unique identifier, e.g. 'auth-1'" },
          description: { type: "string", description: "Self-contained problem statement" },
        },
        required: ["id", "description"],
      },
    },
  },
  required: ["subProblems"],
} as const;
```

This is a **plain JSON Schema object**, not a TypeBox schema. Why? Because this schema isn't passed to defineTool() — it's embedded in a prompt to the LLM. We tell the model "respond with JSON matching this schema" as plain text in the prompt.

The `as const` assertion makes TypeScript treat this as a readonly literal type, which helps with type inference when we access `parsed.subProblems`.

### The `subAgent()` Helper

```typescript
async function subAgent(prompt: string, options): Promise<string> {
  const agentDir = getAgentDir();
  const { session } = await createAgentSession({
    cwd: options.cwd,
    agentDir,
    sessionManager: SessionManager.inMemory(options.cwd),
    settingsManager: SettingsManager.create(options.cwd, agentDir),
  });
```

This is how we spawn a **child Pi session** from inside the extension.

`createAgentSession()` is Pi's SDK function for creating a throwaway agent session. It needs:
- `cwd` — working directory (filesystem context)
- `agentDir` — where Pi's agent config lives
- `sessionManager` — how the session stores its conversation. `SessionManager.inMemory()` means the session lives in RAM and is discarded when done. No files written to disk.
- `settingsManager` — Pi's settings. Creates a temporary settings object.

```typescript
  try {
    if (options.signal?.aborted) throw new Error("Sub-agent was aborted");

    if (options.signal) {
      const onAbort = () => void session.abort();
      options.signal.addEventListener("abort", onAbort, { once: true });
    }
```

**Cancellation handling.** If the user presses Escape while the loop tool is running, Pi sends an abort signal. We wire that signal to `session.abort()` so the sub-agent stops immediately instead of burning tokens on a cancelled request.

```typescript
    const labelLine = options.label ? `\n\n(Task: ${options.label})` : "";
    const modelLine = options.model ? `\n\n(Model: ${options.model})` : "";
    await session.prompt(prompt + labelLine + modelLine);
```

**Append metadata** to the prompt. The label helps the sub-agent understand its role. The model override tells it which model to use. Both are just appended as text — the LLM sees them as part of the instructions.

```typescript
    const messages = (session as any).messages ?? [];
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg?.role !== "assistant" || !Array.isArray(msg.content)) continue;
      const text = msg.content
        .filter((part: any) => part.type === "text")
        .map((part: any) => part.text)
        .join("");
      if (text.trim()) return text;
    }
    return "";
```

**Extract the assistant's final response.** We iterate backwards through messages to find the last assistant message with text content. This handles cases where the model might include tool calls or system messages in the conversation — we only want the final textual answer.

The `as any` casts are because Pi's internal message types aren't exported. It's a tradeoff: we lose type safety on the message structure, but the pattern is stable and well-tested (pi-dynamic-workflows uses the same approach).

```typescript
  } finally {
    session.dispose();
  }
```

**Always clean up.** The `finally` block ensures the session is disposed even if an error is thrown. Without this, every sub-agent call would leak memory.

### The `subAgentStructured()` Helper

```typescript
function extractJson(text: string): Record<string, unknown> {
  // Strip markdown code fences
  const clean = text.replace(/```(?:json)?\s*/g, '').trim();

  // Direct parse first (fast path when model obeys instructions)
  try { return JSON.parse(clean); } catch { /* fall through */ }

  // Brace-depth: find first top-level {...} — correct where greedy regex fails
  const start = clean.indexOf('{');
  if (start !== -1) {
    for (let depth = 0, i = start; i < clean.length; i++) {
      if (clean[i] === '{') depth++;
      else if (clean[i] === '}') {
        if (--depth === 0) {
          try { return JSON.parse(clean.slice(start, i + 1)); } catch { break; }
        }
      }
    }
  }

  // Named error instead of silent {} so caller knows it's broken
  const snippet = clean.length > 300 ? clean.slice(0, 300) + '...' : clean;
  throw new SyntaxError(`extractJson: no valid JSON found.\n  text: ${snippet}`);
}

async function subAgentStructured(prompt, schema, options) {
  const schemaStr = JSON.stringify(schema, null, 2);
  const fullPrompt = `${prompt}\n\nYou MUST respond with ONLY valid JSON matching this schema:
${schemaStr}\n\nDo not include any other text...`;

  const text = await subAgent(fullPrompt, options);
  try {
    return extractJson(text);
  } catch (e) {
    console.error(`[loop-engine] extractJson failed:`, (e as Error).message);
    return { subProblems: [] };
  }
}
```

**Three-tier parse pyramid, not greedy regex.** The old code used `/{[\s\S]*}/` which matched from the first `{` to the last `}` in the entire text, grabbing wrong content when multiple JSON blocks or nested braces existed. The catch block silently returned `{}`, making parse failures indistinguishable from "no sub-problems."

The fix: 1) strip markdown fences, try direct `JSON.parse`; 2) brace-depth counting finds the correct top-level object without greedy matching; 3) on total failure, throw `SyntaxError` with a text snippet. The caller catches the error, logs it, and returns the safe `{ subProblems: [] }` fallback.

### The Semaphore (`createLimiter`) and `runConcurrent()`

Controls how many sub-agents run simultaneously. Borrowed from
pi-dynamic-workflows' `createLimiter` pattern.

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

**How it works:**
- Maintains an `active` count of currently running tasks
- When `active >= limit`, new calls `await` a promise queued in the limiter
- When a task finishes, `next()` decrements `active` and resolves the
  next queued promise — the next task starts immediately
- No batching, no polling. Tasks start the instant a slot opens.

**Why a semaphore instead of batchPool:** The original implementation used
`batchPool` — split items into groups of N, wait for each group to finish
before starting the next. This had a "straggler problem": one slow task in
a batch delayed every subsequent task, even if other slots were idle.

The semaphore is more responsive: task 2 finishing early lets task 5 start
immediately, no need to wait for the rest of the batch. For homogeneous
workloads (same model, similar prompt length) the difference is marginal,
but for mixed workloads (one fast model, one slow) it matters.

### `runConcurrent()` — The public wrapper

```typescript
async function runConcurrent<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
  fallback: () => R,
): Promise<R[]> {
  const limiter = createLimiter(concurrency);
  const results = await Promise.allSettled(
    items.map((item, i) => limiter(() => fn(item, i))),
  );
  return results.map((r) => {
    if (r.status === "fulfilled") return r.value;
    return fallback();
  });
}
```

- Uses `Promise.allSettled` — one failure doesn't crash the batch
- Returns results in input order (critical for correct synthesis)
- Failed items call `fallback()` for a fresh value — no shared reference risk

### The `runLoop()` Function — Phase 1: Decompose

```typescript
const decomposePrompt = [
  `Decompose this task into independent sub-problems...`,
  `Task: ${prompt}`,
  `Each sub-problem must be independently solvable...`,
  `Flat decomposition at this level...`,
].join("\n");

const parsed = await subAgentStructured(decomposePrompt, DECOMPOSITION_SCHEMA, { ... });
const subProblems = parsed.subProblems ?? [];

if (subProblems.length === 0) {
  // Fallback: no decomposition happened, solve directly
  const solution = await subAgent(prompt, { label: "solve", ... });
  return { result: solution, subProblems: [], iterations: 0 };
}
```

**Why decompose first?** The article's key insight: complex tasks have independent sub-problems. Solving them separately is more reliable than asking one model to do everything at once.

**Why the fallback?** Sometimes the model doesn't decompose — it returns an empty array or fails to parse. Instead of crashing, we treat this as a signal that the task is simple enough to solve directly. This makes the tool robust to model failures.

**The decomposition prompt is carefully worded:**
- "independently solvable" — prevents the model from creating sub-problems that depend on each other
- "Flat decomposition" — prevents nested decomposition at this level (that's what `maxDepth` is for)
- The schema enforces `id` and `description` — no extra fields that would complicate parsing

### Phase 2: Solve (parallel)

```typescript
const solveFallback: SubProblem = {
  id: "failed",
  description: "Sub-agent failed to produce a solution",
  solution: "[Solution unavailable — sub-agent error]",
  ...
};

const solved = await runConcurrent(subProblems, concurrency, async (problem) => {
  const solution = await subAgent(`Solve this problem...\n\nProblem: ${problem.description}`, ...);
  return { id: problem.id, description: problem.description, solution, ... };
}, solveFallback);
```

**Each sub-problem gets its own Pi session.** They run independently and concurrently. The concurrency limit (default 4) prevents overwhelming the API.

**The fallback object** ensures that if one sub-agent fails, the loop continues. The synthesis phase will see `"[Solution unavailable]"` and either handle it gracefully or the human can re-run.

**Why not Promise.all?** If we used `Promise.all`, a single failed sub-agent would reject the entire batch. The fallback pattern is more robust.

### Phase 3: Critique (parallel)

```typescript
const critiqued = await runConcurrent(state, concurrency, async (problem) => {
  const critique = await subAgent(critiquePrompt, { label: `critique-${problem.id}`, ... });
  return { ...problem, critique, needsIteration: critique.trim().startsWith("ITERATE") };
}, critiqueFallback);
```

**The critique prompt creates an adversarial reviewer persona.** It asks the model to evaluate completeness, correctness, edge cases, and room for improvement. Then it tells the model to respond with either "PASS" or "ITERATE: <feedback>".

**The mechanical gate:** `critique.trim().startsWith("ITERATE")` — this is not an LLM judgement call. It's a string prefix check. If the critic's response starts with "ITERATE", the solution needs refinement. If it starts with anything else (including "PASS"), it's accepted.

**Why mechanical?** Because we want the gate to be predictable. If we asked the LLM "should this iterate?" it might say yes when the critic said PASS, or no when the critic said ITERATE. The prefix check removes ambiguity. The critic must use the exact prefix.

**Why parallel?** Each critique is independent — evaluating solution A doesn't affect the evaluation of solution B. Running them concurrently cuts latency from 4x to ~1x.

### Phase 4: Iterate (sequential)

```typescript
const MAX_ITERATIONS = 2;
for (const problem of state) {
  while (problem.needsIteration && iterationCount < MAX_ITERATIONS) {
    // Refine → re-critique → check again
  }
}
```

**Why sequential?** Each iteration depends on the previous one. You can't refine solution A's v2 until you've evaluated v1's critique.

**Why max 2 iterations?** The gain-cost sweet spot from the article. The first refinement catches most remaining issues. The second catches a few more. By the third, the model starts oscillating — it over-corrects, or introduces new errors. Two iterations is the empirically proven sweet spot.

**The iteration loop:**
1. Take the critique feedback
2. Sub-agent: "Refine your solution based on this feedback"
3. Sub-agent: "Re-evaluate this refined solution"
4. If the re-critique says "PASS", stop. If "ITERATE" and < 2 rounds, loop again.

### Phase 5: Synthesize

```typescript
const synthesisContext = state.map(p =>
  `### ${p.id}: ${p.description}\n\n${p.solution}\n\n${p.iterationCount > 0 ? "_(Refined...)_" : ""}`
).join("\n\n---\n\n");

const finalResult = await subAgent(synthesisPrompt, { label: "synthesize", ... });
return { result: finalResult, subProblems: state, iterations: totalIterations };
```

**The synthesis phase combines all individual solutions into one coherent answer.** It feeds the original task prompt plus all sub-problem solutions to a final sub-agent with instructions to "eliminate redundancy and ensure coherent flow."

**Why a separate synthesis call?** If we returned the raw array of sub-problem solutions, the user would get 4 separate answers they have to mentally combine. The synthesis step does that combination, producing a single flowing response.

**Why include the original task prompt?** The synthesis sub-agent needs context on what the final answer should look like. Without the original prompt, it would just concatenate the solutions without knowing the overall goal.

---

## Data Flow Summary

```
User's Pi session
  │
  ▼ Pi's model calls the "loop" tool
  │     params = { prompt: "Design auth", concurrency: 4 }
  │
  ▼ extensions/loop.ts gets control
  │     pi.registerTool → Pi maps tool name to our definition
  │
  ▼ src/loop-tool.ts: execute()
  │     onUpdate({ text: "Loop: decomposing..." })
  │     → calls runLoop({ prompt, cwd, maxDepth, concurrency, signal })
  │
  ▼ src/loop-engine.ts: runLoop()
  │
  ├─ Phase 1: Decompose
  │     subAgentStructured("Decompose this task...", schema)
  │     → Returns [{ id: "auth-1", description: "Choose provider" }, ...]
  │
  ├─ Phase 2: Solve (parallel via runConcurrent)
  │     subAgent("Solve: Choose provider")
  │     subAgent("Solve: Design schema")      ← runs concurrently
  │     subAgent("Solve: Build endpoints")
  │     subAgent("Solve: Session mgmt")
  │     → Returns SubProblem[] with solutions
  │
  ├─ Phase 3: Critique (parallel via runConcurrent)
  │     subAgent("Evaluate solution auth-1")
  │     subAgent("Evaluate solution db-schema")  ← runs concurrently
  │     → Sets needsIteration based on ITERATE prefix
  │
  ├─ Phase 4: Iterate (sequential)
  │     for each problem flagged as ITERATE:
  │       subAgent("Refine based on feedback")
  │       subAgent("Re-evaluate refined solution")
  │     → Updates solutions, max 2 rounds
  │
  ├─ Phase 5: Synthesize
  │     subAgent("Combine all solutions into one answer")
  │     → Returns final string
  │
  ▼ src/loop-tool.ts: execute()
  │     return textResult("Here's your auth design...")
  │
  ▼ User sees the result in Pi's UI
```

---

## Key Design Decisions

**1. No external dependencies.** The only imports are from Pi's own SDK (`@earendil-works/pi-coding-agent`) and TypeBox. No `rlms` Python package, no Ax, no LangChain. This means zero setup friction — `pi install` and it works.

**2. Extension, not slash command.** We register a _tool_, not a slash command. Tools are callable by the LLM automatically — the model decides when to use it. Slash commands require the user to type `/loop` manually. pi-dynamic-workflows uses the same pattern.

**3. Mechanical gate, not LLM gate.** The critique phase uses `String.startsWith("ITERATE")` to decide whether to iterate. This is more reliable than asking the model "is this good enough?" because the model will always say "yes" to avoid extra work.

**4. In-memory sessions.** `SessionManager.inMemory()` means sub-agent conversations are stored in RAM and discarded. This is the right choice for a single-turn tool — we don't need persistence across restarts. The tradeoff is no durability.

**5. Immutable pipeline, not mutating state.** Each phase produces a new `SubProblem[]` snapshot via object/array spread. Seven mutation sites were refactored to produce fresh values: Phase 2 creates solved arrays, Phase 3 reassigns via spread, Phase 4's while-loop reassigns `current` instead of mutating `problem`. No side effects between phases.

**6. Fallbacks, not crashes.** Every parallel batch has a fallback value. Every JSON parse has a catch. The tool is designed to degrade gracefully — partially failed runs still produce useful output.

**7. Accumulated log (appendLog).** Instead of sending separate `onUpdate` calls that overwrite each other, progress is accumulated in a `string[]` array (push on append, splice on overflow, join only on emit). Previously used `fullLog += line` then `fullLog.split("\n")` on every append — O(n²). Now O(1) per append. Bounded to 40 lines (AgentDiet-inspired).

**8. Solution summaries per sub-problem.** After each sub-agent solves, the first line of its solution (first 80 chars) is shown in the progress log. This lets you see what direction each sub-agent took without reading the full output.

**9. Atomic sub-problems (MAKER-style).** The decomposition prompt asks for 8-15 tiny sub-problems, each covering exactly ONE concern. Design tasks: solvable in 2-3 sentences. Review tasks: covers ONE file or ONE concern area. MAKER's key insight: error probability is LINEAR under extreme decomposition, EXPONENTIAL without it.

**10. Shared sub-agent services.** Previously each `subAgent()` call created full Pi services from scratch (AuthStorage, SettingsManager, ResourceLoader) — ~100-200ms per call. Now services are created once per `runLoop()` call and shared across all 20-40+ sub-agent sessions. ~10-20× I/O reduction.

**11. Brace-depth JSON parser, not greedy regex.** `extractJson()` previously used `/\{[\s\S]*\}/` which matched from first `{` to last `}` — grabbing wrong content with nested objects or multiple JSON blocks. Replaced with brace-depth counting parser that correctly handles nesting. Errors throw `SyntaxError` with source snippet instead of silently returning `{}`.

**12. Typed streaming, not `as any`.** The streaming event subscription used `(session as any).on?.("event", ...)` — hiding two real bugs: wrong method (should be `session.subscribe()`) and wrong event path (should be `event.assistantMessageEvent.delta`). Streaming was silently broken. Now uses typed `session.subscribe()` with correct event type narrowing.

**13. MAKER critic crash safety.** When the 2nd or 3rd critic in the adaptive voting escalation crashes, it previously produced `{ verdict: "PASS" }` — overriding a valid ITERATE from the first critic. Now failed critics vote `"UNKNOWN"` and ties fall back to the first critic's verdict instead of defaulting to PASS.

**14. Factory fallback, not value cloning.** `runConcurrent()` previously accepted a single `fallback: R` value and tried to shallow-clone it per failed item via `typeof` check and `as any` cast. Now accepts `fallback: () => R` — each failed item calls the factory for a fresh value. No shared reference risk.

**15. Public API boundary (SubProblemResult).** `SubProblem` (7 internal fields: `critique`, `needsIteration`, `iterationCount`, `depth`) is NOT exported. Consumers get `SubProblemResult` (3 fields: `id`, `description`, `solution?`). Internal phase state is hidden from the package's public surface.

**16. 20-minute timeout.** Each sub-agent has a 20-minute timeout (configurable via `agentTimeoutMs`). If a sub-agent hangs (network issue, provider timeout), it fails fast with a fallback instead of blocking the entire loop.
