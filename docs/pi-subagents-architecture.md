# pi-subagents — Architecture Reference

**Package:** `@tintinweb/pi-subagents` v0.11.0
**Downloads:** 27.9K/mo
**Source:** `~/.pi/agent/npm/node_modules/@tintinweb/pi-subagents/`

Claude Code-style autonomous sub-agents for Pi. Spawn specialized agents
with isolated sessions, configurable models, tools, system prompts, and
thinking levels. Foreground or background, with a live widget UI.

---

## What It Does

Registers three LLM-callable tools:

| Tool | Purpose |
|---|---|
| `Agent` | Spawn a sub-agent (foreground or background) |
| `get_subagent_result` | Poll a background agent's result by ID |
| `steer_subagent` | Inject a message into a running agent mid-flight |

Plus a `/agents` command for interactive management.

---

## Architecture

### File Overview

| File | Size | Role |
|---|---|---|
| `index.ts` | 93 KB | Tool registration, commands, UI — the entire public surface |
| `agent-manager.ts` | 22 KB | Lifecycle orchestration, concurrency queue, record tracking |
| `agent-runner.ts` | 31 KB | Session creation, prompt construction, execution loop |
| `agent-types.ts` | 6.6 KB | Agent type definitions, tool name resolution |
| `types.ts` | 6.5 KB | All TypeScript interfaces and types |
| `custom-agents.ts` | 6.3 KB | Custom agent loading from `.pi/agents/*.md` |
| `default-agents.ts` | 5.2 KB | Built-in agent presets |
| `schedule.ts` | 13.8 KB | Agent scheduling system |
| `settings.ts` | 10.4 KB | Configuration persistence |

### AgentManager — The Concurrency Queue

Located in `agent-manager.ts`. This is the core lifecycle controller.

```
spawn(prompt, options)
  │
  ├─ isBackground && running >= maxConcurrent?
  │     → queue.push({ id, args })
  │     → return id (status: "queued")
  │
  └─ else
        → startAgent(id, record, args)
        → return id (status: "running")
```

**Key state:**
- `agents: Map<string, AgentRecord>` — all agents, alive or dead
- `queue: { id, args }[]` — background agents waiting for a slot
- `runningBackground: number` — current running count
- `maxConcurrent: number` — configurable limit (default 4)

**Queue drain:** When a background agent completes or fails, `onAgentComplete`
fires which calls `drainQueue()`:
```
drainQueue()
  while queue.length > 0 && runningBackground < maxConcurrent:
    shift() next item → startAgent()
```

**Foreground bypass:** Agents spawned with `isBackground: false` skip the
queue entirely and start immediately. They block the parent turn anyway so
there's no point queueing them.

**Live reconfiguration:** `setMaxConcurrent(n)` updates the limit and
immediately drains the queue if the new limit allows more agents.

### AgentRecord — Per-Agent State

```typescript
interface AgentRecord {
  id: string;                    // UUID
  type: SubagentType;            // "explore" | "write" | "custom" | etc.
  description: string;           // Human-readable label
  status: "queued" | "running" | "completed" | "aborted" | "error";
  toolUses: number;
  startedAt: number;
  abortController: AbortController;
  lifetimeUsage: { input: number; output: number; cacheWrite: number };
  compactionCount: number;
}
```

### AgentRunner — Session Creation

Located in `agent-runner.ts`. Wraps Pi's `createAgentSession` to spawn
sub-agents, very similar to our `subAgent()` helper but more configurable:

```typescript
import { createAgentSession, SessionManager, SettingsManager, getAgentDir } from "@earendil-works/pi-coding-agent";

const { session } = await createAgentSession({
  cwd: options.cwd,
  agentDir: getAgentDir(),
  sessionManager: SessionManager.inMemory(cwd),
  settingsManager: SettingsManager.create(cwd, getAgentDir()),
});
```

