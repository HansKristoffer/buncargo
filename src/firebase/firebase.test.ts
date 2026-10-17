import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDevEnvironment } from "../environment";
import type {
	AnyDevEnvironment,
	CheckContext,
	DevConfig,
	GeneratedFileContext,
} from "../types";
import { firebaseChecks } from "./checks";
import {
	anchorPort,
	emulatorPorts,
	generatedFirebaseConfig,
	selectEmulators,
} from "./emulators";
import { emulatorTmpDir, firebase } from "./index";
import { readFirebaseProject } from "./project";

const saved = {
	HOME: process.env.HOME,
	BUNCARGO_PORT_OFFSET: process.env.BUNCARGO_PORT_OFFSET,
};
let root = "";

const FIREBASE_JSON = `{
	// The CLI allows comments.
	"firestore": { "rules": "firestore.rules" },
	"functions": [{ "source": "functions", "codebase": "default" }],
	"hosting": { "source": "apps/web" },
	"emulators": {
		"auth": { "port": 9099 },
		"firestore": { "port": 8080 },
		"storage": { "port": 9199 },
		"hosting": { "port": 5000 },
		"ui": { "enabled": true },
		"singleProjectMode": true
	}
}`;

beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), "buncargo-firebase-"));
	writeFileSync(join(root, "package.json"), "{}");
	writeFileSync(join(root, "firebase.json"), FIREBASE_JSON);
	process.env.HOME = root;
	process.env.BUNCARGO_PORT_OFFSET = "100";
});

