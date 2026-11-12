import { expect, it } from "bun:test";
import { migrationChainProblems } from "./migration-chain";

// Two branches that each ran `migration new` in the same second.
it("reports migrations sharing a timestamp", () => {
	expect(
		migrationChainProblems(
			["20250101000000_init", "20250301000000_orders", "20250301000000_users"],
			["20250101000000_init"],
			"main",
		),
	).toEqual([
		"20250301000000_orders and 20250301000000_users share the timestamp 20250301000000",
	]);
});
