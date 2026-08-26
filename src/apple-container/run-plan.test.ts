import { describe, expect, it } from "bun:test";
import { homedir } from "node:os";
import { buildComposeModel } from "../docker-compose";
import type { ComposeDocument, ServiceConfig } from "../types";
import {
	buildAppleRunPlan,
	CONFIG_HASH_LABEL,
	configHashFor,
	containerNameFor,
	interpolate,
	orderServices,
	projectVolumeNames,
	sanitizeContainerName,
	splitCommandLine,
	volumeNameFor,
} from "./run-plan";

const IDENTITY = {
	projectName: "gey-main",
	root: "/repo",
	worktree: null,
};

function modelFor(services: Record<string, ServiceConfig>): ComposeDocument {
	return buildComposeModel(services, undefined, IDENTITY);
}

function planFor(
	services: Record<string, ServiceConfig>,
	env: Record<string, string> = {},
) {
	return buildAppleRunPlan({
		projectName: IDENTITY.projectName,
		model: modelFor(services),
		root: IDENTITY.root,
		env,
	});
}

/** Read the value that follows each occurrence of a flag. */
function valuesOf(args: string[], flag: string): string[] {
	const values: string[] = [];
	for (let i = 0; i < args.length; i++) {
		if (args[i] === flag && args[i + 1] !== undefined) {
			values.push(args[i + 1] as string);
		}
	}
	return values;
}

describe("splitCommandLine", () => {
	it("splits on whitespace", () => {
		expect(splitCommandLine("  sleep   1 ")).toEqual(["sleep", "1"]);
		expect(splitCommandLine("")).toEqual([]);
	});

	it("groups quoted runs into one word", () => {
		expect(splitCommandLine(`sh -c "echo hi there"`)).toEqual([
			"sh",
			"-c",
			"echo hi there",
		]);
		expect(splitCommandLine(`--flag='a b'`)).toEqual(["--flag=a b"]);
	});

	it("keeps an empty quoted argument", () => {
		expect(splitCommandLine(`sh -c ""`)).toEqual(["sh", "-c", ""]);
	});

	it("treats single quotes as fully literal", () => {
		expect(splitCommandLine(`'a\\b'`)).toEqual(["a\\b"]);
	});

	it("honors backslash escapes outside quotes", () => {
		expect(splitCommandLine(`a\\ b`)).toEqual(["a b"]);
		expect(splitCommandLine(`a\\"b`)).toEqual([`a"b`]);
	});

	it("only lets a backslash escape the four shell metacharacters in double quotes", () => {
		expect(splitCommandLine(`"a\\nb"`)).toEqual([`a\\nb`]);
		expect(splitCommandLine(`"a\\"b"`)).toEqual([`a"b`]);
	});
});

