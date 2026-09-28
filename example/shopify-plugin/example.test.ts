import { afterAll, beforeAll, expect, it } from "bun:test";
import {
	cpSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * The Shopify example, booted end to end with a fake `shopify` binary: what
 * protects the integration against regressions short of a real Shopify
 * login. It runs `buncargo dev` exactly as a developer would and checks the
 * whole chain: startAfter order, prebuilt extension, generated web toml,
 * captured tunnel URL, generated file, and a request through the "tunnel",
 * the CLI's proxy and the frontend to the API.
 */

const repo = resolve(import.meta.dir, "../..");
const cli = join(repo, "src/cli/bin.ts");
let root: string;
let home: string;
let dev: ReturnType<typeof Bun.spawn> | undefined;
let output = "";

function env(): Record<string, string> {
	return {
		...(process.env as Record<string, string>),
		HOME: home,
		PATH: `${join(root, "fake-shopify")}:${process.env.PATH}`,
		BUNCARGO_HOSTS: "0",
	};
}

async function buncargo(...args: string[]) {
	const child = Bun.spawn([process.execPath, cli, ...args], {
		cwd: root,
		env: env(),
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, code] = await Promise.all([
		new Response(child.stdout).text(),
		child.exited,
	]);
	return { stdout: stdout.trim(), code };
}

beforeAll(async () => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "buncargo-shopify-example-")));
	home = realpathSync(mkdtempSync(join(tmpdir(), "buncargo-shopify-home-")));
	cpSync(import.meta.dir, root, {
		recursive: true,
		filter: (path) =>
			!/\/(\.buncargo|node_modules|assets)(\/|$)|\.generated\.ts$/.test(path),
	});
	// The copy is outside the repo, so its relative `../../src` has to point back.
	const config = join(root, "dev.config.ts");
	writeFileSync(
		config,
		readFileSync(config, "utf8").replaceAll(
			'"../../src',
			`"${join(repo, "src")}`,
		),
	);

	dev = Bun.spawn([process.execPath, cli, "dev"], {
		cwd: root,
		env: env(),
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const decoder = new TextDecoder();
	for (const stream of [
		dev.stdout,
		dev.stderr,
	] as ReadableStream<Uint8Array>[]) {
		void (async () => {
			const reader = stream.getReader();
			for (;;) {
				const { done, value } = await reader.read();
				if (done) return;
				output += decoder.decode(value);
			}
		})();
	}

	// Up once the run has captured the CLI's URL.
	const deadline = Date.now() + 45_000;
	while (Date.now() < deadline) {
		if ((await buncargo("url", "shopify")).code === 0) return;
		if (dev.exitCode !== null) break;
		await Bun.sleep(300);
	}
	throw new Error(`The example did not come up:\n${output}`);
}, 60_000);

afterAll(async () => {
	if (dev && dev.exitCode === null) {
		dev.kill("SIGINT");
		await Promise.race([dev.exited, Bun.sleep(10_000)]);
	}
	rmSync(root, { recursive: true, force: true });
	rmSync(home, { recursive: true, force: true });
});

it("captures the tunnel URL and serves the API through it", async () => {
	const { stdout: url, code } = await buncargo("url", "shopify");
	expect(code).toBe(0);
	expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

	// Tunnel → Shopify CLI proxy → platform (Vite) → /api proxy → api.
	const response = await fetch(`${url}/api/hello`);
	expect(await response.json()).toEqual({
		path: "/api/hello",
		host: new URL(url).host,
		apiKey: "0123456789abcdef0123456789abcdef",
	});

	expect(
		readFileSync(
			join(root, "extensions/theme-prints/src/application-url.generated.ts"),
			"utf8",
		),
	).toBe(`export const APPLICATION_URL = ${JSON.stringify(url)};\n`);
});

it("hands the CLI one web, on the frontend's port, that starts nothing", async () => {
	const web = readFileSync(
		join(root, ".buncargo/shopify/web/shopify.web.toml"),
		"utf8",
	);
	const { stdout: port } = await buncargo("env", "--get", "ports.platform");
	expect(web).toContain(`port = ${port}`);
	expect(web).toContain("wait --app=platform --hold");
	expect(await buncargo("wait", "--app=platform", "--timeout=5")).toMatchObject(
		{
			code: 0,
		},
	);
});

it("prebuilt the extension before the CLI started", () => {
	expect(
		existsSync(join(root, "extensions/theme-prints/assets/prints.js")),
	).toBe(true);
	expect(output.indexOf("bun build.ts --watch")).toBeGreaterThan(
		output.indexOf("$ bun build.ts"),
	);
	expect(output).toContain("Touched 1 theme extension asset");
});

it("holds the dev app's lease", async () => {
	const { stdout } = await buncargo("runs");
	expect(stdout).toContain(
		"lease: shopify-app:0123456789abcdef0123456789abcdef",
	);
});
