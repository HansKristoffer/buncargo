import { describe, expect, it } from "bun:test";
import {
	acceptTakeover,
	initialTakeover,
	shouldOfferTakeover,
	type TakeoverDecision,
	takesOver,
} from "./dev-takeover";

describe("the takeover decision", () => {
	it("covers every app with --takeover and only the accepted ones without", () => {
		expect(takesOver(initialTakeover(true), "api")).toBe(true);
		const none = initialTakeover(false);
		expect(takesOver(none, "api")).toBe(false);
		const accepted = acceptTakeover(none, ["api"]);
		expect(takesOver(accepted, "api")).toBe(true);
		expect(takesOver(accepted, "web")).toBe(false);
		expect(takesOver(acceptTakeover(accepted, ["web"]), "api")).toBe(true);
	});

	const offer = (
		overrides: Partial<Parameters<typeof shouldOfferTakeover>[0]> = {},
	) =>
		shouldOfferTakeover({
			decision: { kind: "none" } as TakeoverDecision,
			nothingToSpawn: true,
			candidates: 1,
			pendingTunnels: false,
			inheritsPublicUrls: false,
			sharing: false,
			...overrides,
		});

	it("offers it when every selected app runs elsewhere", () => {
		expect(offer()).toBe(true);
	});

	it("does not offer what would stop the tunnels its public URLs come from", () => {
		expect(offer({ inheritsPublicUrls: true })).toBe(false);
	});

	it("does not offer it with nothing to take over or work of its own", () => {
		expect(offer({ candidates: 0 })).toBe(false);
		expect(offer({ nothingToSpawn: false })).toBe(false);
		expect(offer({ pendingTunnels: true })).toBe(false);
		expect(offer({ sharing: true })).toBe(false);
		expect(offer({ decision: { kind: "all" } })).toBe(false);
	});
});
