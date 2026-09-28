import type { CaptureConfig } from "../../types";

/**
 * Picking values out of an app's output as it streams.
 *
 * TUIs like Shopify CLI draw with colour codes and box-drawing characters, and
 * a value can straddle two chunks, so the scanner strips both and matches
 * complete lines from a tail of recent output rather than chunks on their
 * own. A value is reported when it first appears and again whenever it
 * changes (a restarted tunnel prints a new URL), never twice in a row.
 */

/** Longest value worth waiting for across chunk boundaries. */
const TAIL_BYTES = 16 * 1024;

const ANSI =
	// CSI sequences, OSC sequences (terminated by BEL or ST), and lone escapes.
	// biome-ignore lint/suspicious/noControlCharactersInRegex: that is the point
	/\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;
const BOX_DRAWING = /[─-╿▀-▟]/g;

/** Output as a person reads it: no escapes, no frame, one line per `\r`. */
export function stripTerminalOutput(text: string): string {
	return text
		.replace(ANSI, "")
		.replace(BOX_DRAWING, " ")
		.replace(/\r\n?/g, "\n");
}

/** A URL's origin, or undefined for anything that is not an http(s) URL. */
export function normalizeOrigin(value: string): string | undefined {
	try {
		const url = new URL(value.trim());
		return url.protocol === "https:" || url.protocol === "http:"
			? url.origin
			: undefined;
	} catch {
		return undefined;
	}
}

export interface CapturedValue {
	name: string;
	value: string;
	as: CaptureConfig["as"];
}

interface OutputCaptureScanner {
	/** Feed raw output; returns the values that appeared or changed. */
	push(chunk: string): CapturedValue[];
}

function lastMatch(pattern: RegExp, text: string): string | undefined {
	// A fresh global copy: the caller's regex may be sticky, global or neither,
	// and its `lastIndex` is theirs.
	const global = new RegExp(
		pattern.source,
		pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`,
	);
	let found: string | undefined;
	for (const match of text.matchAll(global)) {
		found = match[1] ?? match[0];
	}
	return found;
}

export function createOutputCaptureScanner(
	captures: Readonly<Record<string, CaptureConfig>>,
): OutputCaptureScanner {
	const reported = new Map<string, string>();
	let tail = "";
	// Only whole lines are matched: a URL cut off mid-chunk is still a valid
	// URL, and reporting it would render files and restart apps with it.
	let partial = "";

	return {
		push(chunk) {
			const text = `${partial}${stripTerminalOutput(chunk)}`;
			const end = text.lastIndexOf("\n") + 1;
			partial = text.slice(end).slice(-TAIL_BYTES);
			if (end === 0) return [];
			tail = `${tail}${text.slice(0, end)}`.slice(-TAIL_BYTES);
			const found: CapturedValue[] = [];
			for (const [name, capture] of Object.entries(captures)) {
				const raw = lastMatch(capture.pattern, tail);
				if (raw === undefined) continue;
				const value =
					capture.as === "publicUrl" ? normalizeOrigin(raw) : raw.trim();
				// An event fires once per occurrence; a value only when it changes.
				if (value === undefined) continue;
				if (capture.as !== "event" && reported.get(name) === value) continue;
				reported.set(name, value);
				found.push({ name, value, as: capture.as });
			}
			// Events are consumed, so the same line is not reported again when
			// the next chunk arrives and the tail still contains it.
			if (found.some((entry) => entry.as === "event")) tail = "";
			return found;
		},
	};
}
