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
	/** Conservative notice cap (final composed message): keeps the full
	 *  worst-case projection below the WebPanel payload byte cap even with
	 *  several prefixed notices present at once. */
	maxNoticeLength: 2000,
	/** Conservative roster cap: 36 fully-capped items plus a full detail pane
	 *  stay below the 64 KiB WebPanel payload limit with headroom. */
	maxRosterItems: 36,
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

/** Cap the final composed notice message to the projection's notice cap. */
export function capNotice(value: string): string {
	return value.length <= FLEET_WEB_CAPS.maxNoticeLength ? value : `${value.slice(0, FLEET_WEB_CAPS.maxNoticeLength - 1)}…`;
}

/** Strip ANSI/terminal escape sequences so no control codes cross the wire. */
const ANSI_PATTERN = /[\u001B\u009B][[\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*|[a-zA-Z\d]+(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;
/** C0/C1 control characters left over after escape-sequence stripping (tabs,
 *  newlines and carriage returns are legitimate content). */
const CONTROL_PATTERN = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F\x80-\x9F]/g;

export function stripAnsi(value: string): string {
	return value.replace(ANSI_PATTERN, "").replace(CONTROL_PATTERN, "");
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

function eventTailLines(event: FleetTranscriptEvent, expandedTools: boolean): string[] {
	if (event.kind === "tool") {
		const status = event.status === "running" ? "running" : event.status === "error" ? "error" : "done";
		// Tool name, args and error are transcript-derived: strip ANSI/control
		// sequences so a malicious transcript cannot smuggle them into the UI.
		const name = stripAnsi(event.name);
		const args = event.args ? ` ${stripAnsi(event.args)}` : "";
		const lines = [`● ${name}${args} (${status})`];
		// Command output is only surfaced when tools are expanded; the collapsed
		// view must not leak tool output (including bash output).
		if (expandedTools && event.output) {
			for (const outputLine of stripAnsi(event.output).replace(/\s+$/, "").split(/\r?\n/).slice(-8)) lines.push(`  ${outputLine}`);
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

function groupCharCount(group: string[]): number {
	return group.reduce((sum, line) => sum + line.length, 0);
}

/**
 * Build a bounded, plain-text, ANSI-free transcript tail for the web detail
 * pane. Message text is already clipped by readFleetTranscript; this function
 * additionally bounds lines and characters and always selects the NEWEST
 * activity first, so a busy transcript shows current work rather than stale
 * retained output. Included event groups keep their chronological order;
 * anything that cannot fit is dropped and visibly marked as omitted.
 */
export function plainTranscriptTail(transcript: FleetTranscript, options: FleetWebTailOptions = {}): string {
	const maxChars = Math.max(1, options.maxChars ?? FLEET_WEB_CAPS.maxTailChars);
	const maxLines = Math.max(1, options.maxLines ?? FLEET_WEB_CAPS.maxTailLines);
	const expandedTools = options.expandedTools === true;
	const marker = "↑ Earlier activity omitted";

	const eventGroups = transcript.events.map((event) => eventTailLines(event, expandedTools));

	// Reserve budget for the omission marker whenever it can be rendered; the
	// selection below always keeps the final text within both caps.
	const markerFits = 1 <= maxLines && marker.length + 1 <= maxChars;
	const contentMaxLines = maxLines - (markerFits ? 1 : 0);
	const contentMaxChars = maxChars - (markerFits ? marker.length + 1 : 0);

	// Select newest event groups first. Included groups stay in chronological
	// order; an oversized newest event keeps only its newest fitting lines so
	// the tail is never blanked by a single huge record.
	const kept: string[][] = [];
	let keptLines = 0;
	let keptChars = 0;
	for (let index = eventGroups.length - 1; index >= 0; index--) {
		const group = eventGroups[index];
		const groupChars = groupCharCount(group);
		const fitsWhole = keptLines + group.length <= contentMaxLines
			&& keptChars + groupChars + keptLines + group.length - 1 <= contentMaxChars;
		if (fitsWhole) {
			kept.unshift(group);
			keptLines += group.length;
			keptChars += groupChars;
			continue;
		}
		const partial: string[] = [];
		let partialChars = 0;
		for (let lineIndex = group.length - 1; lineIndex >= 0; lineIndex--) {
			const line = group[lineIndex];
			if (keptLines + partial.length + 1 > contentMaxLines
				|| keptChars + partialChars + line.length + keptLines + partial.length > contentMaxChars) break;
			partial.push(line);
			partialChars += line.length;
		}
		if (partial.length > 0) {
			kept.unshift(partial.reverse());
			keptLines += partial.length;
			keptChars += partialChars;
			break;
		}
		// No line of this group fits at all (oversized single record); keep
		// scanning older activity so the tail is never blanked.
	}

	const droppedEarlier = keptLines < eventGroups.reduce((sum, group) => sum + group.length, 0);
	const emitMarker = markerFits && (transcript.truncated || droppedEarlier);
	const parts = emitMarker ? [marker, ...kept.flat()] : kept.flat();
	return parts.join("\n");
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
	// While an action is pending, every control is disabled so no overlapping
	// action can be triggered from the projection.
	const busyDisabled = state.busy ? { disabled: true } : {};
	if (state.stopConfirming) {
		return [
			{ id: FLEET_WEB_ACTION_STOP_CANCEL, label: "Cancel", kind: "secondary", ...busyDisabled },
			{ id: FLEET_WEB_ACTION_STOP_CONFIRM, label: "Confirm stop", kind: "danger", ...busyDisabled },
		];
	}
	const items: FleetWebActionItem[] = [
		{ id: FLEET_WEB_ACTION_REFRESH, label: "Refresh", kind: "secondary", ...busyDisabled },
		{ id: FLEET_WEB_ACTION_TOOLS, label: state.expandedTools ? "Collapse tool output" : "Expand tool output", kind: "secondary", ...busyDisabled },
	];
	if (state.hasControls) {
		items.push({ id: FLEET_WEB_ACTION_STOP, label: "Stop", kind: "danger", ...busyDisabled });
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
	// Prefixed notices are capped on the FINAL composed message so the prefix
	// can never push the notice over the limit.
	if (input.scanError) detailChildren.push(notice("warning", capNotice(`Fleet scan warning: ${input.scanError}`)));
	if (!input.detail) {
		detailChildren.push(notice("info", capNotice(input.emptyMessage ?? "No current-session foreground or recent async children.")));
		detailChildren.push({ type: "actions", items: actionItems({ ...input.actionState, hasControls: false }, false) });
	} else {
		if (input.detail.metrics.length > 0) detailChildren.push({ type: "metrics", items: input.detail.metrics });
		if (input.detail.transcriptWarning) detailChildren.push(notice("warning", capNotice(input.detail.transcriptWarning)));
		if (input.actionState.busy) detailChildren.push(notice("info", "Action pending…"));
		if (input.actionState.notice) {
			detailChildren.push(notice(input.actionState.notice.isError ? "error" : "success", capNotice(input.actionState.notice.text)));
		}
		if (input.actionState.stopConfirming) {
			detailChildren.push(notice("warning", capNotice(input.actionState.stopConfirmMessage ?? "Confirm stop for the selected run? Stop ends the run; use interrupt for a resumable pause.")));
		} else if (!input.actionState.hasControls && input.actionState.controlsReason) {
			detailChildren.push(notice("info", capNotice(input.actionState.controlsReason)));
		}
		if (input.detail.transcriptTail !== undefined) {
			detailChildren.push({ type: "text", content: input.detail.transcriptTail || "(no transcript available)", log: true });
		}
		// The steer input is omitted entirely while an action is pending.
		if (input.actionState.hasControls && !input.actionState.stopConfirming && !input.actionState.busy) {
			detailChildren.push({ type: "input", id: FLEET_WEB_ACTION_STEER, label: "Steer message", placeholder: "Message to the selected worker", submitLabel: "Send" });
		}
		detailChildren.push({ type: "actions", items: actionItems(input.actionState, true) });
	}

	// Roster ids/titles/subtitles/statuses are capped and the roster itself is
	// clipped to a conservative item count so the serialized projection always
	// stays within the WebPanel payload byte cap.
	const roster = input.roster.slice(0, FLEET_WEB_CAPS.maxRosterItems).map((item) => ({
		id: capLabel(item.id),
		title: capLabel(item.title),
		...(item.subtitle !== undefined ? { subtitle: capLabel(item.subtitle) } : {}),
		...(item.status !== undefined ? { status: capLabel(item.status) } : {}),
	}));
	const cappedSelected = input.selectedId !== undefined ? capLabel(input.selectedId) : undefined;
	const selectedId = cappedSelected !== undefined && roster.some((item) => item.id === cappedSelected)
		? cappedSelected
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
