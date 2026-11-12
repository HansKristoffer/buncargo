import { describe, expect, it } from "bun:test";
import { type Bundle, parseBundle } from "./bundle";
import { sha256 } from "./store";

const data = Buffer.from("API_KEY=1\n");
const file = {
	path: ".env",
	sha256: sha256(data),
	updatedAt: "2026-10-15T12:00:00.000Z",
	machine: false,
	data: data.toString("base64"),
};
const bundle: Bundle = {
	kind: "buncargo-checkout-files",
	version: 1,
	repoKey: "github.com/acme/app",
	files: [file],
};

describe("parseBundle", () => {
	it("reads a bundle whose every file matches its hash", () => {
		expect(parseBundle(JSON.stringify(bundle))).toEqual(bundle);
	});

	it.each([
		["not JSON", "{", "not JSON"],
		["JSON of another kind", "null", "Make one with `buncargo files export`"],
		["another version", { ...bundle, version: 2 }, "has version 2"],
		["no files", { ...bundle, files: undefined }, "no repoKey or files"],
		[
			"an entry that is not an object",
			{ ...bundle, files: [7] },
			"is not a path",
		],
		[
			"an entry without data",
			{ ...bundle, files: [{ ...file, data: undefined }] },
			"is incomplete",
		],
		[
			"an entry whose hash is missing",
			{ ...bundle, files: [{ ...file, sha256: undefined }] },
			"does not match its sha256",
		],
	])("refuses %s", (_, input, message) => {
		const text = typeof input === "string" ? input : JSON.stringify(input);
		expect(() => parseBundle(text)).toThrow(message);
	});
});