**Additional features:**
- Inherits parent context when `inheritContext: true`
- Strips recursive tools (sub-agents don't get `Agent` tool — prevents infinite spawn)
- Builds custom prompt with agent type's system prompt + memory + skills
- Turn counting with soft warning (`turn >= maxTurns → steer`) and hard abort (`turn > maxTurns + 5 → cancel`)
- Token usage tracking per turn

### Tool Registration Pattern

All three tools (`Agent`, `get_subagent_result`, `steer_subagent`) are
registered in `index.ts` using the same `defineTool()` pattern as pi-loop.
The `Agent` tool is the primary one:

```typescript
pi.registerTool(defineTool({
  name: "Agent",
  label: "Agent",
  description: "Spawn an autonomous sub-agent...",
  parameters: Type.Object({
    prompt: Type.String(),
    type: Type.Optional(Type.String({ default: "explore" })),
    model: Type.Optional(Type.Any()),
    maxTurns: Type.Optional(Type.Number({ default: 25 })),
    isBackground: Type.Optional(Type.Boolean({ default: true })),
    isolated: Type.Optional(Type.Boolean({ default: true })),
  }),
  execute: async (toolCallId, params, signal, onUpdate, ctx) => {
    const id = agentManager.spawn(pi, ctx, params.type, params.prompt, { ... });
    return { content: [{ type: "text", text: `Agent ${id} started...` }], details: undefined };
  },
}));
```

### Custom Agent Types

Users define agents in `.pi/agents/<name>.md` with YAML frontmatter:

```yaml
---
description: "Security reviewer"
model: claude-sonnet-4
system_prompt: "You are a security expert. Review code for vulnerabilities."
tools: [read, grep, edit]
---
```

Loaded by `custom-agents.ts` via frontmatter parsing. Registered in
`agent-types.ts` and available as the `type` parameter in `Agent()` calls.

### Scheduling

`schedule.ts` + `schedule-store.ts` implement cron-based agent scheduling:
- Agents can fire at specific times or intervals
- Uses `croner` library for cron expression parsing
- Schedules stored as JSON in `.pi/subagent-schedules/`
- `bypassQueue: true` on scheduled spawns — a scheduled job shouldn't be
  deferred past its trigger window

---

## Key Design Decisions

**1. Queue, not batch.** Instead of processing agents in fixed batches, they
queue up and start as slots open. More responsive than batch or semaphore.

**2. Foreground bypasses queue.** If the parent agent needs a result inline
to continue, it shouldn't wait in line. The `isBackground` flag determines
priority.

**3. Own tool names are stripped.** Sub-agents don't inherit the `Agent`,
`get_subagent_result`, or `steer_subagent` tools — prevents infinite
recursive spawning.

**4. Turn limits with grace.** A soft warning at `maxTurns` tells the agent
to wrap up. A hard abort at `maxTurns + 5` kills it. Clean partial results
instead of truncated output.

**5. In-memory sessions, durable schedule.** Agent sessions are in-memory
(like pi-loop). But the scheduler persists to disk — scheduled jobs survive
restarts.

---

## Comparison to pi-loop

| Feature | pi-subagents | pi-loop |
|---|---|---|
| Purpose | General sub-agent spawning | Fixed 5-stage reasoning loop |
| Concurrency | Queue (foreground bypass) | Semaphore |
| Default limit | 4 | 4 |
| Agent types | Custom via .md files | Fixed (solve/critique/synthesize) |
| Turn limits | Yes (soft + hard) | No (single prompt per sub-agent) |
| UI | Live widget, FleetView, conversation viewer | Tool output only |
| Scheduling | cron-based | None |
| File size | 780 KB | ~15 KB |

pi-subagents is a **general-purpose sub-agent platform**. pi-loop is a
**specific reasoning pattern** built on the same `createAgentSession`
primitive. They complement each other — you could spawn a pi-loop run
inside a pi-subagents agent.
