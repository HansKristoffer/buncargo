import { afterEach, describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import {
	createProxyActivityRecorder,
	getProxyActivityPath,
	PROXY_ACTIVITY_HEARTBEAT_MS,
	PROXY_ACTIVITY_WRITE_MS,
	type ProxyActivity,
	readProxyActivity,
	writeProxyActivity,
} from "./proxy-activity";

// The test preload gives the run a temporary HOME, so this is not the real file.
afterEach(() => rmSync(getProxyActivityPath(), { force: true }));

describe("createProxyActivityRecorder", () => {
	function harness() {
		let clock = 1_000_000;
		const writes: Array<Record<string, number>> = [];
		const recorder = createProxyActivityRecorder({
			write: async (seen: ProxyActivity) => {
				writes.push(Object.fromEntries(seen));
			},
			now: () => clock,
		});
		return {
			recorder,
			writes,
			advance: (ms: number) => {
				clock += ms;
			},
		};
	}

	it("writes once at start, so readers know requests are counted", async () => {
		const { recorder, writes } = harness();
		await recorder.flush();
		expect(writes).toEqual([{}]);
	});

	it("writes requests at most once a minute, and a heartbeat when none came", async () => {
		const { recorder, writes, advance } = harness();
		await recorder.flush();
		recorder.note("/repo");
		await recorder.flush();
		expect(writes).toHaveLength(1);

		advance(PROXY_ACTIVITY_WRITE_MS);
		await recorder.flush();
		expect(writes[1]).toEqual({ "/repo": 1_000_000 });

		advance(PROXY_ACTIVITY_WRITE_MS);
		await recorder.flush();
		expect(writes).toHaveLength(2);

		advance(PROXY_ACTIVITY_HEARTBEAT_MS);
		await recorder.flush();
		expect(writes).toEqual([{}, { "/repo": 1_000_000 }, {}]);
	});

	// Only the reload loop flushed. A loop that stalled lost every request
	// the proxy still served, and the file went stale for readers.
	it("writes a due request from the request path, without the reload loop", async () => {
		let clock = 1_000_000;
		const { promise: written, resolve } =
			Promise.withResolvers<Record<string, number>>();
		const writes: Array<Record<string, number>> = [];
		const recorder = createProxyActivityRecorder({
			write: async (seen: ProxyActivity) => {
				writes.push(Object.fromEntries(seen));
				if (seen.size > 0) resolve(Object.fromEntries(seen));
			},
			now: () => clock,
		});
		await recorder.flush();

		clock += PROXY_ACTIVITY_WRITE_MS;
		recorder.note("/repo");

		expect(await written).toEqual({ "/repo": clock });
		expect(writes).toHaveLength(2);
	});
});

describe("proxy-activity.json", () => {
	const now = Date.parse("2026-11-03T12:00:00.000Z");

	it("merges with what an earlier daemon wrote, keeping the newest time per checkout", async () => {
		expect(readProxyActivity(now)).toBeUndefined();
		await writeProxyActivity(
			new Map([
				["/a", now - 5_000],
				["/b", now - 5_000],
			]),
			now,
		);
		await writeProxyActivity(new Map([["/a", now]]), now);
		expect(readProxyActivity(now)).toEqual(
			new Map([
				["/a", now],
				["/b", now - 5_000],
			]),
		);
	});

	it("reads a file no daemon has rewritten for three heartbeats as nothing counting", async () => {
		// An older daemon put back by `hosts install` leaves the file as it
		// was; its old times would make a run in use look idle.
		await writeProxyActivity(new Map([["/a", now]]), now);
		const later = now + 3 * PROXY_ACTIVITY_HEARTBEAT_MS;
		expect(readProxyActivity(later - 1)).toBeDefined();
		expect(readProxyActivity(later)).toBeUndefined();
	});
});
