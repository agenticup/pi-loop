import type {
	AgentToolResult,
	AgentToolUpdateCallback,
	ModelRegistry,
} from "@earendil-works/pi-coding-agent";
import { runLoop } from "./loop-engine.js";

type LoopToolInput = {
	prompt: string;
	maxDepth?: number;
	concurrency?: number;
	model?: string;
};

function textResult(text: string): AgentToolResult<undefined> {
	return {
		content: [{ type: "text" as const, text }],
		details: undefined,
	};
}

export async function executeLoopTool(
	params: LoopToolInput,
	signal: AbortSignal | undefined,
	onUpdate: AgentToolUpdateCallback<undefined> | undefined,
	ctx: { cwd: string; modelRegistry?: ModelRegistry },
): Promise<AgentToolResult<undefined>> {
	const promptPreview =
		params.prompt.length > 80
			? `${params.prompt.slice(0, 80)}...`
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
		onUpdate: (text) => {
			onUpdate?.(textResult(text));
		},
		onStreamDelta: (id, text) => {
			onUpdate?.(textResult(`[${id}] ${text}`));
		},
	});

	return textResult(result.result);
}
