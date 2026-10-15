import { describe, expect, it } from "bun:test";
import { portableEnvFingerprint } from "./env-fingerprint";

const checkout = (n: number) => ({
	vars: {
		API_URL: `http://192.168.1.${n}:${12500 + n}`,
		COMPOSE_PROJECT_NAME: `shop-app-e2e-runner-${n}`,
		BUNCARGO_WORKSPACE_ID: `abc${n}`,
		STATE_DIR: `/home/runner/shop-${n}/_work/app/.cache`,
		VITE_FLAG: "on",
	},
	specific: {
		ports: [12500 + n],
		names: [
			`shop-app-e2e-runner-${n}`,
			`abc${n}`,
			`/home/runner/shop-${n}/_work/app`,
		],
	},
});

describe("portableEnvFingerprint", () => {
	it("is the same for two checkouts that differ only in their own values", () => {
		const one = checkout(1);
		const two = checkout(2);
		expect(portableEnvFingerprint(one.vars, one.specific)).toBe(
			portableEnvFingerprint(two.vars, two.specific),
		);
	});

	it("changes when any other value changes", () => {
		const one = checkout(1);
		const changed = { ...one.vars, VITE_FLAG: "off" };
		expect(portableEnvFingerprint(changed, one.specific)).not.toBe(
			portableEnvFingerprint(one.vars, one.specific),
		);
	});

	it("blanks a port only as a whole number", () => {
		const specific = { ports: [1250], names: [] };
		expect(portableEnvFingerprint({ A: "x:12501" }, specific)).not.toBe(
			portableEnvFingerprint({ A: "x:12502" }, specific),
		);
	});
});
