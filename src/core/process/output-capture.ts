import type { CaptureConfig } from "../../types";

/**
 * Picking values out of an app's output as it streams.
 *
 * TUIs like Shopify CLI draw with colour codes and box-drawing characters, and
 * a value can straddle two chunks, so the scanner strips both and matches
 * complete lines from a tail of recent output rather than chunks on their
 * own. A value is reported when it first appears and again whenever it
 * changes (a restarted tunnel prints a new URL), never twice in a row.
 *
 * A URL wider than the terminal is wrapped onto the next row by the program
 * itself (Ink does), so rows that continue a URL are joined back onto it
 * before matching, and a URL that cannot be whole is not reported as one.
 */

/** Longest value worth waiting for across chunk boundaries. */
const TAIL_BYTES = 16 * 1024;

const ANSI =
	// CSI sequences, OSC sequences (terminated by BEL or ST), and lone escapes.
	// biome-ignore lint/suspicious/noControlCharactersInRegex: that is the point
	/\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;
const BOX_DRAWING = /[─-╿▀-▟]/g;
/** Cursor jumps and screen erases: a redraw starts a new line there. */
const CURSOR_JUMP =
	// biome-ignore lint/suspicious/noControlCharactersInRegex: that is the point
	/\u001b\[[0-9;?]*[ABEFHJf]/g;
/** An OSC 8 hyperlink: its target, then its text. */
const HYPERLINK =
	// biome-ignore lint/suspicious/noControlCharactersInRegex: that is the point
	/\u001b\]8;[^;\u0007\u001b]*;([^\u0007\u001b]*)(?:\u0007|\u001b\\)([\s\S]*?)\u001b\]8;;(?:\u0007|\u001b\\)/g;

/**
 * Output as a person reads it: no escapes, no frame, one line per `\r`.
 *
 * A hyperlink becomes its target, not its text: a TUI's "Preview" link
 * carries the URL only in the escape, and a long URL's text is often cut off.
 */
export function stripTerminalOutput(text: string): string {
	return text
		.replace(HYPERLINK, (_, target: string, label: string) => target || label)
		.replace(CURSOR_JUMP, "\n")
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

const UNCLOSED_LINK =
	// biome-ignore lint/suspicious/noControlCharactersInRegex: that is the point
	/\u001b\]8;[^;\u0007\u001b]*;[^\u0007\u001b]+(?:\u0007|\u001b\\)(?![\s\S]*\u001b\]8;;(?:\u0007|\u001b\\))/;
const UNFINISHED_ESCAPE =
	// biome-ignore lint/suspicious/noControlCharactersInRegex: that is the point
	/\u001b(?:\][^\u0007\u001b]*\u001b?|\[[0-9;?]*[ -/]*)?$/;

/** Where an escape sequence the chunk did not finish starts, or -1. */
export function openEscapeAt(raw: string): number {
	const link = raw.search(UNCLOSED_LINK);
	if (link !== -1) return link;
	return raw.search(UNFINISHED_ESCAPE);
}

/**
 * Characters a wrapped URL continues with. Narrower than RFC 3986: no
 * parentheses, quotes, commas or semicolons, which end a URL in prose far more
 * often than they continue one.
 */
