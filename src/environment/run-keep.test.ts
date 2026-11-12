import { expect, it } from "bun:test";
import type { RunEntry } from "../core/run-registry";
import { runsKeepingServices } from "./run-keep";

const run = (sessionId: string, pid: number, projectName = "shop") =>
	({ sessionId, pid, projectName }) as RunEntry;

it("keeps a project's services for every other live run of it", () => {
	const live = [
		run("ending", 10),
		run("other", 11),
		run("elsewhere", 12, "blog"),
	];

	expect(
		runsKeepingServices(live, { projectName: "shop", sessionId: "ending" }),
	).toEqual([run("other", 11)]);
});

it("counts no session of a stopped process as keeping them", () => {
	// `buncargo stop` signalled the whole process: its other sessions end too.
	const live = [run("ending", 10), run("sibling", 10), run("other", 11)];

	expect(
		runsKeepingServices(live, {
			projectName: "shop",
			sessionId: "ending",
			pid: 10,
		}),
	).toEqual([run("other", 11)]);
});

it("keeps them for any live run when only finished runs are being cleaned up", () => {
	expect(
		runsKeepingServices([run("live", 11)], { projectName: "shop" }),
	).toEqual([run("live", 11)]);
});
