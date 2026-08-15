import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it } from "node:test";
import { SubagentFleetComponent } from "../../src/tui/fleet.ts";
import { readFleetTranscript } from "../../src/tui/fleet-transcript.ts";
import {
	capLabel,
	capNotice,
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

/** Representative worst case: every string at its cap, free text in
 *  multibyte UTF-8, roster at the conservative cap, all notices present. */
function worstCaseProjection(): FleetWebPanel {
	const ascii = (count: number) => "x".repeat(count);
	const multibyte = (count: number) => "😀".repeat(count); // 4 UTF-8 bytes per character
	const roster = Array.from({ length: FLEET_WEB_CAPS.maxRosterItems }, () => ({
		id: ascii(200),
		title: ascii(200),
		subtitle: ascii(200),
		status: ascii(200),
	}));
	return projectFleetWebPanel({
		roster,
		selectedId: roster[0].id,
		scanError: "scan " + ascii(2000),
		detail: {
			title: ascii(200),
			metrics: Array.from({ length: 9 }, () => ({ label: ascii(200), value: ascii(200), detail: ascii(200) })),
			transcriptTail: multibyte(3000) + ascii(500),
			transcriptWarning: "warn " + multibyte(2000),
		},
		actionState: {
			busy: true,
			stopConfirming: true,
			expandedTools: true,
			hasControls: true,
			stopConfirmMessage: "confirm " + ascii(2000),
			notice: { text: ascii(2000), isError: true },
		},
	});
}

/** Locate Pi Web's exact validateWebPanel source for the opt-in fixture test.
 *  Only used when the sibling worktree exists; never a runtime dependency. */
function piWebValidatorPath(): string | undefined {
	const candidates = [
		process.env.PI_WEB_VALIDATOR,
		"C:/Dev/Worktrees/pi-web/main-driver-release/lib/web-panel.ts",
		"C:/Dev/Worktrees/pi-web/lib/web-panel.ts",
	].filter((candidate): candidate is string => typeof candidate === "string");
	return candidates.find((candidate) => fs.existsSync(candidate));
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
		assert.equal(textOf(panel)?.content, "◆ Assistant  progress so far");
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

	it("strips ANSI and control sequences from every transcript-derived field", () => {
		const transcript = {
			path: "ignored",
			truncated: false,
			events: [
				{ kind: "tool" as const, name: "\x1b[31mbash\x1b[0m", args: "echo \x1b]0;window-title\x07\x07secret \x00hidden", status: "error" as const, error: "boom \x1b[31mred\x1b[0m \x1b[3A" },
				{ kind: "tool" as const, name: "\u009B31mcat\u009B0m", args: "\x08back\bspace", status: "complete" as const, output: "out \x1b[2K" },
			],
		};
		const tail = plainTranscriptTail(transcript, { expandedTools: true });
		assert.ok(!/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F\x80-\x9F]/.test(tail), "no control characters may cross the wire");
		assert.ok(!tail.includes("\x1b"));
		assert.ok(tail.includes("● bash echo secret hidden (error)"), "tool name and args must be stripped before they are surfaced");
		assert.ok(tail.includes("boom red"), "tool errors must be stripped");
		assert.ok(tail.includes("cat backspace (done)"));
		assert.ok(tail.includes("out"), "tool output must be stripped");
		assert.equal(stripAnsi("\x00a\x08b\x7f\x1b[31m\x9Bc"), "ab");
	});

	it("keeps the newest transcript events and marks omitted earlier activity", () => {
		const events = Array.from({ length: 200 }, (_, index) => ({ kind: "notice" as const, text: `event ${index}`, tone: "muted" as const }));
		const tail = plainTranscriptTail({ path: "ignored", truncated: false, events }, { maxChars: 5000, maxLines: 25 });
		const lines = tail.split("\n");
		assert.equal(lines.length, 25, "tail must respect the line cap");
		assert.ok(lines[0].includes("Earlier activity omitted"), "omitted earlier activity must be visibly indicated");
		assert.ok(tail.includes("event 199"), "newest event must be present");
		assert.ok(!tail.includes("event 0"), "oldest event must be omitted");
		const numbers = lines.slice(1).map((line) => Number(line.match(/event (\d+)/)?.[1]));
		assert.deepEqual(numbers, [...numbers].sort((left, right) => left - right), "included groups must stay in chronological order");
	});

	it("prefers newest events under a tight char cap", () => {
		const events = Array.from({ length: 50 }, (_, index) => ({ kind: "notice" as const, text: `event-${index}-content`, tone: "muted" as const }));
		const tail = plainTranscriptTail({ path: "ignored", truncated: false, events }, { maxChars: 120, maxLines: 500 });
		assert.ok(tail.length <= 120);
		assert.ok(tail.includes("event-49-content"), "newest event must survive a tight char cap");
		assert.ok(!tail.includes("event-0-content"), "oldest event must be omitted");
		assert.ok(tail.includes("Earlier activity omitted"));
	});

	it("shows older activity when the newest event is too large to render", () => {
		const events = [
			{ kind: "notice" as const, text: "x".repeat(500), tone: "muted" as const },
			{ kind: "notice" as const, text: "older small event", tone: "muted" as const },
		];
		const tail = plainTranscriptTail({ path: "ignored", truncated: false, events }, { maxChars: 80, maxLines: 50 });
		assert.ok(tail.includes("older small event"), "older fitting activity must still be shown");
		assert.ok(tail.includes("Earlier activity omitted"));
		assert.ok(!tail.includes("x".repeat(500)));
	});

	it("caps roster ids, titles, subtitles and statuses at the label cap", () => {
		const long = "y".repeat(300);
		const panel = projectFleetWebPanel(baseInput({
			roster: [{ id: long, title: long, subtitle: long, status: long }],
			selectedId: long,
		}));
		const [item] = listOf(panel).items;
		assert.ok(item.id.length <= FLEET_WEB_CAPS.maxLabelLength);
		assert.ok(item.title.length <= FLEET_WEB_CAPS.maxLabelLength);
		assert.ok((item.subtitle ?? "").length <= FLEET_WEB_CAPS.maxLabelLength);
		assert.ok((item.status ?? "").length <= FLEET_WEB_CAPS.maxLabelLength);
		assert.equal(listOf(panel).selectedId, item.id, "selected id must match the capped roster id");
	});

	it("sanitizes every extension-controlled projection string", () => {
		const hostile = "\x1b[31mred\x1b[0m\x00\x08\n\r\u009b31m";
		const panel = projectFleetWebPanel(baseInput({
			roster: [{ id: hostile, title: hostile, subtitle: hostile, status: hostile }], selectedId: hostile,
			scanError: hostile, emptyMessage: hostile,
			detail: { title: hostile, metrics: [{ label: hostile, value: hostile, detail: hostile }], transcriptTail: hostile, transcriptWarning: hostile },
			actionState: { busy: false, stopConfirming: true, expandedTools: false, hasControls: false, controlsReason: hostile, stopConfirmMessage: hostile, notice: { text: hostile, isError: true } },
		}));
		const strings: string[] = [];
		const collect = (value: unknown): void => {
			if (typeof value === "string") strings.push(value);
			else if (Array.isArray(value)) value.forEach(collect);
			else if (value && typeof value === "object") Object.values(value).forEach(collect);
		};
		collect(JSON.parse(JSON.stringify(panel)));
		assert.ok(strings.every((value) => !/[\x00-\x1F\x7F-\x9F]/.test(value)), "no control byte may occur anywhere in JSON projection");
		assert.ok(strings.some((value) => value.includes("red")), "sanitization retains printable content");
	});

	it("caps the final composed prefixed notice instead of fragments", () => {
		const panel = projectFleetWebPanel(baseInput({
			scanError: "e".repeat(5000),
			detail: { title: "worker · running", metrics: [{ label: "State", value: "running" }], transcriptTail: "tail" },
		}));
		const scanWarning = noticesOf(panel).find((notice) => notice.message.startsWith("Fleet scan warning:"));
		assert.ok(scanWarning, "scan warning notice must be present");
		assert.ok(scanWarning.message.length <= FLEET_WEB_CAPS.maxNoticeLength, "the final composed notice must be capped");
		assert.ok(scanWarning.message.startsWith("Fleet scan warning:"));
		assert.ok(capNotice("n".repeat(9000)).length <= FLEET_WEB_CAPS.maxNoticeLength);
	});

	it("disables all actions and omits the steer input while busy", () => {
		const panel = projectFleetWebPanel(baseInput({
			actionState: { busy: true, stopConfirming: false, expandedTools: false, hasControls: true, notice: { text: "Working…", isError: false } },
		}));
		assert.equal(steerInputOf(panel), undefined, "steer input must be omitted while an action is pending");
		assert.ok(actionsOf(panel).length > 0);
		assert.ok(actionsOf(panel).every((action) => action.disabled === true), "overlapping controls must be disabled while busy");
		assert.ok(noticesOf(panel).some((notice) => notice.tone === "info" && notice.message.includes("Action pending")));
	});

	it("keeps a representative worst-case projection under the 64 KiB WebPanel payload cap", () => {
		const panel = worstCaseProjection();
		const serialized = JSON.stringify(panel);
		const bytes = new TextEncoder().encode(serialized).length;
		assert.ok(bytes <= 64 * 1024, `worst-case projection must stay under 64 KiB (actual ${bytes} bytes)`);
	});

	it("validates representative fixtures through Pi Web's exact validator when available locally", async () => {
		const validatorPath = piWebValidatorPath();
		if (!validatorPath) {
			console.log("Pi Web validator source not found locally; skipping exact-validator fixture check.");
			return;
		}
		const { validateWebPanel } = await import(pathToFileURL(validatorPath).href);
		const fixtures: FleetWebPanel[] = [
			projectFleetWebPanel(baseInput()),
			projectFleetWebPanel(baseInput({
				roster: [],
				selectedId: undefined,
				detail: undefined,
			})),
			projectFleetWebPanel(baseInput({
				actionState: { busy: false, stopConfirming: true, expandedTools: false, hasControls: true, stopConfirmMessage: "Confirm stop for async run run-a?" },
			})),
			worstCaseProjection(),
		];
		for (const fixture of fixtures) {
			const result = validateWebPanel(fixture);
			assert.ok(result.ok, `Pi Web rejected the fleet projection: ${result.ok ? "" : result.error}`);
		}
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

	it("shows the newest transcript activity with older events visibly omitted", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fleet-web-tail-newest-"));
		try {
			const transcript: Array<Record<string, unknown>> = [];
			for (let index = 0; index < 100; index++) {
				transcript.push({ recordType: "message", role: "assistant", text: `message number ${index}`, model: "test-model" });
			}
			writeAsyncRun(root, { id: "run-a", agents: ["worker"], state: "running", transcript });
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
				const tail = textOf(panel)?.content ?? "";
				assert.ok(tail.includes("message number 99"), "newest activity must be present in the live tail");
				assert.ok(!tail.includes("message number 0"), "oldest activity must be omitted");
				assert.ok(tail.includes("Earlier activity omitted"), "omitted older activity must be indicated");
				const numbers = [...tail.matchAll(/message number (\d+)/g)].map((match) => Number(match[1]));
				assert.ok(numbers.length > 1);
				assert.deepEqual(numbers, [...numbers].sort((left, right) => left - right), "included events must remain in chronological order");
			} finally {
				component.dispose();
			}
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("keeps command output out of the collapsed transcript and exposes it when expanded", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fleet-web-collapse-"));
		try {
			writeAsyncRun(root, {
				id: "run-a",
				agents: ["worker"],
				state: "running",
				transcript: [
					{ recordType: "tool_start", toolName: "bash", argsPreview: "echo top-secret" },
					{ recordType: "tool_end", toolName: "bash" },
					{ recordType: "message", role: "toolResult", toolName: "bash", text: "top-secret value 42\nmore output", isError: false },
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
				const collapsed = component.getWebView() as FleetWebPanel;
				const collapsedContent = textOf(collapsed)?.content ?? "";
				assert.ok(collapsedContent.includes("echo top-secret"), "tool name and args remain visible when collapsed");
				assert.ok(!collapsedContent.includes("top-secret value 42"), "collapsed tools must not expose command output");
				assert.ok(!collapsedContent.includes("more output"));
				component.handleWebAction({ actionId: FLEET_WEB_ACTION_TOOLS });
				const expanded = component.getWebView() as FleetWebPanel;
				const expandedContent = textOf(expanded)?.content ?? "";
				assert.ok(expandedContent.includes("top-secret value 42"), "expanded tools may show command output");
				assert.ok(expandedContent.includes("more output"));
			} finally {
				component.dispose();
			}
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("omits the filesystem path from web foreground activity", () => {
		const state = stateForTest();
		state.baseCwd = process.cwd();
		state.foregroundControls.set("fg-run-1", {
			runId: "fg-run-1",
			mode: "single",
			startedAt: 100,
			updatedAt: 200,
			cwd: process.cwd(),
			currentAgent: "worker",
			currentIndex: 0,
			activeChildren: new Map([[0, {
				index: 0,
				agent: "worker",
				startedAt: 100,
				updatedAt: 200,
				currentTool: "read",
				currentPath: "C:/Users/thoma/secret/project/src/index.ts",
			}]]),
		} as never);
		const component = new SubagentFleetComponent(
			{ terminal: { rows: 28, columns: 100 }, requestRender() {} } as never,
			theme as never,
			state,
			() => {},
			{ refreshMs: 60_000 },
		);
		try {
			const panel = component.getWebView() as FleetWebPanel;
			const activity = metricsOf(panel).find((metric) => metric.label === "Activity");
			assert.ok(activity, "foreground activity metric must be present");
			assert.equal(activity.value, "read");
			assert.ok(!JSON.stringify(panel).includes("secret/project"), "the web projection must never expose the filesystem path");
		} finally {
			component.dispose();
		}
	});

	it("never stops a different worker when the run vanishes before confirm", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fleet-web-stop-vanish-"));
		try {
			writeAsyncRun(root, { id: "run-a", agents: ["worker", "reviewer"] });
			writeAsyncRun(root, { id: "run-b" });
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
				assert.deepEqual(calls, []);
				// A timer/manual refresh happens while the confirmation is open and
				// the confirmed run disappears from the fleet snapshot.
				fs.rmSync(path.join(root, "run-a"), { recursive: true, force: true });
				component.invalidate();
				const panel = component.getWebView() as FleetWebPanel;
				assert.ok(noticesOf(panel).some((notice) => notice.tone === "error" && notice.message.includes("cancelled")), "refresh must cancel the stale confirmation with an explicit notice");
				assert.ok(!noticesOf(panel).some((notice) => notice.message.includes("Confirm stop")), "the stale confirmation UI must be gone");
				component.handleWebAction({ actionId: FLEET_WEB_ACTION_STOP_CONFIRM });
				await new Promise((resolve) => setImmediate(resolve));
				assert.deepEqual(calls, [], "confirm after the run vanished must never stop another worker");
			} finally {
				component.dispose();
			}
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects a stop confirm when the run stopped being actionable before confirm", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fleet-web-stop-completed-"));
		try {
			writeAsyncRun(root, { id: "run-a", agents: ["worker", "reviewer"] });
			const state = stateForTest();
			const calls: Array<{ runId: string }> = [];
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
							calls.push({ runId: input.runId });
							return { text: "Stop requested." };
						},
					},
				},
			);
			try {
				component.handleWebAction({ actionId: FLEET_WEB_ACTION_STOP });
				// The run completes (same key/runId) while the confirmation is open.
				writeAsyncRun(root, { id: "run-a", agents: ["worker", "reviewer"], state: "complete" });
				component.invalidate();
				const beforeConfirm = component.getWebView() as FleetWebPanel;
				assert.ok(noticesOf(beforeConfirm).some((notice) => notice.message.includes("Confirm stop")), "the confirmation stays while the run identity is intact");
				component.handleWebAction({ actionId: FLEET_WEB_ACTION_STOP_CONFIRM });
				await new Promise((resolve) => setImmediate(resolve));
				assert.deepEqual(calls, [], "a completed run must never be stopped");
				const afterConfirm = component.getWebView() as FleetWebPanel;
				assert.ok(noticesOf(afterConfirm).some((notice) => notice.tone === "error" && notice.message.includes("controls require")), "the rejection must carry an explicit notice");
			} finally {
				component.dispose();
			}
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("cancels the stop confirmation when the user reselects before confirm", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fleet-web-stop-reselect-"));
		try {
			writeAsyncRun(root, { id: "run-a", agents: ["worker", "reviewer"] });
			writeAsyncRun(root, { id: "run-b" });
			const state = stateForTest();
			const calls: Array<{ runId: string }> = [];
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
							calls.push({ runId: input.runId });
							return { text: "Stop requested." };
						},
					},
				},
			);
			try {
				component.handleWebAction({ actionId: FLEET_WEB_ACTION_STOP });
				component.handleWebAction({ actionId: "async:run-b:0" });
				const reselected = component.getWebView() as FleetWebPanel;
				assert.equal(listOf(reselected).selectedId, "async:run-b:0");
				assert.ok(!noticesOf(reselected).some((notice) => notice.message.includes("Confirm stop")), "reselection must cancel the confirmation");
				component.handleWebAction({ actionId: FLEET_WEB_ACTION_STOP_CONFIRM });
				await new Promise((resolve) => setImmediate(resolve));
				assert.deepEqual(calls, [], "a stale confirm after reselection must never stop another worker");
			} finally {
				component.dispose();
			}
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("still stops the bound run after a harmless refresh while confirming", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fleet-web-stop-fresh-"));
		try {
			writeAsyncRun(root, { id: "run-a", agents: ["worker", "reviewer"] });
			writeAsyncRun(root, { id: "run-b" });
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
				component.invalidate();
				const stillOpen = component.getWebView() as FleetWebPanel;
				assert.ok(noticesOf(stillOpen).some((notice) => notice.message.includes("Confirm stop")), "a harmless refresh must keep the confirmation");
				component.handleWebAction({ actionId: FLEET_WEB_ACTION_STOP_CONFIRM });
				await new Promise((resolve) => setImmediate(resolve));
				assert.deepEqual(calls, [{ runId: "run-a", index: 0 }], "the originally confirmed run must be stopped");
			} finally {
				component.dispose();
			}
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
