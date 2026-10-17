import { describe, expect, it, spyOn } from "bun:test";
import type { RemovalRecord } from "../core/removal-log";
import type { BuncargoContainer } from "../types";
import { explainMissingContainers, withLossNotice } from "./container-loss";

const SINCE = Date.parse("2026-10-17T09:30:00.000Z");
const NOW = Date.parse("2026-10-17T10:05:00.000Z");

const SWEPT: RemovalRecord = {
	at: "2026-10-17T10:00:00.000Z",
	projectName: "shop-ci",
	root: "/work/shop",
	runtime: "docker",
	reason: "owner gone for 16s",
	by: {
		command: "buncargo watchdog",
		pid: 4242,
		user: "ci",
		version: "12.4.0",
	},
};

function target(list: () => Partial<BuncargoContainer>[]) {
	return {
		projectName: "shop-ci",
		root: "/work/shop",
		runtime: {
			name: "docker" as const,
			list: list as () => BuncargoContainer[],
		},
		services: {
			db: { port: 5432 },
			cache: { port: 6379, serviceName: "redis" },
			unused: { port: 9000 },
		},
		selectedServiceKeys: ["db", "cache"],
	};
}

const deps = { now: NOW, records: () => [SWEPT] };

describe("explainMissingContainers", () => {
	it("says nothing while every selected container is there", () => {
		const present = target(() => [
			{ project: "shop-ci", service: "db" },
			{ project: "shop-ci", service: "redis" },
		]);
		expect(explainMissingContainers(present, SINCE, deps)).toBeUndefined();
	});

	it("names who removed them when one is missing", () => {
		const gone = target(() => [
			{ project: "shop-ci", service: "redis" },
			{ project: "shop", service: "db" },
		]);
		expect(explainMissingContainers(gone, SINCE, deps)).toBe(
			"buncargo's watchdog (pid 4242, user ci, buncargo 12.4.0) removed shop-ci's containers at 2026-10-17T10:00:00.000Z: owner gone for 16s",
		);
	});

	it("says nothing when the runtime does not answer", () => {
		const down = target(() => {
			throw new Error("Cannot connect to the Docker daemon");
		});
		expect(explainMissingContainers(down, SINCE, deps)).toBeUndefined();
	});
});

describe("withLossNotice", () => {
	it("prints the explanation and rethrows the original error", async () => {
		const warn = spyOn(console, "warn").mockImplementation(() => {});
		const refused = new Error("connect ECONNREFUSED 127.0.0.1:5432");
		try {
			await expect(
				withLossNotice(
					() => "the watchdog removed them",
					() => Promise.reject(refused),
				),
			).rejects.toBe(refused);
			expect(String(warn.mock.calls[0]?.[0])).toContain(
				"the watchdog removed them",
			);
		} finally {
			warn.mockRestore();
		}
	});

	it("does not look when the caller cancelled", async () => {
		let asked = false;
		const abort = new DOMException("aborted", "AbortError");
		await expect(
			withLossNotice(
				() => {
					asked = true;
					return undefined;
				},
				() => Promise.reject(abort),
			),
		).rejects.toBe(abort);
		expect(asked).toBe(false);
	});
});
