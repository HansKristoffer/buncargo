import { describe, expect, it } from "bun:test";
import { createThrottledFailureLog } from "./failure-log";

describe("createThrottledFailureLog", () => {
	function harness(intervalMs = 1000) {
		const lines: string[] = [];
		let now = 0;
		const log = createThrottledFailureLog({
			log: (message) => lines.push(message),
			now: () => now,
			intervalMs,
		});
		return {
			lines,
			log,
			advance: (ms: number) => {
				now += ms;
			},
		};
	}

	it("reports the first failure immediately", () => {
		const { lines, log } = harness();
		log.report("reload failed: a");
		expect(lines).toEqual(["reload failed: a"]);
	});

	// The point of the throttle: a certificate gap names the hostnames it is
	// missing, so identical-message filtering alone lets every route change
	// through.
	it("suppresses distinct causes inside the interval", () => {
		const { lines, log, advance } = harness();
		log.report("reload failed: missing a");
		advance(100);
		log.report("reload failed: missing a, b");
		advance(100);
		log.report("reload failed: missing a, b, c");
		expect(lines).toEqual(["reload failed: missing a"]);
	});

	it("reports again after the interval and counts what it dropped", () => {
		const { lines, log, advance } = harness();
		log.report("reload failed: a");
		advance(400);
		log.report("reload failed: a");
		advance(400);
		log.report("reload failed: a");
		advance(400);
		log.report("reload failed: a");
		expect(lines).toEqual([
			"reload failed: a",
			"reload failed: a (2 further failures suppressed)",
		]);
	});

	it("singularizes a single suppressed failure", () => {
		const { lines, log, advance } = harness();
		log.report("reload failed: a");
		advance(500);
		log.report("reload failed: a");
		advance(600);
		log.report("reload failed: a");
		expect(lines[1]).toBe("reload failed: a (1 further failure suppressed)");
	});

	// A recovery is a state change worth seeing straight away, so the next
	// failure must not be swallowed by the interval the old one started.
	it("reports the next failure immediately after a reset", () => {
		const { lines, log, advance } = harness();
		log.report("reload failed: a");
		advance(10);
		log.reset();
		log.report("reload failed: b");
		expect(lines).toEqual(["reload failed: a", "reload failed: b"]);
	});
});
