import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { SubagentFleetComponent } from "../../src/tui/fleet.ts";
import { readFleetTranscript } from "../../src/tui/fleet-transcript.ts";
import {
	capLabel,
	capText,
	FLEET_WEB_ACTION_REFRESH,
	FLEET_WEB_ACTION_STEER,
	FLEET_WEB_ACTION_STOP,
	FLEET_WEB_ACTION_STOP_CANCEL,
	FLEET_WEB_ACTION_STOP_CONFIRM,
	FLEET_WEB_ACTION_TOOLS,
	FLEET_WEB_CAPS,
	plainTranscriptTail,
	projectFleetWebPanel,
	stripAnsi,
	type FleetWebActionItem,
	type FleetWebNode,
	type FleetWebPanel,
	type FleetWebPanelInput,
} from "../../src/tui/fleet-web.ts";
import type { SubagentState } from "../../src/shared/types.ts";

function stateForTest(): SubagentState {
	return {
		baseCwd: process.cwd(),
		currentSessionId: "session-current",
		asyncJobs: new Map(),
		foregroundRuns: new Map(),
		foregroundControls: new Map(),
		lastForegroundControlId: null,
		cleanupTimers: new Map(),
		lastUiContext: null,
		poller: null,
		completionSeen: new Map(),
		watcher: null,
		watcherRestartTimer: null,
		resultFileCoalescer: { schedule: () => false, clear: () => {} },
	};
}