describe("interpolate", () => {
	// biome-ignore lint/suspicious/noTemplateCurlyInString: the literal placeholder is the input under test
	const PLAIN = "${PORT}:5432";
	// biome-ignore lint/suspicious/noTemplateCurlyInString: the literal placeholder is the input under test
	const WITH_DEFAULT = "${PORT:-5432}:5432";

	it("substitutes a plain variable", () => {
		expect(interpolate(PLAIN, { PORT: "5533" })).toBe("5533:5432");
	});

	it("falls back to the default when unset or empty", () => {
		expect(interpolate(WITH_DEFAULT, {})).toBe("5432:5432");
		expect(interpolate(WITH_DEFAULT, { PORT: "" })).toBe("5432:5432");
	});

	it("prefers the value over the default", () => {
		expect(interpolate(WITH_DEFAULT, { PORT: "5533" })).toBe("5533:5432");
	});

	it("substitutes an unset bare variable with empty, as compose does", () => {
		expect(interpolate("$UNSET/x", {})).toBe("/x");
		expect(interpolate("$PORT/x", { PORT: "5533" })).toBe("5533/x");
	});

	it("lets the colon decide whether an empty value takes the default", () => {
		// biome-ignore lint/suspicious/noTemplateCurlyInString: the literal placeholder is the input under test
		const noColon = "${PORT-5432}";
		expect(interpolate(noColon, { PORT: "" })).toBe("");
		expect(interpolate(noColon, {})).toBe("5432");
		expect(interpolate(WITH_DEFAULT, { PORT: "" })).toBe("5432:5432");
	});

	it("fails on a required variable that is missing", () => {
		// biome-ignore lint/suspicious/noTemplateCurlyInString: the literal placeholder is the input under test
		const required = "${TAG:?TAG is required}";
		expect(() => interpolate(required, {})).toThrow("TAG is required");
		expect(() => interpolate(required, { TAG: "" })).toThrow("TAG is required");
		expect(interpolate(required, { TAG: "v1" })).toBe("v1");

		// Without the colon, an empty value satisfies the requirement.
		// biome-ignore lint/suspicious/noTemplateCurlyInString: the literal placeholder is the input under test
		expect(interpolate("${TAG?nope}", { TAG: "" })).toBe("");
	});

	it("treats $$ as an escaped dollar, as compose does", () => {
		expect(interpolate("pa$$word", { word: "nope" })).toBe("pa$word");
		// biome-ignore lint/suspicious/noTemplateCurlyInString: the literal placeholder is the input under test
		expect(interpolate("$${PORT}", { PORT: "5533" })).toBe("${PORT}");
		expect(interpolate("$$PORT", { PORT: "5533" })).toBe("$PORT");
	});
});

describe("sanitizeContainerName", () => {
	it("replaces characters Apple rejects", () => {
		expect(sanitizeContainerName("gey main/postgres")).toBe(
			"gey-main-postgres",
		);
	});

	it("prefixes a name that does not start alphanumerically", () => {
		expect(sanitizeContainerName("_data")).toBe("c-_data");
	});

	it("keeps a conventional project-service name intact", () => {
		expect(containerNameFor("gey-main", "postgres")).toBe("gey-main-postgres");
	});
});

