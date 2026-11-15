import { describe, expect, it } from "bun:test";
import { configHashFor, interpolate } from "./interpolate";

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

	it("includes user labels in the config fingerprint", () => {
		expect(configHashFor({ image: "busybox", labels: { a: "1" } })).not.toBe(
			configHashFor({ image: "busybox", labels: { a: "2" } }),
		);
	});
});
