import { expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	awaitRestartReply,
	awaitSendReply,
	type RestartReply,
	requestRestart,
	requestSend,
	watchRestartRequests,
	watchSendRequests,
} from "./restart-requests";

const began = (): Promise<RestartReply> => Promise.resolve({ status: "began" });

it("restarts each requested app once, answering every request, including one asked for while draining", async () => {
	const root = mkdtempSync(join(tmpdir(), "buncargo-restart-requests-"));
	const restarted: string[] = [];
	let drained: string | undefined;
	const stop = watchRestartRequests(
		root,
		"s1",
		(app) => {
			restarted.push(app);
			// Asked again while the previous batch is being handled.
			if (app === "api") drained = requestRestart(root, "s1", "shopify");
			return app === "api"
				? began()
				: Promise.resolve({ status: "failed", reason: "port taken" });
		},
		() => true,
	);
	try {
		const first = requestRestart(root, "s1", "api");
		const second = requestRestart(root, "s1", "api");
		expect(await awaitRestartReply(root, "s1", first, 5_000)).toEqual({
			status: "began",
		});
		expect(await awaitRestartReply(root, "s1", second, 5_000)).toEqual({
			status: "began",
		});
		if (drained === undefined) throw new Error("shopify was not requested");
		expect(await awaitRestartReply(root, "s1", drained, 5_000)).toEqual({
			status: "failed",
			reason: "port taken",
		});
		expect(restarted).toEqual(["api", "shopify"]);
	} finally {
		stop();
		rmSync(root, { recursive: true, force: true });
	}
});

// Asked before the run's apps had spawned: the request used to be read and
// dropped, and `restart` had already said it was asked.
it("keeps a restart request until the run can act on it", async () => {
	const root = mkdtempSync(join(tmpdir(), "buncargo-restart-pending-"));
	const restarted: string[] = [];
	let ready = false;
	let polls = 0;
	const stop = watchRestartRequests(
		root,
		"s1",
		(app) => {
			restarted.push(app);
			return began();
		},
		() => {
			polls++;
			return ready;
		},
	);
	try {
		requestRestart(root, "s1", "api");
		const deadline = performance.now() + 5_000;
		while (polls < 2 && performance.now() < deadline) await Bun.sleep(20);
		expect(restarted).toEqual([]);
		ready = true;
		while (restarted.length === 0 && performance.now() < deadline)
			await Bun.sleep(20);
		expect(restarted).toEqual(["api"]);
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
	const stopRestarts = watchRestartRequests(
		root,
		"s1",
		(app) => {
			restarted.push(app);
			return began();
		},
		() => true,
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
