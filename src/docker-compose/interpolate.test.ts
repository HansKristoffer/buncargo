import { describe, expect, it } from "bun:test";
import { configHashFor, interpolate } from "./interpolate";

describe("interpolate", () => {
	it("substitutes the environment the backend was handed", () => {
		// biome-ignore-start lint/suspicious/noTemplateCurlyInString: the literal `${...}` is the input under test.
		expect(interpolate("${A:-x}:5432", { A: "9" })).toBe("9:5432");
		expect(interpolate("${A:-x}:5432", {})).toBe("x:5432");
		// biome-ignore-end lint/suspicious/noTemplateCurlyInString: end
	});
});

describe("configHashFor", () => {
	it("includes user labels in the configuration hash", () => {
		expect(configHashFor({ image: "redis:7", labels: { a: "1" } })).not.toBe(
			configHashFor({ image: "redis:7", labels: { a: "2" } }),
		);
	});
});
