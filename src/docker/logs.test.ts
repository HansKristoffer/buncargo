import { afterEach, describe, expect, it } from "bun:test";
import { diagnoseService } from "../container-runtime/containers";
import { dockerRuntimeAdapter } from "./adapter";
import { dockerListLine, fakeDocker } from "./fake-docker.testing";

const fakes: ReturnType<typeof fakeDocker>[] = [];
afterEach(() => {
	for (const fake of fakes.splice(0)) fake.remove();
});

describe("diagnosing a Docker service", () => {
	it("reports an exited job from the listing and its logs, without Compose", async () => {
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

		const diagnosis = await diagnoseService(
			dockerRuntimeAdapter({ binary: fake.binary }),
			// What it reports, not how fast: a loaded machine's fake docker
			// must not run out the default two seconds.
			{
				root: fake.root,
				projectName: "demo",
				serviceName: "migrate",
				timeoutMs: 60_000,
			},
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
			await diagnoseService(dockerRuntimeAdapter({ binary: fake.binary }), {
				root: fake.root,
				projectName: "demo",
				serviceName: "migrate",
			}),
		).toBeUndefined();
	});
});
