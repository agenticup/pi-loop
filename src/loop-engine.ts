/**
 * The loop engine — implements the decompose → solve → critique → iterate → synthesize pattern.
 *
 * This is the core of the loop engineering article as code:
 * - Decompose: break tasks into independent sub-problems
 * - Solve: sub-agents produce solutions in parallel
 * - Critique: adversarial evaluation of each solution in parallel
 * - Iterate: refinement loop when critique finds gaps (max 2 iterations = the sweet spot)
 * - Synthesize: combine all results into a coherent final answer
 */

import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import {
	AuthStorage,
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";

// Internal phase state — each phase produces a new SubProblem[] snapshot via immutable spread
// ponytail: not re-exported via index.ts; consumers get SubProblemResult instead
export type SubProblem = {
	id: string;
	description: string;
	solution?: string;
	critique?: string;
	needsIteration: boolean;
	iterationCount: number;
	depth: number;
};

// Public result type — consumers only need to know what was solved, not how
export type SubProblemResult = {
	id: string;
	description: string;
	solution?: string;
};

export type LoopResult = {
	result: string;
	subProblems: SubProblemResult[];
	iterations: number;
};

export type LoopOptions = {
	cwd: string;
	maxDepth: number;
	concurrency: number;
	model?: string;
	signal?: AbortSignal;
	modelRegistry?: ModelRegistry;
	onUpdate?: (text: string) => void;
	/** Per-sub-agent timeout in milliseconds. Default: 300000 (5 min). */
	agentTimeoutMs?: number;
	/** Callback for streaming sub-agent output deltas. */
	onStreamDelta?: (id: string, text: string) => void;
};

/** Cache agentDir — same value for all sub-agent sessions. */
const AGENT_DIR = getAgentDir();

/**
 * Shared services set by runLoop() before any subAgent() call.
 * Avoids repeated file I/O (auth, settings, skills, extensions)
 * across the 20-40+ sub-agent sessions a loop run may create.
 */
let _loopServices: SharedServices | undefined;

/**
 * Services shared across all subAgent() calls in one loop run.
 * Created once in runLoop() to avoid repeated file I/O per session.
 */
type SharedServices = {
	authStorage: AuthStorage;
	settingsManager: SettingsManager;
	resourceLoader: DefaultResourceLoader;
	modelRegistry?: ModelRegistry;
};

/** Create shared I/O-heavy services once per loop run. */
async function createSharedServices(
	cwd: string,
	modelRegistry?: ModelRegistry,
): Promise<SharedServices> {
	const authStorage = AuthStorage.create();
	const settingsManager = SettingsManager.create(cwd, AGENT_DIR);
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir: AGENT_DIR,
		settingsManager,
	});
	await resourceLoader.reload();
	return { authStorage, settingsManager, resourceLoader, modelRegistry };
}

type SubAgentOptions = {
	cwd: string;
	label?: string;
	signal?: AbortSignal;
	model?: string;
	modelRegistry?: ModelRegistry;
	/** Pre-built runtime services. Falls back to _loopServices when omitted. */
	services?: SharedServices;
	timeoutMs?: number;
	onStreamDelta?: (text: string) => void;
};

const DECOMPOSITION_SCHEMA = {
	type: "object",
	properties: {
		subProblems: {
			type: "array",
			items: {
				type: "object",
				properties: {
					id: {
						type: "string",
						description: "Short unique identifier, e.g. 'auth-1'",
					},
					description: {
						type: "string",
						description: "Self-contained problem statement",
					},
				},
				required: ["id", "description"],
			},
		},
	},
	required: ["subProblems"],
} as const;

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Spawn a sub-agent via Pi's SDK, run a prompt, and return the last assistant text.
 */
