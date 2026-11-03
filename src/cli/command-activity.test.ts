import { afterAll, expect, it } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lastCheckoutCommandAt } from "../core/run-activity";

const BIN = join(import.meta.dir, "bin.ts");
const checkout = realpathSync(
	mkdtempSync(join(tmpdir(), "buncargo-activity-")),
);
afterAll(() => rmSync(checkout, { recursive: true, force: true }));

it("counts a command run from a subdirectory against the checkout its run records", () => {
	// A detached run's idle limit reads this; the root is where `dev.config.ts`
	// resolves, not the working directory.
	writeFileSync(join(checkout, "dev.config.ts"), "export default {};\n");
	mkdirSync(join(checkout, ".buncargo"));
	const nested = join(checkout, "apps", "web");
	mkdirSync(nested, { recursive: true });

	const before = Date.now();
	const result = Bun.spawnSync([process.execPath, BIN, "runs"], {
		cwd: nested,
		env: process.env,
	});
	expect(result.exitCode).toBe(0);
	expect(lastCheckoutCommandAt(checkout)).toBeGreaterThanOrEqual(
		before - 1_000,
	);
	expect(lastCheckoutCommandAt(nested)).toBeUndefined();
});
