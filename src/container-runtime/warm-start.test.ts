import { afterEach, describe, expect, it } from "bun:test";
import { resolveServices } from "../config/resolve";
import { freePorts } from "../core/test-env.testing";
import { dockerRuntimeAdapter } from "../docker/adapter";
import { dockerListLine, fakeDocker } from "../docker/fake-docker.testing";
import { serviceHashEnv } from "../docker-compose/interpolate";
import { ensureServicesRunning } from "./ensure-services";

const fakes: ReturnType<typeof fakeDocker>[] = [];
afterEach(() => {
	for (const fake of fakes.splice(0)) fake.remove();
});

describe("ensureServicesRunning against Docker", () => {
	it("forks docker once on a warm start with every service up", async () => {
		const docker = fakeDocker({ ps: { stdout: "" } });
		fakes.push(docker);
		const [port] = freePorts(1);
		const start = (wait: boolean) =>
			ensureServicesRunning({
				runtime: dockerRuntimeAdapter({ binary: docker.binary }),
				root: docker.root,
				projectName: "demo",
				envVars: {},
				services: resolveServices({
					postgres: { port, healthCheck: "pg_isready" },
				}),
				ports: { postgres: port },
				model: { services: { postgres: { image: "postgres:16" } } },
				verbose: false,
				wait,
			});

		// Cold: nothing listed, so the start brings the stack up.
		expect((await start(false)).started).toBe(true);
		const hash = docker.upHashes()[serviceHashEnv("postgres")];
		expect(hash).toBeDefined();

		// Warm: the container runs from this config and Docker reports it healthy.
		docker.setReplies({
			ps: {
				stdout: `${dockerListLine({
					id: "a1",
					name: "demo-postgres-1",
					status: "Up 3 minutes (healthy)",
					ports: `127.0.0.1:${port}->5432/tcp`,
					project: "demo",
					root: docker.root,
					service: "postgres",
					serviceHash: hash,
				})}\n`,
			},
		});
		docker.resetCalls();
		expect((await start(true)).started).toBe(false);
		expect(docker.calls()).toHaveLength(1);
		expect(docker.calls()[0]?.[0]).toBe("ps");
	});

	it("asks Docker to start only when the listing fails", async () => {
		const docker = fakeDocker({
			ps: { exitCode: 1, stderr: "Cannot connect to the Docker daemon" },
			version: { exitCode: 1, stderr: "Cannot connect to the Docker daemon" },
		});
		fakes.push(docker);

		await expect(
			ensureServicesRunning({
				runtime: dockerRuntimeAdapter({ binary: docker.binary }),
				root: docker.root,
				projectName: "demo",
				envVars: {},
				services: resolveServices({ postgres: { healthCheck: false } }),
				ports: {},
				model: { services: { postgres: { image: "postgres:16" } } },
				verbose: false,
				autoStartRuntime: false,
			}),
		).rejects.toThrow(/Docker is not running/);
		expect(docker.calls()[0]?.[0]).toBe("ps");
		expect(docker.calls().map((args) => args[0])).toContain("version");
	});
});
