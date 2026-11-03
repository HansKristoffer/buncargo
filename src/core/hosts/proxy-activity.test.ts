import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createProxyActivityRecorder,
	PROXY_ACTIVITY_WRITE_MS,
	type ProxyActivity,
	readProxyActivity,
	writeProxyActivity,
} from "./proxy-activity";

const dir = mkdtempSync(join(tmpdir(), "buncargo-proxy-activity-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

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

	it("writes requests at most once a minute, and nothing when none came", async () => {
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
	});
});

describe("writeProxyActivity", () => {
	it("merges with what an earlier daemon wrote, keeping the newest time per checkout", async () => {
		const path = join(dir, "merge.json");
		expect(readProxyActivity(path)).toBeUndefined();
		const now = Date.parse("2026-11-03T12:00:00.000Z");
		await writeProxyActivity(
			new Map([
				["/a", now - 5_000],
				["/b", now - 5_000],
			]),
			now,
			path,
		);
		await writeProxyActivity(new Map([["/a", now]]), now, path);
		expect(readProxyActivity(path)).toEqual(
			new Map([
				["/a", now],
				["/b", now - 5_000],
			]),
		);
	});
});
