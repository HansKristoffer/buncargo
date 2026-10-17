import { expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	awaitSendReply,
	requestRestart,
	requestSend,
	watchRestartRequests,
	watchSendRequests,
} from "./restart-requests";

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

it("delivers sent keys in order, every one of them, and apart from restarts", async () => {
	const root = mkdtempSync(join(tmpdir(), "buncargo-send-requests-"));
	const sent: string[] = [];
	const restarted: string[] = [];
	const stopSends = watchSendRequests(root, "s1", (app, text) => {
		sent.push(`${app}:${JSON.stringify(text)}`);
		return undefined;
	});
	const stopRestarts = watchRestartRequests(root, "s1", (app) =>
		restarted.push(app),
	);
	try {
		requestSend(root, "s1", "expo", "r");
		requestSend(root, "s1", "expo", "r");
		requestSend(root, "s1", "expo", "i\r");
		for (let i = 0; i < 40 && sent.length < 3; i++) await Bun.sleep(50);
		expect(sent).toEqual(['expo:"r"', 'expo:"r"', 'expo:"i\\r"']);
		expect(restarted).toEqual([]);
	} finally {
		stopSends();
		stopRestarts();
		rmSync(root, { recursive: true, force: true });
	}
});

it("answers each send with whether the app took the keys", async () => {
	const root = mkdtempSync(join(tmpdir(), "buncargo-send-replies-"));
	const stop = watchSendRequests(root, "s1", (app) =>
		app === "expo" ? undefined : "it reads no keys",
	);
	try {
		const typed = requestSend(root, "s1", "expo", "i");
		const refused = requestSend(root, "s1", "api", "i");
		expect(await awaitSendReply(root, "s1", typed, 5_000)).toEqual({
			delivered: true,
		});
		expect(await awaitSendReply(root, "s1", refused, 5_000)).toEqual({
			delivered: false,
			reason: "it reads no keys",
		});
	} finally {
		stop();
	}
	// Nobody is listening any more: no answer, not a hang.
	const unanswered = requestSend(root, "s1", "expo", "i");
	expect(await awaitSendReply(root, "s1", unanswered, 100)).toBeUndefined();
	rmSync(root, { recursive: true, force: true });
});