const URL_CONTINUATION = /^[\w\-.~:/?#[\]@!$&*+=%]+/;
/** A line ending in a URL: the token, then only padding (box frames are spaces by now). */
const TRAILING_URL = /(\S*:\/\/[^\s|]*)[\s|]*$/;
/** Leading padding of a continuation row: spaces, and `|` column separators. */
const ROW_PADDING = /^[\s|]*/;
/** A capitalised word on its own is the next line of prose, not a URL's tail. */
const PROSE_WORD = /^[A-Za-z]*[A-Z][A-Za-z]*$/;

/**
 * Tunnel domains a cut-off host can look complete inside of:
 * `https://a-b.trycloudflare` parses, and has a dot, but is not the tunnel.
 */
const TUNNEL_SUFFIXES = [
	"trycloudflare.com",
	"ngrok-free.app",
	"ngrok.app",
	"ngrok.io",
	"loca.lt",
];

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const TLD = /^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/i;

/**
 * Whether a URL could be whole, rather than the first row of one a terminal
 * wrapped. Its host must be `localhost`, an IP, or a dotted name ending in a
 * plausible TLD, and not end part-way through a known tunnel domain. A single
 * label is a cut more often than a host: no public URL has one.
 */
export function looksLikeCompleteUrl(value: string): boolean {
	const raw = value.trim();
	// `scheme://authority`, up to the first `/`, `?` or `#`.
	const authority = /^https?:\/\/([^/?#]*)/i.exec(raw)?.[1];
	if (authority === undefined || /[.:-]$/.test(authority)) return false;
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return false;
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") return false;

	const host = url.hostname.toLowerCase();
	if (host === "localhost" || host.startsWith("[")) return true;
	// Read from the raw text: `new URL("http://127.0.0")` fills in the rest.
	const rawHost = authority.replace(/^.*@/, "").replace(/:\d*$/, "");
	if (/^[\d.]+$/.test(rawHost)) return IPV4.test(rawHost);

	const labels = host.split(".");
	if (
		labels.length < 2 ||
		labels.some((label) => !label || label.endsWith("-"))
	)
		return false;
	if (!TLD.test(labels.at(-1) ?? "")) return false;
	for (const suffix of TUNNEL_SUFFIXES) {
		if (host.endsWith(`.${suffix}`)) continue;
		// Ends part-way through the suffix: `.trycloudflare`, `.trycloudflare.co`.
		for (let cut = 1; cut < suffix.length; cut++) {
			if (host.endsWith(`.${suffix.slice(0, cut)}`)) return false;
		}
	}
	return true;
}

/**
 * Put back together URLs a terminal wrapped onto the next row.
 *
 * Ink (Shopify CLI's renderer) wraps to the terminal's width with hard
 * newlines, and a TUI pane is narrow, so a tunnel URL arrives as
 * `Using URL: https://a-b.trycloudfl` and, a row later, `are.com`, each padded
 * by the frame and the log's columns. A row is joined to the line above when
 * that line ends in a URL and the row starts with what can continue one: the
 * whole row when it is a single token (`are.com`), or its first token when
 * the URL above cannot be complete without it. Nothing else is touched.
 */
export function joinWrappedUrls(text: string): string {
	const joined: string[] = [];
	for (const line of text.split("\n")) {
		const previous = joined.at(-1);
		const url =
			previous === undefined ? undefined : TRAILING_URL.exec(previous);
		const content = line.replace(ROW_PADDING, "");
		const token = URL_CONTINUATION.exec(content)?.[0];
		if (previous !== undefined && url?.[1] && token && !token.includes("://")) {
			const wholeRow = token === content.trimEnd();
			const incomplete = !looksLikeCompleteUrl(url[1]);
			if (incomplete || (wholeRow && !PROSE_WORD.test(token))) {
				joined[joined.length - 1] =
					previous.slice(0, url.index + url[1].length) + content;
				continue;
			}
		}
		joined.push(line);
	}
	return joined.join("\n");
}

interface Match {
	value: string;
	/** Where the value ends in the scanned text. */
	end: number;
	/** Where the whole match ends. */
	matchEnd: number;
}

/**
 * The last match worth reporting.
 *
 * A URL that ends the newest complete line may continue on a row that has
 * not arrived yet; while it cannot be complete it waits for that row rather
 * than being reported cut off. A public URL is only ever taken whole: a cut
 * one would render files and restart apps with a host that does not exist.
 */
function lastMatch(capture: CaptureConfig, text: string): Match | undefined {
	// A fresh global copy with indices: the caller's regex may be sticky,
	// global or neither, and its `lastIndex` is theirs.
	let flags = capture.pattern.flags;
	if (!flags.includes("g")) flags += "g";
	if (!flags.includes("d")) flags += "d";
	const global = new RegExp(capture.pattern.source, flags);
	let found: Match | undefined;
	for (const match of text.matchAll(global)) {
		const group = match[1] === undefined ? 0 : 1;
		const value = match[group] ?? match[0];
		const end = match.indices?.[group]?.[1] ?? match.index + match[0].length;
		if (
			capture.as !== "event" &&
			/^https?:\/\//i.test(value.trim()) &&
			!looksLikeCompleteUrl(value)
		) {
			if (capture.as === "publicUrl") continue;
			if (/^[ \t|]*\n?$/.test(text.slice(end))) continue;
		}
		found = { value, end, matchEnd: match.index + match[0].length };
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

	// Raw output held back because an escape is still open at the chunk's end:
	// stripped half-way, a hyperlink would lose the URL it carries.
	let held = "";

	return {
		push(chunk) {
			const raw = `${held}${chunk}`;
			// A `\r` ending the chunk may be half of a `\r\n`: read alone it is a
			// line break of its own, and the blank line after it would keep a
			// wrapped URL's rows apart.
			const open = openEscapeAt(raw);
			const cut = open === -1 && raw.endsWith("\r") ? raw.length - 1 : open;
			held = cut === -1 ? "" : raw.slice(cut).slice(-TAIL_BYTES);
			const text = `${partial}${stripTerminalOutput(cut === -1 ? raw : raw.slice(0, cut))}`;
			const end = text.lastIndexOf("\n") + 1;
			partial = text.slice(end).slice(-TAIL_BYTES);
			if (end === 0) return [];
			// Kept joined: a row continuing a URL is joined once, and the rest
			// of the tail is already in that form when the next row arrives.
			tail = joinWrappedUrls(`${tail}${text.slice(0, end)}`).slice(-TAIL_BYTES);
			const found: CapturedValue[] = [];
			let consumed = 0;
			for (const [name, capture] of Object.entries(captures)) {
				const match = lastMatch(capture, tail);
				if (match === undefined) continue;
				const value =
					capture.as === "publicUrl"
						? normalizeOrigin(match.value)
						: match.value.trim();
				// An event fires once per occurrence; a value only when it changes,
				// which is also how a later, complete URL replaces a cut-off one.
				if (value === undefined) continue;
				if (capture.as === "event")
					consumed = Math.max(consumed, match.matchEnd);
				else if (reported.get(name) === value) continue;
				reported.set(name, value);
				found.push({ name, value, as: capture.as });
			}
			// Events are consumed, so the same line is not reported again when
			// the next chunk arrives and the tail still contains it. Only up to
			// the event: a URL row after it may still be waiting for its tail.
			if (consumed > 0) tail = tail.slice(consumed);
			return found;
		},
	};
}
