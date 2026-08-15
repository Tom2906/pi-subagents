// Optional duck-typed WebPanel v1 structured projection for the Subagent
// Fleet inspector. This module is deliberately pure: it only builds the
// validated JSON-safe projection shape and bounded plain-text transcript tail.
// It duplicates the small structural WebPanel subset it needs and never
// depends on Pi Web. The terminal component in fleet.ts feeds a view model in
// here; Pi Web's validator decides whether to use the projection or fall back
// to the ANSI render.
import type { FleetTranscript, FleetTranscriptEvent } from "./fleet-transcript.ts";

export const FLEET_WEB_VERSION = 1;

export const FLEET_WEB_CAPS = {
	maxLabelLength: 200,
	maxTextLength: 4000,
	maxRosterItems: 100,
	maxTailChars: 3500,
	maxTailLines: 120,
} as const;

export type FleetWebTone = "info" | "success" | "warning" | "error";
export type FleetWebActionKind = "primary" | "secondary" | "danger";
export type FleetWebLayout = "compact" | "workspace";

export interface FleetWebMetricItem {
	label: string;
	value: string;
	detail?: string;
}

export interface FleetWebListItem {
	id: string;
	title: string;
	subtitle?: string;
	status?: string;
}

export interface FleetWebActionItem {
	id: string;
	label: string;
	kind?: FleetWebActionKind;
	disabled?: boolean;
}

export type FleetWebNode =
	| { type: "section"; children: FleetWebNode[] }
	| { type: "list"; items: FleetWebListItem[]; selectedId?: string }
	| { type: "detail"; title?: string; children?: FleetWebNode[] }
	| { type: "metrics"; items: FleetWebMetricItem[] }
	| { type: "notice"; tone: FleetWebTone; message: string }
	| { type: "text"; content: string; log?: boolean }
	| { type: "input"; id: string; label: string; placeholder?: string; submitLabel?: string }
	| { type: "actions"; items: FleetWebActionItem[] };

export interface FleetWebPanel {
	version: typeof FLEET_WEB_VERSION;
	title: string;
	layout: FleetWebLayout;
	root: FleetWebNode;
}

// ---------------------------------------------------------------------------
// Bounding helpers (mirror the Pi Web caps so an oversized projection can
// never be produced in the first place).
// ---------------------------------------------------------------------------

/** Cap a short label/value string to the WebPanel label cap. */
export function capLabel(value: string): string {
	return value.length <= FLEET_WEB_CAPS.maxLabelLength ? value : `${value.slice(0, FLEET_WEB_CAPS.maxLabelLength - 1)}…`;
}

/** Cap free-form text to the WebPanel text cap. */
export function capText(value: string): string {
	return value.length <= FLEET_WEB_CAPS.maxTextLength ? value : `${value.slice(0, FLEET_WEB_CAPS.maxTextLength - 1)}…`;
}