async function subAgent(
	prompt: string,
	options: SubAgentOptions,
): Promise<string> {
	if (!_loopServices)
		throw new Error(
			"subAgent called outside runLoop — missing shared services",
		);
	const svc = options.services ?? _loopServices;
	const { session } = await createAgentSession({
		cwd: options.cwd,
		agentDir: AGENT_DIR,
		authStorage: svc.authStorage,
		settingsManager: svc.settingsManager,
		modelRegistry: svc.modelRegistry,
		resourceLoader: svc.resourceLoader,
		sessionManager: SessionManager.inMemory(options.cwd),
		noTools: "all",
	});

	let onAbort: (() => void) | undefined;
	let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

	try {
		if (options.signal?.aborted) throw new Error("Sub-agent was aborted");

		if (options.signal) {
			onAbort = () => {
				session.abort().catch(() => {});
			};
			options.signal.addEventListener("abort", onAbort, { once: true });
		}

		const labelLine = options.label ? `\n\n(Task: ${options.label})` : "";
		const modelLine = options.model ? `\n\n(Model: ${options.model})` : "";

		// Subscribe to streaming events before calling prompt (typed via AgentSession.subscribe)
		// ponytail: return value is the unsubscribe function; session.dispose() handles cleanup
		let streamedText = "";
		if (options.onStreamDelta) {
			session.subscribe((event) => {
				if (event.type === "message_update") {
					const ase = event.assistantMessageEvent;
					if (ase.type === "text_delta" || ase.type === "thinking_delta") {
						streamedText += ase.delta;
						options.onStreamDelta?.(streamedText);
					}
				}
			});
		}

		// Race prompt against timeout (callers always set agentTimeoutMs)
		const promptPromise = session.prompt(prompt + labelLine + modelLine);
		const ms = options.timeoutMs ?? 300000;
		const timeoutPromise = new Promise<never>((_, reject) => {
			timeoutHandle = setTimeout(() => {
				session.abort().catch(() => {});
				reject(new Error(`Sub-agent timed out after ${ms}ms`));
			}, ms);
		});
		await Promise.race([promptPromise, timeoutPromise]);

		// Extract last assistant text — SDK provides this as a public method
		return session.getLastAssistantText() ?? "";
	} finally {
		// Prevent the timeout callback from firing after the try block exits
		// (prompt rejection skips clearTimeout in the success path)
		clearTimeout(timeoutHandle);
		// Remove abort listener before dispose to prevent calling abort() on a disposed session
		if (options.signal && onAbort) {
			options.signal.removeEventListener("abort", onAbort);
		}
		session.dispose();
	}
}

