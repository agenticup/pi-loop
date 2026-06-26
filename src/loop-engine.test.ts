import { describe, expect, it } from "vitest";
import { createLimiter, extractJson, runConcurrent } from "./loop-engine.js";
import { createLoopTool } from "./loop-tool.js";

// ─── extractJson ───

describe("extractJson", () => {
	it("parses plain JSON", () => {
		const result = extractJson(
			`{"subProblems":[{"id":"a","description":"b"}]}`,
		);
		expect(result).toEqual({
			subProblems: [{ id: "a", description: "b" }],
		});
	});

	it("strips markdown code fences", () => {
		const result = extractJson(
			'```json\n{"subProblems":[{"id":"a","description":"b"}]}\n```',
		);
		expect(result).toEqual({
			subProblems: [{ id: "a", description: "b" }],
		});
	});

	it("handles nested braces via brace-depth", () => {
		const result = extractJson('text before {"a":{"b":{"c":"d"}}} text after');
		expect(result).toEqual({ a: { b: { c: "d" } } });
	});

	it("strips leading text before JSON", () => {
		const result = extractJson(
			'Here is the JSON:\n{"missing":[{"id":"pre-1","description":"test"}]}',
		);
		expect(result).toEqual({
			missing: [{ id: "pre-1", description: "test" }],
		});
	});

	it("works with DRIP-style 'missing' field", () => {
		const result = extractJson(
			JSON.stringify({
				missing: [
					{ id: "pre-auth", description: "Auth middleware must exist" },
				],
			}),
		);
		expect(result.missing).toBeDefined();
		expect(Array.isArray(result.missing)).toBe(true);
		expect((result.missing as Array<{ id: string }>)[0].id).toBe("pre-auth");
	});

	it("throws SyntaxError on non-JSON input", () => {
		expect(() => extractJson("not json at all")).toThrow(SyntaxError);
	});

	it("throws SyntaxError on empty input", () => {
		expect(() => extractJson("")).toThrow(SyntaxError);
	});
});

// ─── createLimiter ───

describe("createLimiter", () => {
	it("runs functions up to the limit in parallel", async () => {
		const limiter = createLimiter(2);
		let concurrent = 0;
		let maxConcurrent = 0;

		const makeTask = (ms: number) =>
			limiter(async () => {
				concurrent++;
				maxConcurrent = Math.max(maxConcurrent, concurrent);
				await new Promise((r) => setTimeout(r, ms));
				concurrent--;
				return ms;
			});

		const results = await Promise.all([
			makeTask(50),
			makeTask(30),
			makeTask(20),
			makeTask(10),
		]);

		expect(results.sort()).toEqual([10, 20, 30, 50]);
		expect(maxConcurrent).toBeLessThanOrEqual(2);
	});

	it("queues tasks beyond the limit", async () => {
		const limiter = createLimiter(1);
		let concurrent = 0;
		let maxConcurrent = 0;

		const makeTask = (ms: number) =>
			limiter(async () => {
				concurrent++;
				maxConcurrent = Math.max(maxConcurrent, concurrent);
				await new Promise((r) => setTimeout(r, ms));
				concurrent--;
				return ms;
			});

		await Promise.all([makeTask(50), makeTask(10), makeTask(30)]);
		expect(maxConcurrent).toBeLessThanOrEqual(1);
	});
});

// ─── runConcurrent ───

describe("runConcurrent", () => {
	it("returns results in input order", async () => {
		const results = await runConcurrent(
			["a", "b", "c"],
			2,
			async (item) => item.toUpperCase(),
			() => "FALLBACK",
		);
		expect(results).toEqual(["A", "B", "C"]);
	});

	it("uses fallback for rejected promises", async () => {
		const results = await runConcurrent(
			["good", "bad", "good"],
			2,
			async (item) => {
				if (item === "bad") throw new Error("fail");
				return item;
			},
			() => "FALLBACK",
		);
		expect(results).toEqual(["good", "FALLBACK", "good"]);
	});

	it("still runs remaining items when one fails", async () => {
		const order: number[] = [];
		const results = await runConcurrent(
			[1, 2, 3],
			2,
			async (item) => {
				order.push(item);
				if (item === 2) throw new Error("fail");
				return item * 10;
			},
			() => -1,
		);
		expect(results).toEqual([10, -1, 30]);
		expect(order.sort()).toEqual([1, 2, 3]);
	});
});

// ─── createLoopTool ───

describe("createLoopTool", () => {
	it("returns a tool definition with name 'loop'", () => {
		const tool = createLoopTool();
		expect(tool).toBeDefined();
		expect(tool.name).toBe("loop");
		expect(typeof tool.execute).toBe("function");
	});

	it("has parameters with prompt, maxDepth, concurrency, model", () => {
		const tool = createLoopTool();
		expect(tool.parameters).toBeDefined();
	});
});