describe("buildAppleRunPlan", () => {
	it("translates the postgres preset to container run argv", () => {
		const plan = planFor({ postgres: { port: 5432 } });
		const service = plan.services[0];
		if (!service) throw new Error("expected a postgres plan");

		expect(plan.services).toHaveLength(1);
		expect(service.containerName).toBe("gey-main-postgres");
		expect(service.image).toBe("pgvector/pgvector:pg16");
		expect(service.runArgs.slice(0, 4)).toEqual([
			"run",
			"--detach",
			"--name",
			"gey-main-postgres",
		]);
		expect(service.runArgs.at(-1)).toBe("pgvector/pgvector:pg16");
	});

	it("interpolates the published port from the environment", () => {
		const withOverride = planFor(
			{ postgres: { port: 5432 } },
			{
				POSTGRES_PORT: "5533",
			},
		);
		const withDefault = planFor({ postgres: { port: 5432 } });

		expect(
			valuesOf(withOverride.services[0]?.runArgs ?? [], "--publish"),
		).toEqual(["5533:5432"]);
		expect(
			valuesOf(withDefault.services[0]?.runArgs ?? [], "--publish"),
		).toEqual(["5432:5432"]);
	});

	it("prefixes named volumes with the project and creates them once", () => {
		const plan = planFor({ postgres: { port: 5432 } });
		const service = plan.services[0];
		if (!service) throw new Error("expected a postgres plan");

		expect(plan.volumes).toEqual(["gey-main-postgres_data"]);
		expect(valuesOf(service.runArgs, "--volume")).toEqual([
			"gey-main-postgres_data:/var/lib/postgresql/data",
		]);
	});

	it("resolves a relative bind mount against the root", () => {
		const plan = planFor({
			custom: {
				port: 9000,
				docker: {
					image: "busybox",
					volumes: ["./seed:/seed", "/etc/hosts:/etc/hosts"],
				},
			},
		});
		const service = plan.services[0];
		if (!service) throw new Error("expected a custom plan");

		expect(valuesOf(service.runArgs, "--volume")).toEqual([
			"/repo/seed:/seed",
			"/etc/hosts:/etc/hosts",
		]);
		expect(plan.volumes).toEqual([]);
	});

	it("passes environment and buncargo labels through", () => {
		const plan = planFor({ postgres: { port: 5432 } });
		const service = plan.services[0];
		if (!service) throw new Error("expected a postgres plan");

		expect(valuesOf(service.runArgs, "--env")).toContain(
			"POSTGRES_USER=postgres",
		);
		const labels = valuesOf(service.runArgs, "--label");
		expect(labels).toContain("buncargo.project=gey-main");
		expect(labels).toContain("buncargo.service=postgres");
		expect(labels).toContain("buncargo.root=/repo");
		expect(labels).toContain(`${CONFIG_HASH_LABEL}=${service.configHash}`);
	});

	it("drops the compose healthcheck without warning about it", () => {
		const plan = planFor({ postgres: { port: 5432 } });
		expect(plan.services[0]?.runArgs.join(" ")).not.toContain("pg_isready");
		expect(plan.unsupportedKeys).toEqual([]);
	});

	it("warns about nothing for the built-in presets", () => {
		// mailpit and typesense both set `restart`, so warning on it would fire on
		// every run for anyone using them.
		const plan = planFor({
			postgres: { port: 5432 },
			redis: { port: 6379 },
			mailpit: { port: 8025, secondaryPort: 1025 },
			typesense: { port: 8108 },
			clickhouse: { port: 8123, secondaryPort: 9000 },
		});
		expect(plan.unsupportedKeys).toEqual([]);
	});

	it("reports compose keys it cannot translate", () => {
		const plan = planFor({
			custom: {
				port: 9000,
				docker: {
					image: "busybox",
					networks: ["backend"],
					privileged: true,
				},
			},
		});
		expect(plan.unsupportedKeys).toEqual(["networks", "privileged"]);
	});

	it("translates command, entrypoint, working_dir and ulimits", () => {
		const plan = planFor({
			custom: {
				port: 9000,
				docker: {
					image: "busybox",
					entrypoint: ["/bin/sh", "-c"],
					command: ["sleep", "1"],
					working_dir: "/srv",
					user: "1000:1000",
					ulimits: { nofile: { soft: 1024, hard: 2048 }, nproc: 512 },
				},
			},
		});
		const args = plan.services[0]?.runArgs ?? [];

		expect(valuesOf(args, "--entrypoint")).toEqual(["/bin/sh"]);
		expect(valuesOf(args, "--workdir")).toEqual(["/srv"]);
		expect(valuesOf(args, "--user")).toEqual(["1000:1000"]);
		expect(valuesOf(args, "--ulimit")).toEqual([
			"nofile=1024:2048",
			"nproc=512",
		]);
		// The entrypoint tail lands ahead of command, as compose prepends it.
		expect(args.slice(-4)).toEqual(["busybox", "-c", "sleep", "1"]);
	});

	it("keeps a quoted argument together when splitting a string command", () => {
		const plan = planFor({
			custom: {
				port: 9000,
				docker: {
					image: "busybox",
					command: `sh -c "echo hi there" --flag='a b'`,
				},
			},
		});
		const args = plan.services[0]?.runArgs ?? [];

		expect(args.slice(-4)).toEqual(["sh", "-c", "echo hi there", "--flag=a b"]);
	});

	it("expands ~ in a bind mount source", () => {
		const plan = planFor({
			custom: {
				port: 9000,
				docker: { image: "busybox", volumes: ["~/data:/data"] },
			},
		});
		const mounts = valuesOf(plan.services[0]?.runArgs ?? [], "--volume");

		expect(mounts).toEqual([`${homedir()}/data:/data`]);
	});

	it("reports container_name rather than dropping it silently", () => {
		const plan = planFor({
			custom: {
				port: 9000,
				docker: { image: "busybox", container_name: "mine" },
			},
		});

		expect(plan.unsupportedKeys).toEqual(["container_name"]);
		expect(valuesOf(plan.services[0]?.runArgs ?? [], "--name")).toEqual([
			containerNameFor(IDENTITY.projectName, "custom"),
		]);
	});

	it("splits the string entrypoint form the way compose does", () => {
		const plan = planFor({
			custom: {
				port: 9000,
				docker: { image: "busybox", entrypoint: "/bin/sh -c" },
			},
		});
		const args = plan.services[0]?.runArgs ?? [];

		expect(valuesOf(args, "--entrypoint")).toEqual(["/bin/sh"]);
		expect(args.slice(-2)).toEqual(["busybox", "-c"]);
	});

	it("splits a string command into words", () => {
		// The typesense preset writes this form. Passed through whole, the image
		// receives one long argument and prints its usage instead of starting.
		const plan = planFor({ typesense: { port: 8108 } });
		const args = plan.services[0]?.runArgs ?? [];

		expect(args.slice(-4)).toEqual([
			"--data-dir",
			"/data",
			"--api-key=xyz",
			"--enable-cors",
		]);
	});

	it("starts only the requested services", () => {
		const plan = buildAppleRunPlan({
			projectName: IDENTITY.projectName,
			model: modelFor({ postgres: { port: 5432 }, redis: { port: 6379 } }),
			root: IDENTITY.root,
			serviceNames: ["redis"],
		});
		expect(plan.services.map((service) => service.serviceName)).toEqual([
			"redis",
		]);
	});

	it("rejects a service with no image", () => {
		expect(() =>
			buildAppleRunPlan({
				projectName: IDENTITY.projectName,
				root: IDENTITY.root,
				model: { services: { web: { build: "." } } },
			}),
		).toThrow(/no image/);
	});
});

