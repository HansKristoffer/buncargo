import { expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requestRestart, watchRestartRequests } from "./restart-requests";

it("restarts each requested app once, including one asked for while draining", async () => {
	const root = mkdtempSync(join(tmpdir(), "buncargo-restart-requests-"));
	const restarted: string[] = [];
	const stop = watchRestartRequests(root, "s1", (app) => {
		restarted.push(app);
		// Asked again while the previous batch is being handled.
		if (app === "api") requestRestart(root, "s1", "shopify");
	});
	try {
		requestRestart(root, "s1", "api");
		requestRestart(root, "s1", "api");
		for (let i = 0; i < 40 && restarted.length < 2; i++) await Bun.sleep(50);
		expect(restarted).toEqual(["api", "shopify"]);
	} finally {
		stop();
		rmSync(root, { recursive: true, force: true });
	}
});
