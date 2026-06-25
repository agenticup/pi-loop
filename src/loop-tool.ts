import {
	defineTool,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { executeLoopTool } from "./loop-tool-execute.js";

const loopToolSchema = Type.Object({
	prompt: Type.String({
		description: "The task to recursively decompose and solve.",
	}),
	maxDepth: Type.Optional(
		Type.Integer({
			description:
				"Max recursion depth (1-3). Default 1. Each level decomposes sub-problems further. ~2x cost per level.",
			minimum: 1,
			maximum: 3,
			default: 1,
		}),
	),
	concurrency: Type.Optional(
		Type.Integer({
			description:
				"Max parallel sub-agents for solve and critique phases (1-8). Default 4. Higher = faster but more API calls in-flight.",
			minimum: 1,
			maximum: 8,
			default: 4,
		}),
	),
	model: Type.Optional(
		Type.String({
			description:
				"Optional model override for sub-agents (e.g. 'claude-sonnet-4'). Uses the session model by default.",
		}),
	),
});

export function createLoopTool(): ToolDefinition {
	return defineTool({
		name: "loop",
		label: "Loop",
		description: [
			"Run a recursive decompose-solve-critique-iterate-synthesize loop.",
			"The task is broken into sub-problems, each solved by a sub-agent,",
			"critiqued for completeness, iterated if gaps are found,",
			"then all results are synthesized into a final answer.",
			"Uses the gain-cost sweet spot from loop engineering:",
			"two loops refine, additional loops add overhead without value.",
		].join(" "),
		promptSnippet:
			"Run a recursive decomposition loop for complex reasoning, multi-step analysis, " +
			"architecture decisions, or any task that benefits from self-critique and iteration.",
		promptGuidelines: [
			"Use loop for tasks that benefit from recursive decomposition and self-critique: complex analysis, multi-step reasoning, architecture decisions, code review with iteration.",
			"Do NOT use loop for simple lookup, single-file edits, or tasks where a single agent response suffices.",
			"When the user explicitly says 'Use loop' or 'Run a loop', invoke the loop tool regardless of task complexity. The user is testing or deliberately using the tool.",
			"The loop tool runs a fixed pipeline: decompose into sub-problems → solve each (sub-agents) → critique each → iterate on failures → synthesize into final answer.",
			"maxDepth controls recursion. Depth 1 = one level of decomposition. Depth 2 = sub-problems themselves get decomposed. Default is 1.",
			"concurrency controls how many sub-agents run in parallel during solve and critique (1-8, default 4). Higher values reduce wall-clock time but increase API concurrency.",
			"The tool enforces the gain-cost sweet spot: critique gates iteration, and the loop terminates when all sub-problems pass or maxDepth is reached.",
		],
		parameters: loopToolSchema,
		execute(_toolCallId, params, signal, onUpdate, ctx) {
			return executeLoopTool(params, signal, onUpdate, ctx);
		},
	});
}