afterAll(() => {
	for (const [key, value] of Object.entries(saved)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	rmSync(root, { recursive: true, force: true });
});

describe("selectEmulators", () => {
	const raw = () => readFirebaseProject(root).raw;

	it("starts what firebase.json configures, except what serves the app", () => {
		// Functions has no `emulators` entry; configuring the product is enough.
		expect(selectEmulators(raw())).toEqual([
			"auth",
			"functions",
			"firestore",
			"storage",
		]);
	});

	it("starts exactly the emulators asked for", () => {
		expect(selectEmulators(raw(), ["hosting", "firestore"])).toEqual([
			"firestore",
			"hosting",
		]);
	});
});

describe("generatedFirebaseConfig", () => {
	it("moves every port by the offset and keeps everything else", () => {
		const raw = readFirebaseProject(root).raw;
		const selected = selectEmulators(raw);
		const generated = generatedFirebaseConfig(
			raw,
			selected,
			emulatorPorts(raw, selected, 100),
		) as { emulators: Record<string, Record<string, unknown>> } & Record<
			string,
			unknown
		>;

		expect(generated.functions).toEqual(raw.functions);
		expect(generated.emulators).toHaveProperty("singleProjectMode", true);
		expect(generated.emulators.firestore).toEqual({
			host: "127.0.0.1",
			port: 8180,
			websocketPort: 9250,
		});
		// The CLI would pick a free one for each of these, and nothing could
		// then tell the apps where it went.
		expect(generated.emulators.hub?.port).toBe(4500);
		expect(generated.emulators.ui).toEqual({
			enabled: true,
			host: "127.0.0.1",
			port: 4100,
		});
		expect(generated.emulators.eventarc?.port).toBe(9399);
		expect(generated.emulators.tasks?.port).toBe(9599);
		// Not started, so left as configured.
		expect(generated.emulators.hosting).toEqual({ port: 5000 });
	});

	it("anchors on the hub when the UI is off", () => {
		expect(anchorPort({ emulators: { ui: { enabled: false } } })).toBe(4400);
		expect(anchorPort({ emulators: { ui: { port: 4321 } } })).toBe(4321);
	});
});

describe("firebase()", () => {
	const config: DevConfig = {
		projectPrefix: "myapp",
		services: {},
		apps: { web: { port: 3000, devCommand: "next dev" } },
		integrations: [firebase({ publicEnvPrefix: "NEXT_PUBLIC_" })],
	};

	it("runs this checkout's emulators on its own ports, and gives every app their hosts", () => {
		const env = createDevEnvironment(config, { root });
		const vars = env.buildEnvVars() as Record<string, string>;
		const app = env.apps.firebase;

		expect(env.ports.firebase).toBe(4100);
		expect(app?.devCommand).toContain(
			"emulators:start --config firebase.buncargo.json --project demo-myapp --only auth,functions,firestore,storage",
		);
		expect(app?.devCommand).toContain(
			"--import .firebase-emulator-data --export-on-exit .firebase-emulator-data",
		);
		expect(app?.stopGraceMs).toBe(60_000);
		expect(vars).toMatchObject({
			FIREBASE_PROJECT_ID: "demo-myapp",
			GCLOUD_PROJECT: "demo-myapp",
			FIRESTORE_EMULATOR_HOST: "127.0.0.1:8180",
			FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9199",
			FIREBASE_STORAGE_EMULATOR_HOST: "127.0.0.1:9299",
			STORAGE_EMULATOR_HOST: "http://127.0.0.1:9299",
			FIREBASE_FUNCTIONS_EMULATOR_HOST: "127.0.0.1:5101",
			FIREBASE_EMULATOR_HUB: "127.0.0.1:4500",
			NEXT_PUBLIC_FIRESTORE_EMULATOR_HOST: "127.0.0.1:8180",
			NEXT_PUBLIC_FIREBASE_PROJECT_ID: "demo-myapp",
		});
		// Not emulated, so the SDKs keep talking to the real service.
		expect(vars.FIREBASE_DATABASE_EMULATOR_HOST).toBeUndefined();
		expect(vars.NEXT_PUBLIC_GCLOUD_PROJECT).toBeUndefined();
	});

	it("writes the copy of firebase.json the CLI is started on", () => {
		const env = createDevEnvironment(config, { root });
		const file = env.generatedFiles?.find(
			(entry) => entry.path === "firebase.buncargo.json",
		);
		expect(file?.gitignore).toBe(true);
		const rendered = JSON.parse(
			file?.render({
				ports: env.ports as Record<string, number>,
			} as GeneratedFileContext) ?? "{}",
		);
		expect(rendered.emulators.firestore.port).toBe(8180);
		expect(rendered.emulators.ui.port).toBe(env.ports.firebase);
	});

	it("gives the suite a short temp dir of its own, where the hub announces itself", () => {
		const env = createDevEnvironment(config, { root });
		const dir = (env.buildAppEnvVars("firebase") as Record<string, string>)
			.TMPDIR;
		expect(dir).toBe(emulatorTmpDir(root));
		expect(emulatorTmpDir(join(root, "another-worktree"))).not.toBe(dir);
		expect(env.buildAppEnvVars("web")).not.toHaveProperty("TMPDIR");
		// The Functions emulator's socket, which macOS cuts off past 103 bytes
		// however deep the checkout is.
		const socket = join(
			emulatorTmpDir(join(root, ".claude", "worktrees", "x".repeat(80))),
			`fire_emu_${"0".repeat(16)}.sock`,
		);
		expect(socket.length).toBeLessThan(104);
	});

	it("claims every port the suite listens on with the checkout's block", () => {
		const env = createDevEnvironment(config, { root });
		// The UI is the app's own port; the rest move with it.
		expect(env.apps.firebase?.extraPorts).toEqual([
			9099, 5001, 8080, 9199, 4400, 4500, 9150, 9299, 9499,
		]);
	});

	it("runs as .firebaserc's project, or the one given", () => {
		writeFileSync(
			join(root, ".firebaserc"),
			JSON.stringify({ projects: { default: "my-app-dev" } }),
		);
		try {
			const fromRc = createDevEnvironment(config, { root });
			expect(fromRc.apps.firebase?.devCommand).toContain(
				"--project my-app-dev",
			);
			const given = createDevEnvironment(
				{ ...config, integrations: [firebase({ projectId: "demo-x" })] },
				{ root },
			);
			expect(given.buildEnvVars()).toMatchObject({
				FIREBASE_PROJECT_ID: "demo-x",
			});
		} finally {
			rmSync(join(root, ".firebaserc"));
		}
	});

	it("starts empty every time without persistence", () => {
		const env = createDevEnvironment(
			{ ...config, integrations: [firebase({ persist: false })] },
			{ root },
		);
		expect(env.apps.firebase?.devCommand).not.toContain("--import");
	});

	it("lets the config's own env and app win over the integration's", () => {
		const env = createDevEnvironment(
			{
				...config,
				apps: {
					...config.apps,
					firebase: { port: 4000, devCommand: "my-emulators" },
				},
				env: () => ({ FIRESTORE_EMULATOR_HOST: "elsewhere:1" }),
			},
			{ root },
		);
		expect(env.apps.firebase?.devCommand).toBe("my-emulators");
		expect(env.buildEnvVars()).toMatchObject({
			FIRESTORE_EMULATOR_HOST: "elsewhere:1",
		});
	});
});

describe("firebase checks", () => {
	const check = (name: string, emulators = selectEmulators({})) => {
		const found = firebaseChecks({
			project: () => readFirebaseProject(root),
			workdir: () => root,
			emulators: () => emulators,
			dataDir: () => undefined,
		}).find((entry) => entry.name === name);
		if (!found) throw new Error(`no check named ${name}`);
		return found;
	};
	// Built per test: `root` is only set once `beforeAll` has run.
	const context = () =>
		({ root, env: {} as AnyDevEnvironment }) as CheckContext;

	it("asks for Java only when a JVM emulator runs", async () => {
		const path = process.env.PATH;
		process.env.PATH = join(root, "no-bin");
		try {
			const java = "Java is installed for the Firebase emulators";
			expect(await check(java, ["auth"]).check(context())).toBe(true);
			expect(await check(java, ["firestore"]).check(context())).toMatchObject({
				ok: false,
			});
		} finally {
			process.env.PATH = path;
		}
	});

	it("offers to gitignore the data directory", async () => {
		const gitignored = firebaseChecks({
			project: () => readFirebaseProject(root),
			workdir: () => root,
			emulators: () => [],
			dataDir: () => ".firebase-emulator-data",
		}).find((entry) => entry.name === "Firebase emulator data is gitignored");
		Bun.spawnSync(["git", "init", "-q", root]);
		expect(await gitignored?.check(context())).toMatchObject({ ok: false });
		const fix = gitignored?.fix;
		if (typeof fix !== "function") throw new Error("no fix");
		await fix(context());
		expect(await gitignored?.check(context())).toBe(true);
	});

	it("fails when firebase.json starts no emulator", async () => {
		expect(
			await check("firebase.json exists", []).check(context()),
		).toMatchObject({
			ok: false,
		});
		expect(await check("firebase.json exists", ["auth"]).check(context())).toBe(
			true,
		);
	});
});
