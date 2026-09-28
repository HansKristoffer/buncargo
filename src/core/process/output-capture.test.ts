import { describe, expect, it } from "bun:test";
import {
	createOutputCaptureScanner,
	normalizeOrigin,
	stripTerminalOutput,
} from "./output-capture";

// What Shopify CLI actually prints: colour codes and a box around the line.
const SHOPIFY_LINE =
	"\u001b[1m│\u001b[22m Using URL: \u001b[36mhttps://abc-def.trycloudflare.com\u001b[39m │\r\n";

describe("stripTerminalOutput", () => {
	it("removes colour codes and box drawing", () => {
		expect(stripTerminalOutput(SHOPIFY_LINE)).toBe(
			"  Using URL: https://abc-def.trycloudflare.com  \n",
		);
	});
});

describe("normalizeOrigin", () => {
	it("keeps only the origin of an http(s) URL", () => {
		expect(normalizeOrigin("https://abc.trycloudflare.com/api/rpc/")).toBe(
			"https://abc.trycloudflare.com",
		);
		expect(normalizeOrigin("ftp://nope")).toBeUndefined();
		expect(normalizeOrigin("not a url")).toBeUndefined();
	});
});

describe("createOutputCaptureScanner", () => {
	const captures = {
		appUrl: {
			pattern: /Using URL:\s*(https:\/\/[^\s|)]+)/,
			as: "publicUrl" as const,
		},
		ready: {
			pattern: /Ready, watching for changes in your app/,
			as: "event" as const,
		},
	};

	it("captures a URL printed inside a TUI frame", () => {
		const scanner = createOutputCaptureScanner(captures);
		expect(scanner.push(SHOPIFY_LINE)).toEqual([
			{
				name: "appUrl",
				value: "https://abc-def.trycloudflare.com",
				as: "publicUrl",
			},
		]);
	});

	it("joins a value split across chunks", () => {
		const scanner = createOutputCaptureScanner(captures);
		// A prefix of the host is a valid URL too, so nothing is reported
		// until the line is complete.
		expect(scanner.push("Using URL: https://abc-de")).toEqual([]);
		expect(scanner.push("f.trycloudflare.com\n")).toEqual([
			{
				name: "appUrl",
				value: "https://abc-def.trycloudflare.com",
				as: "publicUrl",
			},
		]);
	});

	it("reports a value once, and again only when it changes", () => {
		const scanner = createOutputCaptureScanner(captures);
		scanner.push("Using URL: https://one.example\n");
		expect(scanner.push("Using URL: https://one.example/api/rpc\n")).toEqual(
			[],
		);
		expect(scanner.push("Using URL: https://two.example\n")).toEqual([
			{ name: "appUrl", value: "https://two.example", as: "publicUrl" },
		]);
	});

	it("fires an event on every occurrence, not on every chunk", () => {
		const scanner = createOutputCaptureScanner(captures);
		const line = "✅ Ready, watching for changes in your app\n";
		expect(scanner.push(line).map((entry) => entry.name)).toEqual(["ready"]);
		expect(scanner.push("unrelated\n")).toEqual([]);
		expect(scanner.push(line).map((entry) => entry.name)).toEqual(["ready"]);
	});

	it("uses the whole match when the pattern has no group", () => {
		const scanner = createOutputCaptureScanner({
			build: { pattern: /build [0-9]+/, as: "value" },
		});
		expect(scanner.push("started build 42\n")).toEqual([
			{ name: "build", value: "build 42", as: "value" },
		]);
	});
});
