import { describe, expect, it } from "bun:test";
import pc from "picocolors";
import {
	formatHyperlink,
	formatPrefixedLine,
	highlightLogLine,
	isBlankLogLine,
	prefixWidth,
	scheduleLog,
} from "./style";

function visible(text: string): string {
	const ansi = String.fromCharCode(27);
	return text.split(ansi).reduce((out, part, index) => {
		if (index === 0) return part;
		const end = part.indexOf("m");
		return end === -1 ? `${out}${part}` : `${out}${part.slice(end + 1)}`;
	}, "");
}

describe("prefixWidth", () => {
	it("uses the longest name", () => {
		expect(prefixWidth(["api", "platform"])).toBe(8);
		expect(prefixWidth([])).toBe(0);
	});
});

describe("formatPrefixedLine", () => {
	it("aligns names and keeps the banner layout", () => {
		const width = prefixWidth(["api", "platform"]);
		expect(visible(formatPrefixedLine("api", "$ bun run", width))).toBe(
			"  ➜  api       $ bun run\n",
		);
		expect(visible(formatPrefixedLine("platform", "$ bunx vite", width))).toBe(
			"  ➜  platform  $ bunx vite\n",
		);
	});

	it("treats whitespace-only lines as blank", () => {
		expect(isBlankLogLine("")).toBe(true);
		expect(isBlankLogLine("   ")).toBe(true);
		expect(isBlankLogLine("$ vite")).toBe(false);
	});

	it("highlights URLs and log levels in the line body", () => {
		const line = highlightLogLine(
			"[INFO ] listening on http://localhost:11700/",
		);
		// Asserted on the stripped text, not the raw string. Highlighting puts
		// the port in its own colour, so with colour on the URL is literally
		// `…localhost:<esc>11700<esc>/` and never appears as one substring —
		// which is why asserting `line.toContain(url)` passed through a pipe and
		// failed on a runner that advertises colour support.
		expect(visible(line)).toBe("[INFO ] listening on http://localhost:11700/");
		expect(visible(line)).toContain("http://localhost:11700/");
		if (pc.isColorSupported) {
			expect(line).not.toBe(visible(line));
		}
	});
});

describe("formatHyperlink", () => {
	it("wraps the full URI in OSC 8 so query strings stay one click target", () => {
		const url =
			"postgresql://postgres@127.0.0.1:5432/db?env=development&name=app";
		const link = formatHyperlink(url, "open");
		expect(link.startsWith("\u001b]8;;")).toBe(true);
		expect(link).toContain(url);
		expect(link).toContain("open");
		expect(link.endsWith("\u001b]8;;\u001b\\")).toBe(true);
	});
});

describe("scheduleLog", () => {
	it("does not write when cancelled before the delay", async () => {
		let fired = false;
		const cancel = scheduleLog(40, () => {
			fired = true;
		});
		cancel();
		await Bun.sleep(60);
		expect(fired).toBe(false);
	});
});
