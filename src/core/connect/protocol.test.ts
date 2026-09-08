import { expect, test } from "bun:test";
import { parseDirectory, parseSnapshot } from "./protocol";

const fixture = await Bun.file(
	new URL("../../../menubar/fixtures/connect.v1.json", import.meta.url),
).json();
test("Swift/TypeScript shared directory contract preserves branch, primary and TCP targets", () => {
	const value = parseDirectory(fixture, "fixture-device", fixture.generatedAt);
	expect(value.runs[0].branch).toBe("feature/checkout");
	expect(value.runs[0].targets[1].protocol).toBe("tcp");
});
test("rejects stale, cross-recipient, unsafe and ambiguous snapshots", () => {
	expect(() => parseDirectory(fixture, "other", fixture.generatedAt)).toThrow();
	expect(() =>
		parseDirectory(fixture, "fixture-device", fixture.generatedAt + 180000),
	).toThrow();
	for (const endpoint of [
		"https://evil.example",
		"https://a.trycloudflare.com@evil.example",
		"http://a.trycloudflare.com",
		"https://a.trycloudflare.com/private",
		"https://a.trycloudflare.com?secret=1",
	])
		expect(() => parseSnapshot({ ...fixture.runs[0], endpoint })).toThrow();
	expect(() =>
		parseSnapshot({
			...fixture.runs[0],
			targets: [fixture.runs[0].targets[0], fixture.runs[0].targets[0]],
		}),
	).toThrow();
});

test("bounds and cancels directory response bodies with or without a length header", async () => {
	const { jsonBody, MAX_BODY } = await import("./protocol");
	for (const declared of [false, true]) {
		let cancelled = false;
		const response = new Response(
			new ReadableStream<Uint8Array>({
				pull(controller) {
					controller.enqueue(new Uint8Array(MAX_BODY + 1));
				},
				cancel() {
					cancelled = true;
				},
			}),
			{ headers: declared ? { "content-length": String(MAX_BODY + 1) } : {} },
		);
		await expect(jsonBody(response)).rejects.toThrow("Document too large");
		expect(cancelled).toBe(true);
	}
});
