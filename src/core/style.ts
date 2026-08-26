import pc from "picocolors";

const NAME_COLORS = [
	pc.cyan,
	pc.magenta,
	pc.yellow,
	pc.green,
	pc.blue,
	pc.white,
] as const;

const URL_IN_LINE = /https?:\/\/[^\s]+/g;
const LOG_LEVEL = /\[(?:INFO|WARN(?:ING)?|ERROR)\s*\]/gi;

function hashName(name: string): number {
	let hash = 0;
	for (let i = 0; i < name.length; i++) {
		hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
	}
	return hash;
}

function nameColor(name: string): (text: string) => string {
	return NAME_COLORS[hashName(name) % NAME_COLORS.length] ?? pc.cyan;
}

/** Bold, stable color for an app or service name. */
export function colorizeName(name: string): string {
	return pc.bold(nameColor(name)(name));
}

export function joinColoredNames(names: string[]): string {
	return names.map((name) => colorizeName(name)).join(pc.dim(", "));
}

export function formatUrl(url: string): string {
	return pc.cyan(
		url.replace(/:(\d+)(\/?)/, (_, port, slash) => `:${pc.bold(port)}${slash}`),
	);
}

/** OSC 8 hyperlink so the full URI is clickable (query strings included). */
export function formatHyperlink(url: string, label = url): string {
	return `\u001b]8;;${url}\u001b\\${label}\u001b]8;;\u001b\\`;
}

/** Clickable cyan URL without injecting ANSI into the middle of the href. */
export function formatClickableUrl(url: string): string {
	return formatHyperlink(url, pc.cyan(url));
}

/** Log only if the step is still running after `delayMs` (reload stays quiet). */
export const SLOW_STEP_MS = 800;

export function scheduleLog(delayMs: number, write: () => void): () => void {
	const timer = setTimeout(write, delayMs);
	timer.unref?.();
	return () => clearTimeout(timer);
}

export function highlightLogLine(line: string): string {
	return line.replace(URL_IN_LINE, formatUrl).replace(LOG_LEVEL, (match) => {
		const kind = match.toUpperCase();
		if (kind.includes("ERROR")) return pc.red(pc.bold(match));
		if (kind.includes("WARN")) return pc.yellow(match);
		return pc.dim(match);
	});
}

export function prefixWidth(names: string[]): number {
	return names.reduce((max, name) => Math.max(max, name.length), 0);
}

/**
 * One live log line, matching the environment banner: green arrow, colored name.
 */
export function isBlankLogLine(line: string): boolean {
	return line.trim().length === 0;
}

export function formatPrefixedLine(
	name: string,
	line: string,
	width = name.length,
): string {
	const pad = " ".repeat(Math.max(0, width - name.length));
	return `  ${pc.green("➜")}  ${colorizeName(name)}${pad}  ${highlightLogLine(line)}\n`;
}

export function formatSection(title: string): string {
	return `  ${pc.dim(`─── ${title} ───`)}`;
}

export function formatStep(message: string): string {
	return `  ${message}`;
}

export function formatDone(message: string): string {
	return `  ${pc.green("✓")}  ${message}`;
}

export function formatWait(message: string): string {
	return `  ${pc.dim("⏳")}  ${message}`;
}

export function formatWarn(message: string): string {
	return `  ${pc.yellow("⚠")}  ${message}`;
}

export function formatFail(message: string): string {
	return `  ${pc.red("❌")} ${message}`;
}

export function formatPidLine(
	name: string,
	pid: number,
	width = name.length,
): string {
	const pad = " ".repeat(Math.max(0, width - name.length));
	return `     ${colorizeName(name)}${pad}  ${pc.dim(`PID: ${pid}`)}`;
}