/** Strip ANSI/terminal escape sequences so no control codes cross the wire. */
const ANSI_PATTERN = /[\u001B\u009B][[\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*|[a-zA-Z\d]+(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;

export function stripAnsi(value: string): string {
	return value.replace(ANSI_PATTERN, "");
}

// ---------------------------------------------------------------------------
// Bounded plain-text transcript tail. Never includes raw terminal render,
// paths outside trusted roots (readFleetTranscript already guarantees that)
// or unbounded tool payloads.
// ---------------------------------------------------------------------------

export interface FleetWebTailOptions {
	expandedTools?: boolean;
	maxChars?: number;
	maxLines?: number;
}

interface MutableTail {
	lines: string[];
	chars: number;
	maxChars: number;
	maxLines: number;
}

function tailPush(tail: MutableTail, text: string): void {
	if (tail.lines.length >= tail.maxLines) return;
	const next = tail.chars + text.length + 1;
	if (next > tail.maxChars) return;
	tail.lines.push(text);
	tail.chars = next;
}

function eventTailLines(event: FleetTranscriptEvent, expandedTools: boolean): string[] {
	if (event.kind === "tool") {
		const status = event.status === "running" ? "running" : event.status === "error" ? "error" : "done";
		const lines = [`● ${event.name}${event.args ? ` ${event.args}` : ""} (${status})`];
		if (expandedTools && event.output) {
			for (const outputLine of stripAnsi(event.output).replace(/\s+$/, "").split(/\r?\n/).slice(-8)) lines.push(`  ${outputLine}`);
		} else if (event.name === "bash" && event.output) {
			for (const outputLine of stripAnsi(event.output).replace(/\s+$/, "").split(/\r?\n/).slice(-2)) lines.push(`  ${outputLine}`);
		}
		if (event.error && event.status === "error") {
			for (const errorLine of stripAnsi(event.error).split(/\r?\n/).slice(0, 3)) lines.push(`  ! ${errorLine}`);
		}
		return lines;
	}
	if (event.kind === "assistant") {
		const lines = [`◆ Assistant${event.model ? ` · ${stripAnsi(event.model)}` : ""}`];
		for (const textLine of stripAnsi(event.text).split(/\r?\n/).slice(0, 8)) lines.push(`  ${textLine}`);
		return lines;
	}
	if (event.kind === "user") {
		const lines = ["◇ Supervisor"];
		for (const textLine of stripAnsi(event.text).split(/\r?\n/).slice(0, 4)) lines.push(`  ${textLine}`);
		return lines;
	}
	return [stripAnsi(event.text)];
}

/**
 * Build a bounded, plain-text, ANSI-free transcript tail for the web detail
 * pane. Message text is already clipped by readFleetTranscript; this function
 * additionally bounds lines and characters.
 */
export function plainTranscriptTail(transcript: FleetTranscript, options: FleetWebTailOptions = {}): string {
	const maxChars = Math.max(1, options.maxChars ?? FLEET_WEB_CAPS.maxTailChars);
	const maxLines = Math.max(1, options.maxLines ?? FLEET_WEB_CAPS.maxTailLines);
	const expandedTools = options.expandedTools === true;
	const tail: MutableTail = { lines: [], chars: 0, maxChars, maxLines };
	if (transcript.truncated) tailPush(tail, "↑ Earlier activity omitted");
	for (const event of transcript.events) {
		for (const line of eventTailLines(event, expandedTools)) tailPush(tail, line);
	}
	return tail.lines.join("\n");
}

// ---------------------------------------------------------------------------
// View model for the projection.
// ---------------------------------------------------------------------------

export interface FleetWebActionState {
	busy: boolean;
	notice?: { text: string; isError: boolean };
	stopConfirming: boolean;
	expandedTools: boolean;
	hasControls: boolean;
	controlsReason?: string;
	stopConfirmMessage?: string;
}

export interface FleetWebDetailInput {
	title?: string;
	metrics: FleetWebMetricItem[];
	transcriptTail?: string;
	transcriptWarning?: string;
}

export interface FleetWebPanelInput {
	roster: FleetWebListItem[];
	selectedId?: string;
	detail?: FleetWebDetailInput;
	actionState: FleetWebActionState;
	emptyMessage?: string;
	scanError?: string;
}

export const FLEET_WEB_ACTION_REFRESH = "fleet:refresh";
export const FLEET_WEB_ACTION_TOOLS = "fleet:tools";
export const FLEET_WEB_ACTION_STEER = "fleet:steer";
export const FLEET_WEB_ACTION_STOP = "fleet:stop";
export const FLEET_WEB_ACTION_STOP_CONFIRM = "fleet:stop:confirm";
export const FLEET_WEB_ACTION_STOP_CANCEL = "fleet:stop:cancel";

function notice(tone: FleetWebTone, message: string): Extract<FleetWebNode, { type: "notice" }> {
	return { type: "notice", tone, message };
}

function actionItems(state: FleetWebActionState, hasSelection: boolean): FleetWebActionItem[] {
	if (state.stopConfirming) {
		return [
			{ id: FLEET_WEB_ACTION_STOP_CANCEL, label: "Cancel", kind: "secondary" },
			{ id: FLEET_WEB_ACTION_STOP_CONFIRM, label: "Confirm stop", kind: "danger" },
		];
	}
	const items: FleetWebActionItem[] = [
		{ id: FLEET_WEB_ACTION_REFRESH, label: "Refresh", kind: "secondary" },
		{ id: FLEET_WEB_ACTION_TOOLS, label: state.expandedTools ? "Collapse tool output" : "Expand tool output", kind: "secondary" },
	];
	if (state.hasControls) {
		items.push({ id: FLEET_WEB_ACTION_STOP, label: "Stop", kind: "danger" });
	} else if (hasSelection) {
		items.push({ id: FLEET_WEB_ACTION_STOP, label: "Stop", kind: "danger", disabled: true });
	}
	return items;
}

/**
 * Build the full duck-typed WebPanel v1 projection for the fleet inspector.
 * Pure: all state arrives through the input view model, and every emitted
 * string is already within the WebPanel caps.
 */
export function projectFleetWebPanel(input: FleetWebPanelInput): FleetWebPanel {
	const detailChildren: FleetWebNode[] = [];
	if (input.scanError) detailChildren.push(notice("warning", `Fleet scan warning: ${capText(input.scanError)}`));
	if (!input.detail) {
		detailChildren.push(notice("info", capText(input.emptyMessage ?? "No current-session foreground or recent async children.")));
		detailChildren.push({ type: "actions", items: actionItems({ ...input.actionState, hasControls: false }, false) });
	} else {
		if (input.detail.metrics.length > 0) detailChildren.push({ type: "metrics", items: input.detail.metrics });
		if (input.detail.transcriptWarning) detailChildren.push(notice("warning", capText(input.detail.transcriptWarning)));
		if (input.actionState.busy) detailChildren.push(notice("info", "Action pending…"));
		if (input.actionState.notice) {
			detailChildren.push(notice(input.actionState.notice.isError ? "error" : "success", capText(input.actionState.notice.text)));
		}
		if (input.actionState.stopConfirming) {
			detailChildren.push(notice("warning", capText(input.actionState.stopConfirmMessage ?? "Confirm stop for the selected run? Stop ends the run; use interrupt for a resumable pause.")));
		} else if (!input.actionState.hasControls && input.actionState.controlsReason) {
			detailChildren.push(notice("info", capText(input.actionState.controlsReason)));
		}
		if (input.detail.transcriptTail !== undefined) {
			detailChildren.push({ type: "text", content: input.detail.transcriptTail || "(no transcript available)", log: true });
		}
		if (input.actionState.hasControls && !input.actionState.stopConfirming) {
			detailChildren.push({ type: "input", id: FLEET_WEB_ACTION_STEER, label: "Steer message", placeholder: "Message to the selected worker", submitLabel: "Send" });
		}
		detailChildren.push({ type: "actions", items: actionItems(input.actionState, true) });
	}

	const roster = input.roster.slice(0, FLEET_WEB_CAPS.maxRosterItems);
	const selectedId = input.selectedId !== undefined && roster.some((item) => item.id === input.selectedId)
		? input.selectedId
		: undefined;
	return {
		version: FLEET_WEB_VERSION,
		title: "Subagent fleet",
		layout: "workspace",
		root: {
			type: "section",
			children: [
				{ type: "list", items: roster, ...(selectedId !== undefined ? { selectedId } : {}) },
				{ type: "detail", ...(input.detail?.title ? { title: capLabel(input.detail.title) } : {}), children: detailChildren },
			],
		},
	};
}
