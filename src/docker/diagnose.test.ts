import { afterEach, describe, expect, it } from "bun:test";
import { diagnoseDockerService } from "./diagnose";
import { dockerListLine, fakeDocker } from "./fake-docker.testing";

const fakes: ReturnType<typeof fakeDocker>[] = [];
afterEach(() => {
	for (const fake of fakes.splice(0)) fake.remove();
});

describe("diagnoseDockerService", () => {
	it("reports an exited job from the listing, without Compose", async () => {
		const fake = fakeDocker({
			ps: {
				stdout: `${dockerListLine({
					id: "abc123",
					state: "exited",
					status: "Exited (3) 1 second ago",
					project: "demo",
					service: "migrate",
				})}\n`,
			},
			logs: { stdout: "starting\n", stderr: "FATAL: boom\n" },
		});
		fakes.push(fake);

		const diagnosis = await diagnoseDockerService(
			{ root: fake.root, projectName: "demo", serviceName: "migrate" },
			fake.binary,
		);

		expect(diagnosis).toEqual({
			state: "exited",
			exitCode: 3,
			logTail: "starting\nFATAL: boom",
		});
		expect(fake.calls().map((args) => args[0])).toEqual(["ps", "logs"]);
		expect(fake.calls()[1]).toEqual(["logs", "--tail=20", "abc123"]);
	});

	it("finds nothing when no container carries the service's labels", async () => {
		const fake = fakeDocker({
			ps: {
				stdout: `${dockerListLine({ id: "x", project: "other", service: "migrate" })}\n`,
			},
		});
		fakes.push(fake);
		expect(
			await diagnoseDockerService(
				{ root: fake.root, projectName: "demo", serviceName: "migrate" },
				fake.binary,
			),
		).toBeUndefined();
	});
});
