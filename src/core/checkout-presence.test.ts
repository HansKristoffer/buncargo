import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkoutPresence } from "./checkout-presence";
import { unreadableCheckout } from "./checkout-presence.testing";

const dir = mkdtempSync(join(tmpdir(), "buncargo-presence-"));
const unreadable = unreadableCheckout();

afterAll(() => {
	rmSync(dir, { recursive: true, force: true });
	unreadable?.cleanup();
});

describe("checkoutPresence", () => {
	it("tells a directory that is there from one that is gone", () => {
		expect(checkoutPresence(dir)).toBe("present");
		expect(checkoutPresence(join(dir, "deleted"))).toBe("deleted");
	});

	it.skipIf(!unreadable)(
		"reads a checkout it is not allowed to see as unknown, not deleted",
		() => {
			expect(checkoutPresence(unreadable?.root ?? "")).toBe("unknown");
			expect(checkoutPresence(join(unreadable?.root ?? "", "deeper"))).toBe(
				"unknown",
			);
		},
	);

	it("reads an empty root as unknown", () => {
		expect(checkoutPresence("")).toBe("unknown");
	});
});
