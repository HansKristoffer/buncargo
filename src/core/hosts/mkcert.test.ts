import { describe, expect, it } from "bun:test";
import { certificateShortfall } from "./mkcert";

describe("certificateShortfall", () => {
	const now = Date.parse("2026-10-17T00:00:00Z");
	const day = 24 * 60 * 60 * 1000;
	const leaf = (names: string[], validTo = now + 365 * day) => ({
		names: new Set(names),
		validTo,
	});

	it("is satisfied by a covering certificate far from expiry", () => {
		expect(
			certificateShortfall(
				leaf(["*.app.localhost"]),
				["web.app.localhost"],
				now,
			),
		).toBeUndefined();
	});

	it("lists only the hostnames the certificate lacks", () => {
		expect(
			certificateShortfall(
				leaf(["web.app.localhost"]),
				["web.app.localhost", "api.other.localhost"],
				now,
			),
		).toEqual({ kind: "uncovered", hostnames: ["api.other.localhost"] });
	});

	it("reports expiry inside the renewal window separately", () => {
		const validTo = now + 5 * day;
		expect(
			certificateShortfall(
				leaf(["web.app.localhost"], validTo),
				["web.app.localhost"],
				now,
			),
		).toEqual({ kind: "expiring", validTo });
	});
});