function writeAsyncRun(root: string, input: {
	id: string;
	sessionId?: string;
	state?: "running" | "complete";
	agents?: string[];
	output?: string;
	transcript?: Array<Record<string, unknown>>;
}): string {
	const asyncDir = path.join(root, input.id);
	fs.mkdirSync(asyncDir, { recursive: true });
	const agents = input.agents ?? ["worker"];
	if (input.output !== undefined) fs.writeFileSync(path.join(asyncDir, "output-0.log"), input.output, "utf-8");
	const transcriptPath = input.transcript ? path.join(asyncDir, "transcript-0.jsonl") : undefined;
	if (transcriptPath && input.transcript) fs.writeFileSync(transcriptPath, `${input.transcript.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf-8");
	fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
		runId: input.id,
		sessionId: input.sessionId ?? "session-current",
		mode: agents.length > 1 ? "parallel" : "single",
		state: input.state ?? "running",
		startedAt: 100,
		lastUpdate: 200,
		currentStep: 0,
		steps: agents.map((agent, index) => ({
			agent,
			status: input.state === "complete" ? "complete" : index === 0 ? "running" : "pending",
			startedAt: 100,
			...(index === 0 ? { sessionFile: path.join(asyncDir, `${agent}.jsonl`), ...(transcriptPath ? { transcriptPath } : {}) } : {}),
		})),
		...(input.output !== undefined ? { outputFile: "output-0.log" } : {}),
	}, null, 2));
	return asyncDir;
}

const theme = {
	fg: (_name: string, text: string) => text,
	bold: (text: string) => text,
};

function baseInput(overrides: Partial<FleetWebPanelInput> = {}): FleetWebPanelInput {
	return {
		roster: [
			{ id: "async:run-a:0", title: "worker", subtitle: "Implement the task", status: "running" },
			{ id: "async:run-b:0", title: "reviewer", subtitle: "run-b", status: "queued" },
		],
		selectedId: "async:run-a:0",
		detail: {
			title: "worker · running",
			metrics: [
				{ label: "Task", value: "Implement the task" },
				{ label: "State", value: "running" },
				{ label: "Source", value: "background" },
				{ label: "Model", value: "test-model" },
				{ label: "Runtime", value: "12s" },
			],
			transcriptTail: "◆ Assistant\n  progress so far",
		},
		actionState: { busy: false, stopConfirming: false, expandedTools: false, hasControls: true },
		...overrides,
	};
}

function sectionChildren(panel: FleetWebPanel): FleetWebNode[] {
	return (panel.root as Extract<FleetWebNode, { type: "section" }>).children;
}

function detailOf(panel: FleetWebPanel): Extract<FleetWebNode, { type: "detail" }> {
	const detail = sectionChildren(panel).find((child): child is Extract<FleetWebNode, { type: "detail" }> => child.type === "detail");
	assert.ok(detail, "projection must contain a detail node");
	return detail;
}

function listOf(panel: FleetWebPanel): Extract<FleetWebNode, { type: "list" }> {
	const list = sectionChildren(panel).find((child): child is Extract<FleetWebNode, { type: "list" }> => child.type === "list");
	assert.ok(list, "projection must contain a list node");
	return list;
}

function noticesOf(panel: FleetWebPanel): Array<Extract<FleetWebNode, { type: "notice" }>> {
	return (detailOf(panel).children ?? []).filter((child): child is Extract<FleetWebNode, { type: "notice" }> => child.type === "notice");
}

function actionsOf(panel: FleetWebPanel): FleetWebActionItem[] {
	const actions = (detailOf(panel).children ?? []).find((child): child is Extract<FleetWebNode, { type: "actions" }> => child.type === "actions");
	assert.ok(actions, "projection must contain an actions node");
	return actions.items;
}

function metricsOf(panel: FleetWebPanel): Array<Extract<FleetWebNode, { type: "metrics" }>["items"]> {
	const metrics = (detailOf(panel).children ?? []).find((child): child is Extract<FleetWebNode, { type: "metrics" }> => child.type === "metrics");
	return metrics?.items ?? [];
}

function textOf(panel: FleetWebPanel): Extract<FleetWebNode, { type: "text" }> | undefined {
	return (detailOf(panel).children ?? []).find((child): child is Extract<FleetWebNode, { type: "text" }> => child.type === "text");
}

function steerInputOf(panel: FleetWebPanel): Extract<FleetWebNode, { type: "input" }> | undefined {
	return (detailOf(panel).children ?? []).find((child): child is Extract<FleetWebNode, { type: "input" }> => child.type === "input");
}

describe("fleet web projection", () => {
	it("projects an actionable running worker with roster, selection and controls", () => {
		const panel = projectFleetWebPanel(baseInput());
		assert.equal(panel.version, 1);
		assert.equal(panel.title, "Subagent fleet");
		assert.equal(panel.layout, "workspace");
		const list = listOf(panel);
		assert.equal(list.selectedId, "async:run-a:0");
		assert.deepEqual(list.items.map((item) => [item.id, item.title, item.status]), [
			["async:run-a:0", "worker", "running"],
			["async:run-b:0", "reviewer", "queued"],
		]);
		const detail = detailOf(panel);
		assert.equal(detail.title, "worker · running");
		const metricLabels = metricsOf(panel).map((metric) => metric.label);
		assert.ok(metricLabels.includes("Task"));
		assert.ok(metricLabels.includes("State"));
		assert.ok(metricLabels.includes("Source"));
		assert.ok(metricLabels.includes("Model"));
		assert.ok(metricLabels.includes("Runtime"));
		assert.equal(textOf(panel)?.content, "◆ Assistant\n  progress so far");
		assert.equal(textOf(panel)?.log, true);
		assert.equal(steerInputOf(panel)?.id, FLEET_WEB_ACTION_STEER);
		const actions = actionsOf(panel);
		assert.ok(actions.some((action) => action.id === FLEET_WEB_ACTION_REFRESH));
		assert.ok(actions.some((action) => action.id === FLEET_WEB_ACTION_TOOLS));
		const stop = actions.find((action) => action.id === FLEET_WEB_ACTION_STOP);
		assert.equal(stop?.kind, "danger");
		assert.equal(stop?.disabled, undefined);
	});

	it("projects a completed non-actionable child with disabled stop and guidance", () => {
		const panel = projectFleetWebPanel(baseInput({
			actionState: {
				busy: false,
				stopConfirming: false,
				expandedTools: false,
				hasControls: false,
				controlsReason: "Selected child is complete; controls require a running or queued async child.",
			},
		}));
		assert.equal(steerInputOf(panel), undefined);
		const stop = actionsOf(panel).find((action) => action.id === FLEET_WEB_ACTION_STOP);
		assert.equal(stop?.disabled, true);
		assert.ok(noticesOf(panel).some((notice) => notice.tone === "info" && notice.message.includes("controls require")));
	});

	it("projects scan errors and transcript warnings as warning notices", () => {
		const panel = projectFleetWebPanel(baseInput({
			scanError: "Failed to inspect async run 'x'",
			detail: {
				title: "worker · running",
				metrics: [{ label: "State", value: "running" }],
				transcriptTail: "tail",
				transcriptWarning: "Skipped 2 malformed transcript records.",
			},
		}));
		const warnings = noticesOf(panel).filter((notice) => notice.tone === "warning");
		assert.ok(warnings.some((notice) => notice.message.includes("Fleet scan warning")));
		assert.ok(warnings.some((notice) => notice.message.includes("malformed")));
	});

	it("projects an empty roster with a clear empty state and no stop action", () => {
		const panel = projectFleetWebPanel(baseInput({ roster: [], selectedId: undefined, detail: undefined }));
		assert.deepEqual(listOf(panel).items, []);
		assert.equal(listOf(panel).selectedId, undefined);
		assert.ok(noticesOf(panel).some((notice) => notice.tone === "info" && notice.message.includes("No current-session")));
		assert.ok(!actionsOf(panel).some((action) => action.id === FLEET_WEB_ACTION_STOP));
	});

	it("projects the stop confirmation state with confirm/cancel actions", () => {
		const panel = projectFleetWebPanel(baseInput({
			actionState: {
				busy: false,
				stopConfirming: true,
				expandedTools: false,
				hasControls: true,
				stopConfirmMessage: "Confirm stop for async run run-a? Stop ends the run; use interrupt for a resumable pause.",
			},
		}));
		assert.ok(noticesOf(panel).some((notice) => notice.tone === "warning" && notice.message.includes("Confirm stop for async run run-a")));
		assert.equal(steerInputOf(panel), undefined);
		const actions = actionsOf(panel);
		assert.ok(actions.some((action) => action.id === FLEET_WEB_ACTION_STOP_CANCEL && action.kind === "secondary"));
		assert.ok(actions.some((action) => action.id === FLEET_WEB_ACTION_STOP_CONFIRM && action.kind === "danger"));
		assert.ok(!actions.some((action) => action.id === FLEET_WEB_ACTION_STOP || action.id === FLEET_WEB_ACTION_REFRESH));
	});

	it("bounds the plain-text transcript tail and strips ANSI control codes", () => {
		const transcript = {
			path: "ignored",
			truncated: true,
			events: [
				{ kind: "tool" as const, name: "bash", args: "echo hi", status: "complete" as const, output: "\x1b[31mred\x1b[0m output\nline two\nline three\nline four" },
				{ kind: "assistant" as const, text: "plain \x1b[1mstyled\x1b[0m answer", model: "model-a" },
				{ kind: "notice" as const, text: "notice text", tone: "warning" as const },
			],
		};
		const tail = plainTranscriptTail(transcript, { expandedTools: true, maxChars: 300, maxLines: 30 });
		assert.ok(!tail.includes("\x1b"), "ANSI escape codes must never cross the wire");
		assert.ok(tail.includes("↑ Earlier activity omitted"));
		assert.ok(tail.includes("red output"));
		assert.ok(tail.includes("line four"), "bash output tail should be included");
		assert.ok(tail.includes("plain styled answer"));
		assert.ok(tail.includes("notice text"));
		assert.ok(tail.length <= 300);

		const capped = plainTranscriptTail(transcript, { maxChars: 60, maxLines: 30 });
		assert.ok(capped.length <= 60);

		const lineCapped = plainTranscriptTail({
			path: "ignored",
			truncated: false,
			events: Array.from({ length: 50 }, (_, index) => ({ kind: "notice" as const, text: `line ${index}`, tone: "muted" as const })),
		}, { maxChars: 5000, maxLines: 10 });
		assert.equal(lineCapped.split("\n").length, 10);
	});

	it("bounds labels and free text within the WebPanel caps", () => {
		assert.ok(capLabel("x".repeat(500)).length <= FLEET_WEB_CAPS.maxLabelLength);
		assert.ok(capText("y".repeat(9000)).length <= FLEET_WEB_CAPS.maxTextLength);
		assert.ok(capLabel("short").length < FLEET_WEB_CAPS.maxLabelLength);
		assert.equal(stripAnsi("\x1b[31mhello\x1b[0m"), "hello");
	});

	it("never emits strings beyond the WebPanel caps from the full projection", () => {
		const panel = projectFleetWebPanel(baseInput({
			scanError: "scan " + "e".repeat(300),
			detail: {
				title: "worker · running",
				metrics: [{ label: "Task", value: "t".repeat(400) }, { label: "State", value: "running" }],
				transcriptTail: "tail",
				transcriptWarning: "w".repeat(300),
			},
			actionState: { busy: true, stopConfirming: false, expandedTools: true, hasControls: true, notice: { text: "n".repeat(300), isError: true } },
		}));
		const serialized = JSON.stringify(panel);
		const allStrings = JSON.parse(serialized, (_key, value) => (typeof value === "string" ? value : undefined));
		const walk = (value: unknown): void => {
			if (typeof value === "string") {
				if (value.length > FLEET_WEB_CAPS.maxTextLength) throw new Error(`string exceeds text cap: ${value.length}`);
			} else if (Array.isArray(value)) {
				for (const entry of value) walk(entry);
			} else if (value && typeof value === "object") {
				for (const entry of Object.values(value)) walk(entry);
			}
		};
		walk(allStrings);
		assert.ok(serialized.length < 64 * 1024);
	});
});

describe("fleet web actions", () => {
	it("selects a roster item and preserves selection across live refresh", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fleet-web-select-"));
		try {
			writeAsyncRun(root, { id: "run-a", agents: ["worker", "reviewer"] });
			writeAsyncRun(root, { id: "run-b" });
			const state = stateForTest();
			const component = new SubagentFleetComponent(
				{ terminal: { rows: 28, columns: 100 }, requestRender() {} } as never,
				theme as never,
				state,
				() => {},
				{ asyncDirRoot: root, resultsDir: path.join(root, "results"), refreshMs: 60_000 },
			);
			try {
				const before = component.getWebView() as FleetWebPanel;
				assert.equal(listOf(before).selectedId, "async:run-a:0");
				component.handleWebAction({ actionId: "async:run-b:0" });
				const after = component.getWebView() as FleetWebPanel;
				assert.equal(listOf(after).selectedId, "async:run-b:0");
				assert.ok(detailOf(after).title?.includes("worker"), "detail should follow the newly selected roster item");
				component.invalidate();
				const refreshed = component.getWebView() as FleetWebPanel;
				assert.equal(listOf(refreshed).selectedId, "async:run-b:0", "selection must survive a live refresh");
			} finally {
				component.dispose();
			}
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("routes the steer payload through the existing action and rejects empty messages", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fleet-web-steer-"));
		try {
			writeAsyncRun(root, { id: "run-a", agents: ["worker", "reviewer"] });
			const state = stateForTest();
			const calls: Array<{ runId: string; index?: number; message: string }> = [];
			const component = new SubagentFleetComponent(
				{ terminal: { rows: 28, columns: 100 }, requestRender() {} } as never,
				theme as never,
				state,
				() => {},
				{
					asyncDirRoot: root,
					resultsDir: path.join(root, "results"),
					refreshMs: 60_000,
					actions: {
						async steer(input) {
							calls.push({ runId: input.runId, index: input.index, message: input.message });
							return { text: "Steering queued." };
						},
						stop() {
							return { text: "unused" };
						},
					},
				},
			);
			try {
				component.handleWebAction({ actionId: FLEET_WEB_ACTION_STEER, payload: { value: "  keep going  " } });
				await new Promise((resolve) => setImmediate(resolve));
				assert.deepEqual(calls, [{ runId: "run-a", index: 0, message: "keep going" }]);
				assert.ok(noticesOf(component.getWebView() as FleetWebPanel).some((notice) => notice.tone === "success" && notice.message.includes("Steering queued.")));

				component.handleWebAction({ actionId: FLEET_WEB_ACTION_STEER, payload: { value: "   " } });
				await new Promise((resolve) => setImmediate(resolve));
				assert.equal(calls.length, 1, "empty steer messages must be rejected");
				assert.ok(noticesOf(component.getWebView() as FleetWebPanel).some((notice) => notice.tone === "error" && notice.message.includes("cannot be empty")));
			} finally {
				component.dispose();
			}
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("requires an explicit confirmation before stopping and cancels cleanly", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fleet-web-stop-"));
		try {
			writeAsyncRun(root, { id: "run-a", agents: ["worker", "reviewer"] });
			const state = stateForTest();
			const calls: Array<{ runId: string; index?: number }> = [];
			const component = new SubagentFleetComponent(
				{ terminal: { rows: 28, columns: 100 }, requestRender() {} } as never,
				theme as never,
				state,
				() => {},
				{
					asyncDirRoot: root,
					resultsDir: path.join(root, "results"),
					refreshMs: 60_000,
					actions: {
						async steer() {
							return { text: "unused" };
						},
						stop(input) {
							calls.push({ runId: input.runId, index: input.index });
							return { text: "Stop requested." };
						},
					},
				},
			);
			try {
				component.handleWebAction({ actionId: FLEET_WEB_ACTION_STOP });
				let panel = component.getWebView() as FleetWebPanel;
				assert.ok(noticesOf(panel).some((notice) => notice.tone === "warning" && notice.message.includes("Confirm stop")));
				assert.deepEqual(calls, [], "stop must not run before confirmation");
				component.handleWebAction({ actionId: FLEET_WEB_ACTION_STOP_CANCEL });
				panel = component.getWebView() as FleetWebPanel;
				assert.ok(!noticesOf(panel).some((notice) => notice.message.includes("Confirm stop")));
				assert.deepEqual(calls, []);
				component.handleWebAction({ actionId: FLEET_WEB_ACTION_STOP });
				component.handleWebAction({ actionId: FLEET_WEB_ACTION_STOP_CONFIRM });
				await new Promise((resolve) => setImmediate(resolve));
				assert.deepEqual(calls, [{ runId: "run-a", index: 0 }]);
				assert.ok(noticesOf(component.getWebView() as FleetWebPanel).some((notice) => notice.tone === "success" && notice.message.includes("Stop requested.")));
			} finally {
				component.dispose();
			}
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("ignores unknown and stale action ids without side effects", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fleet-web-unknown-"));
		try {
			writeAsyncRun(root, { id: "run-a", agents: ["worker", "reviewer"] });
			const state = stateForTest();
			const calls: Array<unknown> = [];
			const component = new SubagentFleetComponent(
				{ terminal: { rows: 28, columns: 100 }, requestRender() {} } as never,
				theme as never,
				state,
				() => {},
				{
					asyncDirRoot: root,
					resultsDir: path.join(root, "results"),
					refreshMs: 60_000,
					actions: {
						async steer(input) {
							calls.push(input);
							return { text: "unused" };
						},
						stop() {
							calls.push("stop");
							return { text: "unused" };
						},
					},
				},
			);
			try {
				const before = component.getWebView() as FleetWebPanel;
				component.handleWebAction({ actionId: "fleet:bogus" });
				component.handleWebAction({ actionId: "async:stale-run:0" });
				const after = component.getWebView() as FleetWebPanel;
				assert.deepEqual(calls, []);
				assert.deepEqual(listOf(after).selectedId, listOf(before).selectedId);
				assert.deepEqual(noticesOf(after), []);

				component.handleWebAction({ actionId: FLEET_WEB_ACTION_STEER, payload: { value: 42 } });
				assert.deepEqual(calls, [], "a malformed steer value must never reach the action handler");
				const rejected = component.getWebView() as FleetWebPanel;
				assert.ok(noticesOf(rejected).some((notice) => notice.tone === "error" && notice.message.includes("cannot be empty")));
			} finally {
				component.dispose();
			}
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("rerenders a truthful busy state while a web action is pending", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fleet-web-busy-"));
		try {
			writeAsyncRun(root, { id: "run-a", agents: ["worker", "reviewer"] });
			const state = stateForTest();
			let resolveAction: (result: { text: string }) => void = () => {};
			const component = new SubagentFleetComponent(
				{ terminal: { rows: 28, columns: 100 }, requestRender() {} } as never,
				theme as never,
				state,
				() => {},
				{
					asyncDirRoot: root,
					resultsDir: path.join(root, "results"),
					refreshMs: 60_000,
					actions: {
						steer() {
							return new Promise((resolve) => {
								resolveAction = resolve;
							});
						},
						stop() {
							return { text: "unused" };
						},
					},
				},
			);
			try {
				component.handleWebAction({ actionId: FLEET_WEB_ACTION_STEER, payload: { value: "continue" } });
				const busyPanel = component.getWebView() as FleetWebPanel;
				assert.ok(noticesOf(busyPanel).some((notice) => notice.tone === "info" && notice.message.includes("Action pending")));
				resolveAction({ text: "Done." });
				await new Promise((resolve) => setImmediate(resolve));
				const settledPanel = component.getWebView() as FleetWebPanel;
				assert.ok(noticesOf(settledPanel).some((notice) => notice.tone === "success" && notice.message.includes("Done.")));
				assert.ok(!noticesOf(settledPanel).some((notice) => notice.message.includes("Action pending")));
			} finally {
				component.dispose();
			}
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("builds a structural projection with a transcript warning and a bounded transcript tail", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fleet-web-tail-"));
		try {
			const longAssistant = `line ${Array.from({ length: 300 }, (_, index) => index).join(" ")}`;
			writeAsyncRun(root, {
				id: "run-a",
				agents: ["worker"],
				state: "running",
				transcript: [
					{ recordType: "message", role: "user", text: "injected task" },
					{ recordType: "tool_start", toolName: "bash", argsPreview: "echo hi" },
					{ recordType: "tool_end", toolName: "bash" },
					{ recordType: "message", role: "toolResult", toolName: "bash", text: "output content\nmore output", isError: false },
					{ recordType: "message", role: "assistant", model: "test-model", text: longAssistant },
				],
			});
			const state = stateForTest();
			state.baseCwd = root;
			const component = new SubagentFleetComponent(
				{ terminal: { rows: 28, columns: 100 }, requestRender() {} } as never,
				theme as never,
				state,
				() => {},
				{ asyncDirRoot: root, resultsDir: path.join(root, "results"), refreshMs: 60_000 },
			);
			try {
				const panel = component.getWebView() as FleetWebPanel;
				const text = textOf(panel);
				assert.ok(text, "selected worker must expose a transcript tail");
				assert.ok(text.content.length <= FLEET_WEB_CAPS.maxTextLength);
				assert.ok(text.content.includes("assistant") || text.content.includes("Assistant"));
				assert.ok(!text.content.includes("\x1b"), "no ANSI control codes may reach the web detail");
				const metricLabels = metricsOf(panel).map((metric) => metric.label);
				assert.ok(metricLabels.includes("Activity"));
				assert.ok(metricLabels.includes("State"));
			} finally {
				component.dispose();
			}
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("reads a bounded tail from the same trusted-root transcript source", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fleet-web-source-"));
		try {
			writeAsyncRun(root, {
				id: "run-a",
				agents: ["worker"],
				state: "complete",
				transcript: [
					{ recordType: "message", role: "assistant", text: "final answer" },
				],
			});
			const transcript = readFleetTranscript(path.join(root, "run-a", "transcript-0.jsonl"), { trustedRoots: [root] });
			const tail = plainTranscriptTail(transcript, {});
			assert.ok(tail.includes("final answer"));
			assert.ok(!tail.includes("undefined"));
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
