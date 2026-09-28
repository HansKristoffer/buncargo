import { afterEach, describe, expect, it } from "bun:test";
import {
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CaptureEvent, IntegrationConfig } from "../types";
import { createDevEnvironment } from "./create-dev-environment";
import { writeIfChanged } from "./generated-files";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

function fixture(extra: Partial<IntegrationConfig> = {}) {
	const root = mkdtempSync(join(tmpdir(), "buncargo-captures-"));
	roots.push(root);
	writeFileSync(join(root, "package.json"), JSON.stringify({ workspaces: [] }));
	const events: CaptureEvent[] = [];
	const env = createDevEnvironment(
		{
			projectPrefix: "shop",
			services: {},
			apps: { shopify: { kind: "worker", devCommand: "x" } },
			generatedFiles: [
				{
					path: "src/app-url.generated.ts",
					render: ({ captured, env: vars }) =>
						`export const URL = ${JSON.stringify(captured.appUrl ?? vars.BASE_URL ?? "")}\n`,
				},
			],
			hooks: {
				onCapture: (event) => {
					events.push(event);
				},
			},
			...extra,
		},
		{ root },
	);
	return { root, env, events, file: join(root, "src/app-url.generated.ts") };
}

describe("writeIfChanged", () => {
	it("writes new content and leaves identical content untouched", () => {
		const root = mkdtempSync(join(tmpdir(), "buncargo-write-"));
		roots.push(root);
		const path = join(root, "nested/out.txt");
		expect(writeIfChanged(path, "a")).toBe(true);
		const before = statSync(path).mtimeMs;
		expect(writeIfChanged(path, "a")).toBe(false);
		expect(statSync(path).mtimeMs).toBe(before);
		expect(writeIfChanged(path, "b")).toBe(true);
		expect(readFileSync(path, "utf8")).toBe("b");
	});
});

describe("recordCapture", () => {
	it("renders placeholders first, then the captured value", async () => {
		const { env, events, file } = fixture();
		expect(env.renderGeneratedFiles()).toEqual(["src/app-url.generated.ts"]);
		expect(readFileSync(file, "utf8")).toBe('export const URL = ""\n');

		const changed = await env.recordCapture("shopify", {
			name: "appUrl",
			value: "https://abc.trycloudflare.com",
			as: "publicUrl",
		});
		expect(changed).toEqual(["publicUrls.shopify", "captured.appUrl"]);
		expect(env.captured).toEqual({ appUrl: "https://abc.trycloudflare.com" });
		expect((env.publicUrls as Record<string, string>).shopify).toBe(
			"https://abc.trycloudflare.com",
		);
		expect(readFileSync(file, "utf8")).toBe(
			'export const URL = "https://abc.trycloudflare.com"\n',
		);
		// A public URL reaches every process's env like a tunnel's does.
		expect(
			(env.buildEnvVars() as Record<string, string>).SHOPIFY_PUBLIC_URL,
		).toBe("https://abc.trycloudflare.com");
		expect(events).toEqual([
			{
				app: "shopify",
				name: "appUrl",
				value: "https://abc.trycloudflare.com",
			},
		]);
	});

	it("fires events without changing anything", async () => {
		const { env, events } = fixture();
		const changed = await env.recordCapture("shopify", {
			name: "ready",
			value: "Ready, watching for changes in your app",
			as: "event",
		});
		expect(changed).toEqual([]);
		expect(env.captured).toEqual({});
		expect(events.map((event) => event.name)).toEqual(["ready"]);
	});

	it("reads a value CI hands in when nothing was captured", () => {
		const { env, file } = fixture();
		process.env.BASE_URL = "https://prod.example";
		try {
			env.renderGeneratedFiles();
			expect(readFileSync(file, "utf8")).toBe(
				'export const URL = "https://prod.example"\n',
			);
		} finally {
			delete process.env.BASE_URL;
		}
	});
});

it("keeps other public URLs when a capture sets one", async () => {
	const { env } = fixture();
	env.setPublicUrls({ web: "https://web.trycloudflare.com" } as never);
	await env.recordCapture("shopify", {
		name: "appUrl",
		value: "https://abc.trycloudflare.com",
		as: "publicUrl",
	});
	expect(env.publicUrls).toMatchObject({
		web: "https://web.trycloudflare.com",
		shopify: "https://abc.trycloudflare.com",
	});
});
