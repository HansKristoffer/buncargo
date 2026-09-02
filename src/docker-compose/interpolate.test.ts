import { describe, expect, it } from "bun:test";
import {
	configHashFor,
	interpolate,
	projectStackHash,
	STACK_HASH_ENV,
	STACK_HASH_LABEL,
} from "./interpolate";

const model = {
	name: "demo",
	services: {
		postgres: {
			image: "postgres:16",
			// biome-ignore lint/suspicious/noTemplateCurlyInString: the literal `${...}` is the input under test.
			ports: ["${POSTGRES_PORT:-5432}:5432"],
			labels: { [STACK_HASH_LABEL]: `\${${STACK_HASH_ENV}:-}` },
		},
		redis: { image: "redis:7" },
	},
};

function hash(
	envVars: Record<string, string>,
	serviceNames = ["postgres", "redis"],
	document = model,
): string {
	return projectStackHash({ model: document, envVars, serviceNames });
}

describe("projectStackHash", () => {
	it("is stable for the same stack", () => {
		expect(hash({ POSTGRES_PORT: "5532" })).toBe(
			hash({ POSTGRES_PORT: "5532" }),
		);
	});

	// The point of hashing after interpolation: the file text is identical
	// between two worktrees, and only the allocated ports differ.
	it("changes when an interpolated value changes", () => {
		expect(hash({ POSTGRES_PORT: "5532" })).not.toBe(
			hash({ POSTGRES_PORT: "5632" }),
		);
	});

	it("changes when a service definition changes", () => {
		const edited = {
			...model,
			services: { ...model.services, redis: { image: "redis:8" } },
		};
		expect(hash({})).not.toBe(hash({}, ["postgres", "redis"], edited));
	});

	it("does not depend on the order the services are listed in", () => {
		expect(hash({}, ["postgres", "redis"])).toBe(
			hash({}, ["redis", "postgres"]),
		);
	});

	// A run that starts only the services its selected apps need is a different
	// stack from one that starts everything.
	it("covers only the selected services", () => {
		expect(hash({}, ["postgres"])).not.toBe(hash({}, ["postgres", "redis"]));
	});

	// The hash is carried in a label, so including labels would make it depend
	// on itself.
	it("ignores labels, including its own", () => {
		const relabelled = {
			...model,
			services: {
				...model.services,
				postgres: {
					...model.services.postgres,
					labels: { [STACK_HASH_LABEL]: "something-else" },
				},
			},
		};
		expect(hash({})).toBe(hash({}, ["postgres", "redis"], relabelled));
	});

	it("is short enough to sit in a label", () => {
		expect(hash({})).toMatch(/^[0-9a-f]{16}$/);
	});
});

describe("interpolate", () => {
	it("substitutes the environment the backend was handed", () => {
		// biome-ignore-start lint/suspicious/noTemplateCurlyInString: the literal `${...}` is the input under test.
		expect(interpolate("${A:-x}:5432", { A: "9" })).toBe("9:5432");
		expect(interpolate("${A:-x}:5432", {})).toBe("x:5432");
		// biome-ignore-end lint/suspicious/noTemplateCurlyInString: end
	});
});

describe("configHashFor", () => {
	it("ignores labels so a hash label cannot feed back into itself", () => {
		expect(configHashFor({ image: "redis:7", labels: { a: "1" } })).toBe(
			configHashFor({ image: "redis:7", labels: { a: "2" } }),
		);
	});
});