/** Extract JSON from model response — handles code fences and nested braces. */
function extractJson(text: string): Record<string, unknown> {
	// Strip markdown code fences
	const clean = text.replace(/```(?:json)?\s*/g, "").trim();

	// Direct parse first (fast path when model obeys instructions)
	try {
		return JSON.parse(clean);
	} catch {
		/* fall through */
	}

	// Brace-depth: find first top-level {...} — correct where greedy regex fails
	const start = clean.indexOf("{");
	if (start !== -1) {
		for (let depth = 0, i = start; i < clean.length; i++) {
			if (clean[i] === "{") depth++;
			else if (clean[i] === "}") {
				if (--depth === 0) {
					try {
						return JSON.parse(clean.slice(start, i + 1));
					} catch {
						break;
					}
				}
			}
		}
	}

	// ponytail: named error instead of silent {} so caller knows it's broken
	const snippet = clean.length > 300 ? `${clean.slice(0, 300)}...` : clean;
	throw new SyntaxError(
		`extractJson: no valid JSON found.\n  text: ${snippet}`,
	);
}

/**
 * Run a structured sub-agent that returns JSON matching the given schema.
 */
async function subAgentStructured(
	prompt: string,
	schema: Record<string, unknown>,
	options: SubAgentOptions,
): Promise<Record<string, unknown>> {
	const schemaStr = JSON.stringify(schema, null, 2);
	const fullPrompt = `${prompt}

You MUST respond with ONLY valid JSON matching this schema:
${schemaStr}

Do not include any other text, markdown, or explanation. Only the JSON object.`;

	const text = await subAgent(fullPrompt, options);
	try {
		const parsed = extractJson(text);
		return parsed.subProblems ? parsed : { subProblems: [] };
	} catch (e) {
		console.error(
			`[loop-engine] extractJson failed for label="${options.label}":`,
			e instanceof Error ? e.message : String(e),
		);
		return { subProblems: [] };
	}
}

/**
 * Semaphore: limits concurrent execution of async functions.
 * When `active >= limit`, new calls queue and auto-start when a slot opens.
 */
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

/**
 * Run an async function over each item, with semaphore-based concurrency control.
 * Starts tasks as slots open — more responsive than batched execution.
 * Returns results in input order. Failed items call `fallback()` for their own value.
 */
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

// ─── Loop ───────────────────────────────────────────────────────────────────

export async function runLoop(
	prompt: string,
	options: LoopOptions,
): Promise<LoopResult> {
	const maxDepth = options.maxDepth;
	const concurrency = options.concurrency;
	let totalIterations = 0;

	// Create shared runtime services once — avoids auth/models/settings/skills file I/O
	// in every subAgent() call. Up to 30-40 sessions may be created in a single loop run.
	// ponytail: ModelRegistry passed in from ctx, not re-created here.
	_loopServices = await createSharedServices(
		options.cwd,
		options.modelRegistry,
	);
	// ponytail: sessions are fresh per call but share these services

	// Accumulated log so nothing disappears when onUpdate replaces
	// AgentDiet-inspired: bounded to MAX_LOG_LINES to prevent unbounded growth
	// ponytail: line-array instead of split/join on every append — O(1) per call
	const MAX_LOG_LINES = 40;
	const logLines: string[] = [];
	const appendLog = (line: string) => {
		logLines.push(...line.split("\n"));
		if (logLines.length > MAX_LOG_LINES) {
			logLines.splice(0, logLines.length - MAX_LOG_LINES + 1);
		}
		options.onUpdate?.(logLines.join("\n"));
	};

	// === PHASE 1: DECOMPOSE ===
	appendLog("Phase 1/5: Decomposing task into sub-problems...");
	const decomposePrompt = [
		`Decompose this task into many tiny, focused sub-problems. Each sub-problem should cover ONE specific concern.`,
		``,
		`Task: ${prompt}`,
		``,
		[
			`Rules:`,
			`- Each sub-problem must cover exactly ONE concern — no combining multiple topics`,
			`- Each must be independently solvable (no cross-dependencies)`,
			`- For design/architecture: solvable in 2-3 sentences`,
			`- For review/analysis: covers ONE file or ONE concern area`,
			`- No overlapping features between sub-problems`,
			`- Aim for 8-15 sub-problems — finer granularity means fewer mistakes`,
			`- Flat decomposition at this level — no nested sub-problems`,
		].join("\n"),
	].join("\n");

	const parsed = await subAgentStructured(
		decomposePrompt,
		DECOMPOSITION_SCHEMA,
		{
			cwd: options.cwd,
			label: "decompose",
			signal: options.signal,
			model: options.model,
			modelRegistry: options.modelRegistry,
			timeoutMs: options.agentTimeoutMs ?? 300000,
		},
	);

	const raw = parsed.subProblems;
	let subProblems: SubProblem[] = Array.isArray(raw)
		? (raw as Array<{ id: string; description: string }>).map((p) => ({
				id: p.id,
				description: p.description,
				solution: undefined,
				critique: undefined,
				needsIteration: false,
				iterationCount: 0,
				depth: 1,
			}))
		: [];

	// Show decomposition to user
	if (subProblems.length > 0) {
		const list = subProblems
			.map((p) => `  → ${p.id}: ${p.description}`)
			.join("\n\n");
		appendLog(
			`Phase 1/5: Decomposed into ${subProblems.length} sub-problems\n${list}`,
		);
	}

	if (subProblems.length === 0) {
		// Fallback: no decomposition, solve directly
		const solution = await subAgent(prompt, {
			cwd: options.cwd,
			label: "solve",
			signal: options.signal,
			model: options.model,
			modelRegistry: options.modelRegistry,
			timeoutMs: options.agentTimeoutMs ?? 300000,
		});
		return { result: solution, subProblems: [], iterations: 0 };
	}

	// Phase 1 summary
	const themeSummary = subProblems.map((p) => p.id).join(", ");
	appendLog(
		`Phase 1 done: Task broken into ${subProblems.length} sub-problems — ${themeSummary}`,
	);
	appendLog("");

	// DRIP backward pass: check for missing preconditions (strict mode)
	appendLog(`Phase 1.5/5: Checking for critical missing preconditions...`);
	try {
		const dripResult = await subAgentStructured(
			`You are reviewing a task decomposition for completeness. Only flag preconditions that would BLOCK the entire task if missing. Be strict.

Original task: ${prompt}

Sub-problems identified:
${subProblems.map((p) => `  - ${p.id}: ${p.description}`).join("\n")}

For each sub-problem, ask: "If this precondition is missing, does the entire task fail or produce a wrong result?"
Only flag preconditions that meet ALL of:
1. The sub-problem CANNOT be solved without it (not "harder" but impossible)
2. It is NOT common knowledge for the target audience
3. It is NOT already implied by another sub-problem`,
			{
				type: "object",
				properties: {
					missing: {
						type: "array",
						items: {
							type: "object",
							properties: {
								id: {
									type: "string",
									description: "Short unique identifier starting with pre-",
								},
								description: {
									type: "string",
									description: "Why this precondition is critical",
								},
							},
							required: ["id", "description"],
						},
					},
				},
				required: ["missing"],
			},
			{
				cwd: options.cwd,
				label: "drip-backward",
				signal: options.signal,
				model: options.model,
				modelRegistry: options.modelRegistry,
				timeoutMs: options.agentTimeoutMs ?? 300000,
			},
		);

		const missing = Array.isArray(dripResult?.missing)
			? dripResult.missing
			: [];
		if (missing.length > 0) {
			const preconditions: SubProblem[] = missing.map(
				(m: Record<string, unknown>) => ({
					id: String(m.id ?? "") || `pre-${subProblems.length + 1}`,
					description: String(m.description ?? "") || "Missing precondition",
					solution: undefined,
					critique: undefined,
					needsIteration: false,
					iterationCount: 0,
					depth: 1,
				}),
			);
			subProblems = [...subProblems, ...preconditions];
			appendLog(
				`  DRIP found ${missing.length} missing precondition(s) — added to sub-problems`,
			);
		} else {
			appendLog("  DRIP: no missing preconditions found ✓");
		}
	} catch (e) {
		appendLog(
			`  DRIP: error — ${e instanceof Error ? e.message : String(e)}, continuing without it`,
		);
	}
	appendLog("");

	// === PHASE 2: SOLVE each sub-problem (parallel) ===
	const total = subProblems.length;
	let solvedCount = 0;
	appendLog(`Phase 2/5: Solving ${total} sub-problems...`);
	const solveFallback = (): SubProblem => ({
		id: "failed",
		description: "Sub-agent failed to produce a solution",
		solution: "[Solution unavailable — sub-agent error]",
		critique: undefined,
		needsIteration: false,
		iterationCount: 0,
		depth: 1,
	});

	const solved = await runConcurrent(
		subProblems,
		concurrency,
		async (problem) => {
			const solution = await subAgent(
				`Solve this problem thoroughly. Be specific and complete.

Problem: ${problem.description}`,
				{
					cwd: options.cwd,
					label: `solve-${problem.id}`,
					signal: options.signal,
					model: options.model,
					modelRegistry: options.modelRegistry,
					timeoutMs: options.agentTimeoutMs ?? 300000,
					onStreamDelta: (text) => options.onStreamDelta?.(problem.id, text),
				},
			);

			solvedCount++;
			const firstLine = solution.split("\n")[0];
			const solutionSummary = firstLine.slice(0, 200);
			const suffix = firstLine.length > 200 ? "..." : "";
			appendLog(
				`  ✓ ${problem.id} — ${solutionSummary}${suffix} (${solvedCount}/${total})`,
			);

			return {
				id: problem.id,
				description: problem.description,
				solution,
				critique: undefined,
				needsIteration: false,
				iterationCount: 0,
				depth: 1,
			} as SubProblem;
		},
		solveFallback,
	);

	subProblems = solved;

	// Phase 2 summary
	appendLog(`Phase 2 done: All ${subProblems.length} sub-problems solved`);
	appendLog("");

	// === PHASE 3: CRITIQUE each solution (parallel) ===
	const critiqueTotal = subProblems.length;
	let critiqueCount = 0;
	appendLog(`Phase 3/5: Critiquing ${critiqueTotal} solutions...`);
	const critiqueFallback = (): SubProblem => ({
		id: "failed",
		description: "Critique failed",
		solution: undefined,
		critique: "[Critique unavailable — sub-agent error]",
		needsIteration: false,
		iterationCount: 0,
		depth: 1,
	});

	const critiqued = await runConcurrent(
		subProblems,
		concurrency,
		async (problem) => {
			// Skip critique if sub-agent failed — no real solution to evaluate
			if (problem.solution?.startsWith("[Solution unavailable")) {
				critiqueCount++;
				appendLog(
					`  ✗ ${problem.id} — sub-agent failed, skipping critique (${critiqueCount}/${critiqueTotal})`,
				);
				return {
					...problem,
					critique: "[Skipped — no solution produced]",
					needsIteration: false,
				} as SubProblem;
			}

			const critiquePrompt = `You are an adversarial reviewer. Critically evaluate this solution.

Problem: ${problem.description}

Solution: ${problem.solution}

Evaluate:
1. Is the solution complete? Does it fully address the problem?
2. Is it correct? Any errors or misconceptions?
3. Are there edge cases or missing details?
4. Could it be improved?

If the solution is complete and correct, respond with ONLY: PASS

If the solution has issues, respond with: ITERATE: <specific feedback on what needs improvement>

Be strict. If anything is missing or wrong, flag it.`;

			// MAKER-style: adaptive voting — 1 critic first, escalate to 3 on ITERATE
			const firstCritic = await subAgent(critiquePrompt, {
				cwd: options.cwd,
				label: `critique-${problem.id}-v1`,
				signal: options.signal,
				model: options.model,
				modelRegistry: options.modelRegistry,
				timeoutMs: options.agentTimeoutMs ?? 300000,
			});
			const firstVerdict = firstCritic.trim().startsWith("ITERATE")
				? "ITERATE"
				: "PASS";

			let chosenCritique = firstCritic;
			let majorityVerdict = firstVerdict;

			// Only escalate to 3-critic majority vote if the first critic flagged it
			if (firstVerdict === "ITERATE") {
				const moreCritics = await Promise.allSettled(
					[2, 3].map((i) =>
						subAgent(critiquePrompt, {
							cwd: options.cwd,
							label: `critique-${problem.id}-v${i}`,
							signal: options.signal,
							model: options.model,
							modelRegistry: options.modelRegistry,
							timeoutMs: options.agentTimeoutMs ?? 300000,
						}),
					),
				);

				// Single pass: extract verdict + text from each critic result
				// ponytail: crashed critics vote UNKNOWN so they don't sway the majority
				type CriticResult = {
					verdict: "ITERATE" | "PASS" | "UNKNOWN";
					text: string;
				};
				const results: CriticResult[] = [
					{
						verdict: "ITERATE",
						text: firstCritic,
					},
					...moreCritics.map((r) => ({
						verdict:
							r.status === "fulfilled" && r.value.trim().startsWith("ITERATE")
								? ("ITERATE" as const)
								: r.status === "fulfilled"
									? ("PASS" as const)
									: ("UNKNOWN" as const),
						text: r.status === "fulfilled" ? r.value : "[Critic crashed]",
					})),
				];

				const iterateVotes = results.filter(
					(r) => r.verdict === "ITERATE",
				).length;
				const passVotes = results.filter((r) => r.verdict === "PASS").length;
				// Exclude UNKNOWN from majority; tie or all-crash falls back to first critic
				majorityVerdict =
					iterateVotes > passVotes
						? "ITERATE"
						: passVotes > iterateVotes
							? "PASS"
							: firstVerdict;
				chosenCritique =
					results.find((r) =>
						majorityVerdict === "ITERATE"
							? r.verdict === "ITERATE"
							: r.verdict === "PASS",
					)?.text || firstCritic;
			}

			critiqueCount++;
			const verdictIcon =
				majorityVerdict === "ITERATE" ? "✗ ITERATE" : "✓ PASS";
			const feedback =
				majorityVerdict === "ITERATE"
					? chosenCritique.replace(/^ITERATE:\s*/i, "").slice(0, 80) || ""
					: "";
			const status = feedback ? `${verdictIcon}: ${feedback}...` : verdictIcon;
			appendLog(
				`  ${problem.id} — ${status} (${critiqueCount}/${critiqueTotal})`,
			);

			return {
				...problem,
				critique: chosenCritique,
				needsIteration: majorityVerdict === "ITERATE",
			} as SubProblem;
		},
		critiqueFallback,
	);

	subProblems = critiqued;

	// Phase 3 summary
	const passed = subProblems.filter((p) => !p.needsIteration).length;
	const flagged = subProblems.filter((p) => p.needsIteration);
	const flaggedNames = flagged.map((p) => p.id).join(", ");
	if (flagged.length > 0) {
		appendLog(
			`Phase 3 done: ${passed} passed, ${flagged.length} flagged for iteration — ${flaggedNames}`,
		);
	} else {
		appendLog(`Phase 3 done: All ${subProblems.length} passed critique ✓`);
	}
	appendLog("");

	// === PHASE 4: ITERATE / ADaPT deeper decompose on flagged problems ===
	appendLog(
		`Phase 4/5: Checking ${subProblems.length} sub-problems for refinement...`,
	);
	const MAX_ITERATIONS = 2;

	const refinedProblems: SubProblem[] = [];
	for (const problem of subProblems) {
		let current: SubProblem = { ...problem };
		while (current.needsIteration && current.iterationCount < MAX_ITERATIONS) {
			totalIterations++;
			const iterationCount = current.iterationCount + 1;

			if (current.depth < maxDepth) {
				// ADaPT-style: decompose this problem deeper into sub-sub-problems
				appendLog(
					`  ⟳ ${current.id}: decomposing deeper (depth ${current.depth} → ${current.depth + 1})...`,
				);

				const subDecomposePrompt = [
					`The following sub-problem needs refinement. Break it into smaller independent parts.`,
					``,
					`Original problem: ${current.description}`,
					``,
					`Critique feedback: ${current.critique}`,
					``,
					`Current solution: ${current.solution ? current.solution.slice(0, 200) : "none"}`,
					``,
					`Each part must cover ONE specific concern. Aim for 3-5 smaller parts.`,
				].join("\n");

				const subParsed = await subAgentStructured(
					subDecomposePrompt,
					DECOMPOSITION_SCHEMA,
					{
						cwd: options.cwd,
						label: `decompose-${current.id}`,
						signal: options.signal,
						model: options.model,
						modelRegistry: options.modelRegistry,
						timeoutMs: options.agentTimeoutMs ?? 300000,
					},
				);

				const subRaw = subParsed.subProblems;
				const subItems = Array.isArray(subRaw)
					? (subRaw as Array<{ id: string; description: string }>)
					: [];

				if (subItems.length > 0) {
					// Solve sub-sub-problems in parallel
					const subSolved = await runConcurrent(
						subItems,
						concurrency,
						async (sub) => {
							const subSolution = await subAgent(
								`Solve this sub-problem as part of: ${current.description}\n\nSub-problem: ${sub.description}`,
								{
									cwd: options.cwd,
									label: `${current.id}-${sub.id}`,
									signal: options.signal,
									model: options.model,
									modelRegistry: options.modelRegistry,
									timeoutMs: options.agentTimeoutMs ?? 300000,
								},
							);
							return { ...sub, solution: subSolution };
						},
						() => ({
							id: "failed",
							description: "Failed",
							solution: "[Sub-solution unavailable]",
						}),
					);

					// Synthesize sub-solutions into refined solution for this problem
					const subContext = subSolved
						.map(
							(s: Record<string, unknown>) =>
								`### ${s.id ?? ""}: ${s.description ?? ""}\n\n${s.solution ?? "[no solution]"}`,
						)
						.join("\n\n---\n\n");

					const subSynthesis = await subAgent(
						`Synthesize the following partial solutions into a single refined solution for the original problem.\n\nOriginal problem: ${current.description}\n\nCritique to address: ${current.critique}\n\nSub-solutions:\n${subContext}`,
						{
							cwd: options.cwd,
							label: `synthesize-${current.id}-v${iterationCount}`,
							signal: options.signal,
							model: options.model,
							modelRegistry: options.modelRegistry,
							timeoutMs: options.agentTimeoutMs ?? 300000,
						},
					);

					current = {
						...current,
						solution: subSynthesis,
						iterationCount,
						depth: current.depth + 1,
					};
					appendLog(
						`  ⟳ ${current.id}: recomposed from ${subItems.length} deeper parts (v${iterationCount})`,
					);
				} else {
					// Fallback to refine if decomposition produced nothing
					appendLog(
						`  ⟳ ${current.id}: deep decompose returned nothing, refining instead...`,
					);
					const refinedText = await subAgent(
						`Refine your solution based on this feedback.\n\nProblem: ${current.description}\n\nPrevious solution: ${current.solution}\n\nFeedback: ${current.critique}\n\nProvide an improved solution.`,
						{
							cwd: options.cwd,
							label: `refine-${current.id}-v${iterationCount}`,
							signal: options.signal,
							model: options.model,
							modelRegistry: options.modelRegistry,
							timeoutMs: options.agentTimeoutMs ?? 300000,
						},
					);
					current = {
						...current,
						solution: refinedText,
						iterationCount,
					};
					const firstLine = refinedText.split("\n")[0];
					const refinedSummary = firstLine.slice(0, 200);
					const suffix = firstLine.length > 200 ? "..." : "";
					appendLog(
						`  ⟳ ${current.id} — ${refinedSummary}${suffix} (v${iterationCount})`,
					);
				}
			} else {
				// At max depth — refine directly
				const refinedText = await subAgent(
					`Refine your solution based on this feedback.\n\nProblem: ${current.description}\n\nPrevious solution: ${current.solution}\n\nFeedback: ${current.critique}\n\nProvide an improved solution.`,
					{
						cwd: options.cwd,
						label: `refine-${current.id}-v${iterationCount}`,
						signal: options.signal,
						model: options.model,
						modelRegistry: options.modelRegistry,
						timeoutMs: options.agentTimeoutMs ?? 300000,
					},
				);
				current = {
					...current,
					solution: refinedText,
					iterationCount,
				};
				const firstLine = refinedText.split("\n")[0];
				const refinedSummary = firstLine.slice(0, 200);
				const suffix = firstLine.length > 200 ? "..." : "";
				appendLog(
					`  ⟳ ${current.id} — ${refinedSummary}${suffix} (v${iterationCount})`,
				);
			}

			// Re-critique the refined/synthesized solution
			const reCritique = await subAgent(
				`Re-evaluate this refined solution.\n\nProblem: ${current.description}\n\nRefined solution: ${current.solution}\n\nRespond with only PASS or ITERATE: <feedback>`,
				{
					cwd: options.cwd,
					label: `recritique-${current.id}-v${iterationCount}`,
					signal: options.signal,
					model: options.model,
					modelRegistry: options.modelRegistry,
					timeoutMs: options.agentTimeoutMs ?? 300000,
				},
			);

			current = {
				...current,
				critique: reCritique,
				needsIteration: reCritique.trim().startsWith("ITERATE"),
			};
		}
		refinedProblems.push(current);
	}
	subProblems = refinedProblems;

	// Phase 4 summary
	const refinedCount = subProblems.filter((p) => p.iterationCount > 0);
	if (refinedCount.length > 0) {
		const refinedSummary = refinedCount
			.map((p) => `${p.id} (${p.iterationCount}x)`)
			.join(", ");
		appendLog(
			`Phase 4 done: ${refinedCount.length} sub-problems refined — ${refinedSummary}`,
		);
	} else {
		appendLog("Phase 4 done: No iteration needed ✓");
	}
	appendLog("");

	// === PHASE 5: SYNTHESIZE ===
	appendLog("Phase 5/5: Synthesizing final answer...");
	const synthesisContext = subProblems
		.map(
			(p) =>
				`### ${p.id}: ${p.description}\n\n${p.solution}\n\n${
					p.iterationCount > 0
						? `_(Refined after ${p.iterationCount} critique iteration(s))_`
						: ""
				}`,
		)
		.join("\n\n---\n\n");

	// Build critic verdict context for synthesis
	const verdictContext = subProblems
		.filter((p) => p.critique)
		.map((p) => {
			const verdict = p.critique?.trim().startsWith("ITERATE")
				? "⚠️ WEAKNESS"
				: "✓ PASS";
			const detail =
				p.critique?.replace(/^(PASS|ITERATE):?\s*/i, "").slice(0, 150) || "";
			return `  ${p.id}: ${verdict} — ${detail}`;
		})
		.join("\n");

	const synthesisPrompt = [
		`Synthesize the following partial solutions into a single, coherent, complete answer.`,
		``,
		`Original task: ${prompt}`,
		``,
		`## Solutions`,
		``,
		synthesisContext,
		``,
		`## Critic Verdicts`,
		``,
		verdictContext || "  (no critic feedback available)",
		``,
		`## Instructions`,
		``,
		`1. **Combine** — merge all solutions into one flowing answer`,
		`2. **Check for conflicts** — if any two solutions contradict each other`,
		`   (e.g., one says "use Redis" and another says "use in-memory"),`,
		`   flag the conflict and pick the better approach with reasoning`,
		`3. **Weight by critic** — solutions marked as WEAKNESS had issues identified.`,
		`   Where they conflict with PASS solutions, prefer the PASS solution.`,
		`   Where they add unique value not covered elsewhere, include them.`,
		`4. **Eliminate redundancy** — don't repeat the same information`,
		`5. **Output only the final answer** — no labels, no problem statements`,
	].join("\n");

	const finalResult = await subAgent(synthesisPrompt, {
		cwd: options.cwd,
		label: "synthesize",
		signal: options.signal,
		model: options.model,
		modelRegistry: options.modelRegistry,
		timeoutMs: options.agentTimeoutMs ?? 300000,
	});

	// Build execution log
	const subProblemList = subProblems.map(
		(p, i) => `  ${i + 1}. ${p.id}: ${p.description}`,
	);
	const phase1 = `### Phase 1: Decompose\nBroken into ${subProblems.length} sub-problems:\n${subProblemList.join("\n")}`;

	const phase2 = `### Phase 2: Solve (parallel, concurrency=${concurrency})\nAll ${subProblems.length} sub-problems solved.`;

	const critiqueLines = subProblems.map((p) => {
		const verdict = p.critique?.trim().startsWith("ITERATE") ? "✗" : "✓";
		const snippet = p.critique
			? p.critique.slice(0, 100).replace(/\n/g, " ")
			: "";
		return `  ${verdict} ${p.id} — ${snippet}${snippet.length >= 100 ? "..." : ""}`;
	});
	const phase3 = `### Phase 3: Critique\n${critiqueLines.join("\n")}`;

	const iterated = subProblems.filter((p) => p.iterationCount > 0);
	const phase4 =
		iterated.length > 0
			? `### Phase 4: Iterate\n${iterated.map((p) => `  ${p.id} → refined (${p.iterationCount}x): ${p.critique?.replace(/^ITERATE:\s*/i, "").slice(0, 120)}`).join("\n")}`
			: "### Phase 4: Iterate\n  No sub-problems needed iteration ✓";

	const phase5 = `### Phase 5: Synthesize\nFinal answer compiled from ${subProblems.length} solutions, ${totalIterations} total iterations.`;

	const log = `\n\n---\n## Execution Summary\n\n${phase1}\n\n${phase2}\n\n${phase3}\n\n${phase4}\n\n${phase5}`;

	return {
		result: finalResult + log,
		// ponytail: strip internal phase fields — consumers get id, description, solution only
		subProblems: subProblems.map(({ id, description, solution }) => ({
			id,
			description,
			solution,
		})),
		iterations: totalIterations,
	};
}

// ponytail: cleanup is automatic — _loopServices is overwritten on the next runLoop() call
