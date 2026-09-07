import { expect, it } from "bun:test";
import { devCookiePrefix as serverPrefix } from "../runtime/index";
import { devCookiePrefix } from "./index";

const workspaceId = "0123456789abcdef";

it("uses matching server and mobile prefixes for each workspace", () => {
	const server = serverPrefix("platform", {
		NODE_ENV: "development",
		BUNCARGO_WORKSPACE_ID: workspaceId,
	});

	expect(server).toBe(`platform-${workspaceId}`);
	expect(devCookiePrefix("platform", workspaceId, true)).toBe(server);
	expect(devCookiePrefix("platform", "fedcba9876543210", true)).not.toBe(
		server,
	);
});

it("preserves production, E2E and unconfigured app cookie names", () => {
	for (const env of [
		{ NODE_ENV: "production", BUNCARGO_WORKSPACE_ID: workspaceId },
		{
			NODE_ENV: "development",
			E2E_TEST: "true",
			BUNCARGO_WORKSPACE_ID: workspaceId,
		},
		{ NODE_ENV: "development" },
	]) {
		expect(serverPrefix("platform", env)).toBe("platform");
	}

	expect(devCookiePrefix("platform", workspaceId, false)).toBe("platform");
	expect(devCookiePrefix("platform", undefined, true)).toBe("platform");
	expect(() => devCookiePrefix("platform", "invalid;cookie", true)).toThrow(
		"Invalid",
	);
});

it("bundles and runs the client helper without Node or Bun globals", async () => {
	const build = await Bun.build({
		entrypoints: [new URL("./index.ts", import.meta.url).pathname],
		target: "browser",
		format: "cjs",
	});

	expect(build.success).toBe(true);
	const output = build.outputs[0];
	if (!output) throw new Error("Missing browser bundle");
	const source = await output.text();
	const run = new Function(
		"module",
		"__DEV__",
		"process",
		`${source}\nreturn module.exports.devCookiePrefix("platform", "${workspaceId}");`,
	);

	expect(run({ exports: {} }, true, undefined)).toBe(`platform-${workspaceId}`);
	expect(run({ exports: {} }, false, undefined)).toBe("platform");
	expect(run({ exports: {} }, undefined, undefined)).toBe("platform");
	expect(
		run({ exports: {} }, undefined, { env: { NODE_ENV: "production" } }),
	).toBe("platform");
});