describe("orderServices", () => {
	it("starts a dependency before its dependent", () => {
		expect(
			orderServices({
				api: { image: "busybox", depends_on: ["db"] },
				db: { image: "postgres" },
			}),
		).toEqual(["db", "api"]);
	});

	it("accepts the long depends_on form", () => {
		expect(
			orderServices({
				api: {
					image: "busybox",
					depends_on: { db: { condition: "service_started" } },
				},
				db: { image: "postgres" },
			}),
		).toEqual(["db", "api"]);
	});

	it("falls back to declaration order on a cycle", () => {
		expect(
			orderServices({
				a: { image: "busybox", depends_on: ["b"] },
				b: { image: "busybox", depends_on: ["a"] },
			}),
		).toEqual(["b", "a"]);
	});

	it("ignores a dependency that is not in the model", () => {
		expect(
			orderServices({ api: { image: "busybox", depends_on: ["ghost"] } }),
		).toEqual(["api"]);
	});
});

describe("configHashFor", () => {
	it("is stable across key order", () => {
		expect(configHashFor({ image: "busybox", user: "root" })).toBe(
			configHashFor({ user: "root", image: "busybox" }),
		);
	});

	it("changes when an immutable field changes", () => {
		expect(configHashFor({ image: "busybox", ports: ["1:1"] })).not.toBe(
			configHashFor({ image: "busybox", ports: ["2:1"] }),
		);
	});

	it("ignores labels, which carry the hash itself", () => {
		expect(configHashFor({ image: "busybox", labels: { a: "1" } })).toBe(
			configHashFor({ image: "busybox", labels: { a: "2" } }),
		);
	});
});

describe("projectVolumeNames", () => {
	it("prefixes every declared volume", () => {
		expect(
			projectVolumeNames("gey-main", modelFor({ postgres: { port: 5432 } })),
		).toEqual([volumeNameFor("gey-main", "postgres_data")]);
	});
});
