import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineDevConfig } from "../config";
import { useTempHome } from "../core/test-env.testing";
import { getEnvVar } from "../core/utils";
import { createDevEnvironment } from "../environment";
import type {
	AnyDevEnvironment,
	CheckContext,
	DevConfig,
	GeneratedFileContext,
} from "../types";
import {
	evaluateJavaVersion,
	firebaseChecks,
	parseJavaMajorVersion,
} from "./checks";
import {
	anchorPort,
	emulatorPorts,
	generatedFirebaseConfig,
	selectEmulators,
} from "./emulators";
import { emulatorTmpDir, firebase } from "./index";
import {
	emulatorCloudSdkDir,
	mergeJavaToolOptions,
	resolveJavaHeap,
} from "./jvm";
import { readFirebaseProject } from "./project";

useTempHome("all");
const saved = {
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
			"demo-myapp",
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

	it("normalizes multi-target storage arrays to a single rules object for demo-* projects", () => {
		const rawWithTargets = {
			storage: [
				{ target: "allergen-uploads", rules: "allergen.storage.rules" },
				{ target: "default", rules: "storage.rules" },
			],
			emulators: { storage: { port: 9199 } },
		};
		const selected = selectEmulators(rawWithTargets);
		const ports = emulatorPorts(rawWithTargets, selected, 0);

		// Prefers the "default" target for demo-* projects.
		const demoDefault = generatedFirebaseConfig(
			rawWithTargets,
			selected,
			ports,
			"demo-kanpla",
		);
		expect(demoDefault.storage).toEqual({ rules: "storage.rules" });

		// Falls back to the first entry with rules when no "default" target exists.
		const rawNoDefault = {
			storage: [
				{ target: "no-rules" },
				{ target: "uploads", rules: "uploads.storage.rules" },
				{ target: "assets", rules: "assets.storage.rules" },
			],
			emulators: { storage: { port: 9199 } },
		};
		const demoFallback = generatedFirebaseConfig(
			rawNoDefault,
			selected,
			ports,
			"demo-kanpla",
		);
		expect(demoFallback.storage).toEqual({ rules: "uploads.storage.rules" });

		// Leaves multi-target arrays intact for real Firebase projects (.firebaserc targets apply).
		const realProject = generatedFirebaseConfig(
			rawWithTargets,
			selected,
			ports,
			"kanpla-dev",
		);
		expect(realProject.storage).toEqual(rawWithTargets.storage);

		// Single-object storage stays untouched.
		const rawSingle = {
			storage: { rules: "storage.rules" },
			emulators: { storage: { port: 9199 } },
		};
		expect(
			generatedFirebaseConfig(rawSingle, selected, ports, "demo-kanpla")
				.storage,
		).toEqual({ rules: "storage.rules" });
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
		expect(Buffer.byteLength(socket)).toBeLessThan(104);

		// When TMPDIR itself is too long to leave room for the socket, fall back to /tmp.
		const prevTmpdir = process.env.TMPDIR;
		process.env.TMPDIR = `/tmp/${"sandbox-".repeat(12)}`;
		try {
			const fallbackDir = emulatorTmpDir(root);
			expect(fallbackDir.startsWith("/tmp/bcfb-")).toBe(true);
			expect(
				Buffer.byteLength(join(fallbackDir, `fire_emu_${"0".repeat(16)}.sock`)),
			).toBeLessThan(104);
		} finally {
			if (prevTmpdir === undefined) delete process.env.TMPDIR;
			else process.env.TMPDIR = prevTmpdir;
		}
	});

	it("removes a hub locator a killed suite left, and keeps a live one's", async () => {
		const checkout = join(root, "hub-locator-checkout");
		const dir = emulatorTmpDir(checkout);
		mkdirSync(dir, { recursive: true });
		try {
			const dead = Bun.spawnSync(["true"]).pid;
			const stale = join(dir, "hub-demo.json");
			const live = join(dir, "hub-live.json");
			writeFileSync(stale, JSON.stringify({ port: 4400, pid: dead }));
			writeFileSync(live, JSON.stringify({ port: 4401, pid: process.pid }));

			await firebase().hooks?.beforeServers?.({ root: checkout } as never);

			expect(existsSync(stale)).toBe(false);
			expect(existsSync(live)).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
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

	it("supports a custom configFile and writes firebase.buncargo.json beside it", () => {
		const customDir = join(root, "custom-fb");
		mkdirSync(join(customDir, "configs"), { recursive: true });
		writeFileSync(
			join(customDir, "configs", "firebase.local.json"),
			JSON.stringify({
				storage: [
					{ target: "uploads", rules: "uploads.rules" },
					{ target: "default", rules: "storage.rules" },
				],
				emulators: {
					auth: { port: 9099 },
					storage: { port: 9199 },
					ui: { enabled: true, port: 4000 },
				},
			}),
		);
		writeFileSync(
			join(customDir, ".firebaserc"),
			JSON.stringify({ projects: { default: "demo-custom" } }),
		);

		try {
			const integration = firebase({
				workdir: "custom-fb",
				configFile: "configs/firebase.local.json",
			});
			const env = createDevEnvironment(
				{ ...config, integrations: [integration] },
				{ root },
			);

			expect(env.apps.firebase?.devCommand).toContain(
				"--config configs/firebase.buncargo.json --project demo-custom --only auth,storage",
			);
			const file = env.generatedFiles?.find(
				(entry) => entry.path === "custom-fb/configs/firebase.buncargo.json",
			);
			expect(file?.gitignore).toBe(true);
			const rendered = JSON.parse(
				file?.render({
					ports: env.ports as Record<string, number>,
				} as GeneratedFileContext) ?? "{}",
			);
			expect(rendered.storage).toEqual({ rules: "storage.rules" });
			expect(rendered.emulators.storage.port).toBe(9299);
			expect(
				integration.setupChecks?.some(
					(entry) => entry.name === "configs/firebase.local.json exists",
				),
			).toBe(true);
		} finally {
			rmSync(customDir, { recursive: true, force: true });
		}
	});

	it("injects JVM heap via JAVA_TOOL_OPTIONS when javaHeap is set", () => {
		const prev = process.env.JAVA_TOOL_OPTIONS;
		try {
			delete process.env.JAVA_TOOL_OPTIONS;
			const env = createDevEnvironment(
				{ ...config, integrations: [firebase({ javaHeap: "6g" })] },
				{ root },
			);
			expect(env.buildAppEnvVars("firebase")).toMatchObject({
				JAVA_TOOL_OPTIONS: "-Xmx6g",
			});
			expect(env.buildAppEnvVars("web")).not.toHaveProperty(
				"JAVA_TOOL_OPTIONS",
			);

			// Preserves existing JAVA_TOOL_OPTIONS flags when -Xmx is absent.
			process.env.JAVA_TOOL_OPTIONS = "-Dfile.encoding=UTF-8";
			expect(env.buildAppEnvVars("firebase")).toMatchObject({
				JAVA_TOOL_OPTIONS: "-Dfile.encoding=UTF-8 -Xmx6g",
			});

			// Skips injecting when -Xmx is already explicitly set by the user.
			process.env.JAVA_TOOL_OPTIONS = "-Xms1g -Xmx10g -XX:+UseG1GC";
			expect(env.buildAppEnvVars("firebase")).not.toHaveProperty(
				"JAVA_TOOL_OPTIONS",
			);
		} finally {
			if (prev === undefined) delete process.env.JAVA_TOOL_OPTIONS;
			else process.env.JAVA_TOOL_OPTIONS = prev;
		}
	});

	it("isolates Google credentials by default for demo-* projects across firebase, sibling apps, and exportEnv", async () => {
		const demoEnv = createDevEnvironment(config, { root });
		expect(demoEnv.buildAppEnvVars("firebase")).toMatchObject({
			GOOGLE_APPLICATION_CREDENTIALS: "",
			CLOUDSDK_CONFIG: emulatorCloudSdkDir(emulatorTmpDir(root)),
		});
		expect(demoEnv.buildAppEnvVars("web")).toMatchObject({
			GOOGLE_APPLICATION_CREDENTIALS: "",
			CLOUDSDK_CONFIG: emulatorCloudSdkDir(emulatorTmpDir(root)),
		});
		const demoIntegration = firebase();
		createDevEnvironment(
			{ ...config, integrations: [demoIntegration] },
			{ root },
		);
		expect(
			demoIntegration.exportEnv?.({
				root,
				ports: demoEnv.ports,
				selectedApps: ["firebase", "web"],
			} as never),
		).toMatchObject({
			GOOGLE_APPLICATION_CREDENTIALS: "",
			CLOUDSDK_CONFIG: emulatorCloudSdkDir(emulatorTmpDir(root)),
		});

		// Explicit opt-out on demo-* project.
		const demoUnisolated = createDevEnvironment(
			{ ...config, integrations: [firebase({ isolateCredentials: false })] },
			{ root },
		);
		expect(demoUnisolated.buildAppEnvVars("firebase")).not.toHaveProperty(
			"GOOGLE_APPLICATION_CREDENTIALS",
		);
		expect(demoUnisolated.buildAppEnvVars("web")).not.toHaveProperty(
			"GOOGLE_APPLICATION_CREDENTIALS",
		);
		expect(demoUnisolated.buildAppEnvVars("firebase")).not.toHaveProperty(
			"CLOUDSDK_CONFIG",
		);

		// Non-demo project does not isolate by default, unless explicitly opted in.
		const realDefault = createDevEnvironment(
			{ ...config, integrations: [firebase({ projectId: "myapp-dev" })] },
			{ root },
		);
		expect(realDefault.buildAppEnvVars("firebase")).not.toHaveProperty(
			"GOOGLE_APPLICATION_CREDENTIALS",
		);
		expect(realDefault.buildAppEnvVars("web")).not.toHaveProperty(
			"CLOUDSDK_CONFIG",
		);

		const realIsolated = createDevEnvironment(
			{
				...config,
				integrations: [
					firebase({ projectId: "myapp-dev", isolateCredentials: true }),
				],
			},
			{ root },
		);
		expect(realIsolated.buildAppEnvVars("firebase")).toMatchObject({
			GOOGLE_APPLICATION_CREDENTIALS: "",
			CLOUDSDK_CONFIG: emulatorCloudSdkDir(emulatorTmpDir(root)),
		});
		expect(realIsolated.buildAppEnvVars("web")).toMatchObject({
			GOOGLE_APPLICATION_CREDENTIALS: "",
			CLOUDSDK_CONFIG: emulatorCloudSdkDir(emulatorTmpDir(root)),
		});

		// beforeServers creates the empty CLOUDSDK_CONFIG directory when isolating.
		const checkout = join(root, "gcloud-isolation-checkout");
		const tmpDir = emulatorTmpDir(checkout);
		try {
			const integration = firebase({ projectId: "demo-isolated" });
			await integration.hooks?.beforeServers?.({ root: checkout } as never);
			expect(existsSync(emulatorCloudSdkDir(tmpDir))).toBe(true);
		} finally {
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("omits emulator env, credential isolation, and checks when an active profile excludes firebase", async () => {
		const profiledConfig = defineDevConfig({
			projectPrefix: "fbprofile",
			services: {},
			integrations: [
				firebase({
					publicEnvPrefix: "NEXT_PUBLIC_",
				}),
			],
			apps: {
				web: { port: 3000, devCommand: "echo web" },
			},
			profiles: {
				local: { apps: ["firebase", "web"] },
				cloud: { apps: ["web"] },
				"local-fast": {
					apps: ["firebase", "web"],
					integrations: [
						firebase({
							emulators: ["auth", "firestore"],
							publicEnvPrefix: "NEXT_PUBLIC_",
						}),
					],
				},
			},
		});

		const localEnv = createDevEnvironment(profiledConfig, {
			root,
			profile: "local",
		});
		expect(localEnv.buildEnvVars()).toHaveProperty("FIRESTORE_EMULATOR_HOST");
		expect(localEnv.buildAppEnvVars("web")).toHaveProperty(
			"GOOGLE_APPLICATION_CREDENTIALS",
			"",
		);

		const cloudEnv = createDevEnvironment(profiledConfig, {
			root,
			profile: "cloud",
		});
		expect(cloudEnv.buildEnvVars()).not.toHaveProperty(
			"FIRESTORE_EMULATOR_HOST",
		);
		expect(cloudEnv.buildEnvVars()).not.toHaveProperty(
			"NEXT_PUBLIC_FIRESTORE_EMULATOR_HOST",
		);
		expect(cloudEnv.buildAppEnvVars("web")).not.toHaveProperty(
			"GOOGLE_APPLICATION_CREDENTIALS",
		);

		// Profile-level integration override drops functions emulator for local-fast.
		const fastEnv = createDevEnvironment(profiledConfig, {
			root,
			profile: "local-fast",
		}) as unknown as AnyDevEnvironment;
		expect(fastEnv.apps.firebase?.devCommand).toContain(
			"--only auth,firestore",
		);
		expect(fastEnv.apps.firebase?.devCommand).not.toContain("functions");
		expect(fastEnv.buildEnvVars()).not.toHaveProperty(
			"FIREBASE_FUNCTIONS_EMULATOR_HOST",
		);

		// describe() also stays empty when activeApps excludes firebase.
		const gatedIntegration = firebase();
		createDevEnvironment(
			{
				projectPrefix: "fbdesc",
				services: {},
				integrations: [gatedIntegration],
				apps: { web: { port: 3000, devCommand: "echo web" } },
			},
			{ root },
		);
		expect(
			gatedIntegration.describe?.({
				root,
				ports: {},
				urls: {},
				loopbackUrls: {},
				activeApps: new Set(["web"]),
			} as never),
		).toEqual({});
	});

	it("validates and resolves profiles that add firebase() when the base config has no firebase()", () => {
		const baseNoFirebase = defineDevConfig({
			projectPrefix: "fbadded",
			services: {},
			apps: {
				web: { port: 3000, devCommand: "echo web" },
			},
			profiles: {
				emulators: {
					integrations: [firebase({ emulators: ["auth", "firestore"] })],
					apps: ["firebase", "web"],
				},
			},
		});

		const env = createDevEnvironment(baseNoFirebase, {
			root,
			profile: "emulators",
		}) as unknown as AnyDevEnvironment;
		expect(env.apps.firebase).toBeDefined();
		expect(env.buildEnvVars()).toHaveProperty("FIRESTORE_EMULATOR_HOST");

		const prevCwd = process.cwd();
		process.chdir(root);
		try {
			expect(
				getEnvVar(baseNoFirebase as unknown as DevConfig, "FIREBASE_PORT", {
					profile: "emulators",
				}),
			).toBe(4100);
			expect(
				getEnvVar(baseNoFirebase as unknown as DevConfig, "FIREBASE_PORT"),
			).toBeUndefined();
		} finally {
			process.chdir(prevCwd);
		}
	});

	it("honors defaults: false and .infisical.json workspaceId in secretScopes()", () => {
		const scopeRoot = mkdtempSync(join(tmpdir(), "buncargo-fb-scopes-"));
		try {
			writeFileSync(
				join(scopeRoot, "firebase.json"),
				JSON.stringify({ functions: { source: "functions" } }),
			);
			writeFileSync(
				join(scopeRoot, ".infisical.json"),
				JSON.stringify({ workspaceId: "ws-fb-auto" }),
			);
			const integration = firebase({
				functionsEnv: { secrets: { path: "/functions" } },
			});
			expect(
				integration.secretScopes?.({
					selectedApps: ["firebase"],
					root: scopeRoot,
					defaults: false,
				}),
			).toEqual([]);
			expect(
				integration.secretScopes?.({
					selectedApps: ["firebase"],
					root: scopeRoot,
					defaults: undefined,
				}),
			).toEqual([{ path: "/functions", projectId: "ws-fb-auto" }]);
		} finally {
			rmSync(scopeRoot, { recursive: true, force: true });
		}
	});

	it("clears a broken JAVA_HOME for the firebase app without touching a valid one", () => {
		const prevJavaHome = process.env.JAVA_HOME;
		try {
			process.env.JAVA_HOME = join(root, "does-not-exist-jdk");
			const env = createDevEnvironment(config, { root });
			expect(env.buildAppEnvVars("firebase")).toMatchObject({ JAVA_HOME: "" });
			expect(env.buildAppEnvVars("web")).not.toHaveProperty("JAVA_HOME");

			const validJdk = join(root, "fake-valid-jdk");
			mkdirSync(join(validJdk, "bin"), { recursive: true });
			writeFileSync(join(validJdk, "bin", "java"), "");
			process.env.JAVA_HOME = validJdk;
			expect(env.buildAppEnvVars("firebase")).not.toHaveProperty("JAVA_HOME");
		} finally {
			if (prevJavaHome === undefined) delete process.env.JAVA_HOME;
			else process.env.JAVA_HOME = prevJavaHome;
			rmSync(join(root, "fake-valid-jdk"), { recursive: true, force: true });
		}
	});

	it("renders functionsEnv on beforeServers and restores/removes it on afterServersStop", async () => {
		const fnCheckout = join(root, "fn-env-checkout");
		mkdirSync(join(fnCheckout, "functions"), { recursive: true });
		writeFileSync(
			join(fnCheckout, "firebase.json"),
			JSON.stringify({
				functions: { source: "functions" },
				emulators: {
					functions: { port: 5001 },
					ui: { enabled: true, port: 4000 },
				},
			}),
		);
		const integration = firebase({
			functionsEnv: {
				values: {
					UNLEASH_URL: "https://unleash.example.com",
					FB_PRIVATE_KEY_DEV: "secret-key",
					GCLOUD_PROJECT: "must-strip",
				},
				exclude: ["FB_PRIVATE_KEY_*"],
			},
		});
		const env = createDevEnvironment(
			{
				projectPrefix: "fnenv",
				services: {},
				integrations: [integration],
				apps: {},
			},
			{ root: fnCheckout },
		);

		const envPath = join(fnCheckout, "functions", ".env");
		await integration.hooks?.beforeServers?.({
			root: fnCheckout,
			selectedApps: ["firebase"],
			ports: env.ports,
		} as never);

		expect(existsSync(envPath)).toBe(true);
		const content = readFileSync(envPath, "utf8");
		expect(content).toContain("UNLEASH_URL='https://unleash.example.com'");
		expect(content).not.toContain("FB_PRIVATE_KEY_DEV");
		expect(content).not.toContain("GCLOUD_PROJECT");

		await integration.hooks?.afterServersStop?.({ root: fnCheckout } as never);
		expect(existsSync(envPath)).toBe(false);
		rmSync(fnCheckout, { recursive: true, force: true });
	});
});

describe("javaHeap helpers", () => {
	const GIB = 1024 ** 3;

	it("resolves auto heap to half of system memory clamped to 1g..8g", () => {
		expect(resolveJavaHeap(undefined, 16 * GIB)).toBeUndefined();
		expect(resolveJavaHeap("   ", 16 * GIB)).toBeUndefined();
		expect(resolveJavaHeap("6g", 16 * GIB)).toBe("6g");
		expect(resolveJavaHeap(" 2048m ", 16 * GIB)).toBe("2048m");
		expect(resolveJavaHeap("auto", 1 * GIB)).toBe("1g");
		expect(resolveJavaHeap("auto", 2 * GIB)).toBe("1g");
		expect(resolveJavaHeap("auto", 12 * GIB)).toBe("6g");
		expect(resolveJavaHeap("auto", 15 * GIB)).toBe("7g");
		expect(resolveJavaHeap("auto", 16 * GIB)).toBe("8g");
		expect(resolveJavaHeap("auto", 64 * GIB)).toBe("8g");
		expect(() => resolveJavaHeap("bogus", 16 * GIB)).toThrow(
			'Invalid firebase() javaHeap "bogus"',
		);
		expect(() => resolveJavaHeap("0g", 16 * GIB)).toThrow(
			'Invalid firebase() javaHeap "0g"',
		);
		expect(() => resolveJavaHeap("0", 16 * GIB)).toThrow(
			'Invalid firebase() javaHeap "0"',
		);
		expect(() => firebase({ javaHeap: "not-a-size" })).toThrow(
			'Invalid firebase() javaHeap "not-a-size"',
		);
	});

	it("merges -Xmx into JAVA_TOOL_OPTIONS without clobbering user settings", () => {
		expect(mergeJavaToolOptions(undefined, undefined)).toBeUndefined();
		expect(mergeJavaToolOptions(undefined, "6g")).toBe("-Xmx6g");
		expect(mergeJavaToolOptions("-Dfile.encoding=UTF-8", "6g")).toBe(
			"-Dfile.encoding=UTF-8 -Xmx6g",
		);
		expect(mergeJavaToolOptions("-XX:+UseG1GC", "-Xmx4g")).toBe(
			"-XX:+UseG1GC -Xmx4g",
		);
		expect(mergeJavaToolOptions("-Xmx4g", "6g")).toBeUndefined();
		expect(
			mergeJavaToolOptions("-Xms1g -Xmx4096m -Dfile.encoding=UTF-8", "6g"),
		).toBeUndefined();
	});
});

describe("Java version parsing and evaluation", () => {
	it("parses legacy 1.x and modern java -version outputs", () => {
		expect(
			parseJavaMajorVersion(
				'java version "1.8.0_412"\nJava(TM) SE Runtime Environment (build 1.8.0_412-b08)',
			),
		).toBe(8);
		expect(
			parseJavaMajorVersion(
				'openjdk version "11.0.24" 2024-07-16\nOpenJDK Runtime Environment',
			),
		).toBe(11);
		expect(
			parseJavaMajorVersion(
				'openjdk version "17.0.12" 2024-07-16 LTS\nOpenJDK 64-Bit Server VM',
			),
		).toBe(17);
		expect(
			parseJavaMajorVersion(
				'openjdk version "21" 2023-09-19\nOpenJDK Runtime Environment',
			),
		).toBe(21);
		expect(parseJavaMajorVersion('openjdk version "22-ea" 2024-03-19')).toBe(
			22,
		);
		expect(parseJavaMajorVersion("openjdk 21.0.5 2024-10-15")).toBe(21);
		expect(
			parseJavaMajorVersion("Unable to locate a Java Runtime."),
		).toBeUndefined();
	});

	it("fails on Java < 11 or < 21 with firebase-tools 14+, warns on 11..20 with 13.x", () => {
		expect(evaluateJavaVersion(undefined, undefined)).toMatchObject({
			ok: false,
		});
		const java8 = evaluateJavaVersion(8, "13.29.0");
		expect(java8).toMatchObject({ ok: false });
		expect(typeof java8 === "object" && java8.severity).toBeUndefined();

		const java17On14 = evaluateJavaVersion(17, "14.2.0");
		expect(java17On14).toMatchObject({ ok: false });
		expect(
			typeof java17On14 === "object" && java17On14.severity,
		).toBeUndefined();

		expect(evaluateJavaVersion(17, "13.29.1")).toMatchObject({
			ok: false,
			severity: "warning",
		});
		expect(evaluateJavaVersion(17, undefined)).toMatchObject({
			ok: false,
			severity: "warning",
		});
		expect(evaluateJavaVersion(21, "14.2.0")).toBe(true);
		expect(evaluateJavaVersion(21, "13.29.1")).toBe(true);
		expect(evaluateJavaVersion(21, undefined)).toBe(true);
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

	function writeStubJava(binDir: string, versionOutput: string): void {
		mkdirSync(binDir, { recursive: true });
		const script = join(binDir, "java");
		writeFileSync(
			script,
			`#!/bin/sh\necho ${JSON.stringify(versionOutput)} >&2\n`,
		);
		chmodSync(script, 0o755);
	}

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

	it("validates the real Java major version against firebase-tools", async () => {
		const javaCheckName = "Java is installed for the Firebase emulators";
		const savedPath = process.env.PATH;
		const caseRoot = mkdtempSync(join(tmpdir(), "buncargo-fb-java-"));
		const binDir = join(caseRoot, "bin");
		const pkgDir = join(caseRoot, "node_modules", "firebase-tools");
		mkdirSync(pkgDir, { recursive: true });

		const runCheck = () => {
			const entry = firebaseChecks({
				project: () => readFirebaseProject(caseRoot),
				workdir: () => caseRoot,
				emulators: () => ["firestore"],
				dataDir: () => undefined,
			}).find((item) => item.name === javaCheckName);
			if (!entry) throw new Error("missing java check");
			return entry.check({
				root: caseRoot,
				env: {} as AnyDevEnvironment,
			} as CheckContext);
		};

		try {
			process.env.PATH = binDir;

			// Java 8 fails outright even on firebase-tools 13.
			writeFileSync(
				join(pkgDir, "package.json"),
				JSON.stringify({ name: "firebase-tools", version: "13.29.0" }),
			);
			writeStubJava(binDir, 'java version "1.8.0_412"');
			const res8 = await runCheck();
			expect(res8).toMatchObject({ ok: false });
			expect(typeof res8 === "object" && res8.severity).toBeUndefined();

			// Java 17 warns on firebase-tools 13.
			writeStubJava(binDir, 'openjdk version "17.0.12" 2024-07-16');
			expect(await runCheck()).toMatchObject({
				ok: false,
				severity: "warning",
			});

			// Java 17 fails on firebase-tools 14.
			writeFileSync(
				join(pkgDir, "package.json"),
				JSON.stringify({ name: "firebase-tools", version: "14.1.0" }),
			);
			const res17On14 = await runCheck();
			expect(res17On14).toMatchObject({ ok: false });
			expect(
				typeof res17On14 === "object" && res17On14.severity,
			).toBeUndefined();

			// Java 21 passes on firebase-tools 14.
			writeStubJava(binDir, 'openjdk version "21.0.4" 2024-07-16');
			expect(await runCheck()).toBe(true);

			// Reads JDK `release` file without spawning `java -version` when present.
			const jdkBin = join(caseRoot, "jdk21", "bin");
			mkdirSync(jdkBin, { recursive: true });
			writeFileSync(
				join(caseRoot, "jdk21", "release"),
				'JAVA_VERSION="21.0.5"\n',
			);
			const failingJava = join(jdkBin, "java");
			writeFileSync(failingJava, "#!/bin/sh\nexit 99\n");
			chmodSync(failingJava, 0o755);
			process.env.PATH = jdkBin;
			expect(await runCheck()).toBe(true);
		} finally {
			process.env.PATH = savedPath;
			rmSync(caseRoot, { recursive: true, force: true });
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

	it("skips firebase checks when activeApps excludes firebase and uses package-manager fix hints", async () => {
		const path = process.env.PATH;
		const caseRoot = mkdtempSync(join(tmpdir(), "buncargo-fb-pm-"));
		writeFileSync(join(caseRoot, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
		process.env.PATH = join(caseRoot, "no-bin");
		try {
			const checks = firebaseChecks({
				project: () => readFirebaseProject(caseRoot),
				workdir: () => caseRoot,
				emulators: () => ["firestore", "pubsub"],
				dataDir: () => undefined,
				root: caseRoot,
				appName: "firebase",
			});
			// Every check passes immediately when activeApps does not include "firebase".
			const cloudCtx = {
				root: caseRoot,
				env: {} as AnyDevEnvironment,
				activeApps: new Set(["web"]),
			} as CheckContext;
			for (const entry of checks) {
				expect(await entry.check(cloudCtx)).toBe(true);
			}

			// Pub/Sub is a JVM emulator too, and the CLI check recommends pnpm add -D.
			const cliCheck = checks.find((entry) => entry.name.includes("CLI"));
			const cliResult = await cliCheck?.check({
				root: caseRoot,
				env: {} as AnyDevEnvironment,
			} as CheckContext);
			expect(cliResult).toBe(false);
			expect(cliCheck?.fix).toBe("pnpm add -D firebase-tools");

			const javaCheck = checks.find((entry) => entry.name.includes("Java"));
			const javaResult = await javaCheck?.check({
				root: caseRoot,
				env: {} as AnyDevEnvironment,
			} as CheckContext);
			expect(javaResult).toMatchObject({ ok: false });
		} finally {
			process.env.PATH = path;
			rmSync(caseRoot, { recursive: true, force: true });
		}
	});

	it("ensures pubsubTopics via onAppReady against the Pub/Sub emulator", async () => {
		const created: string[] = [];
		const server = Bun.serve({
			port: 0,
			fetch(req) {
				if (req.method === "PUT") {
					created.push(new URL(req.url).pathname);
					return new Response("{}", { status: 200 });
				}
				return new Response("not found", { status: 404 });
			},
		});
		const psRoot = mkdtempSync(join(tmpdir(), "buncargo-fb-pubsub-"));
		const serverPort = server.port;
		if (serverPort === undefined) throw new Error("server bound no port");
		try {
			writeFileSync(
				join(psRoot, "firebase.json"),
				JSON.stringify({
					emulators: {
						ui: { enabled: true, port: 4000 },
						pubsub: { port: serverPort },
					},
				}),
			);
			const integration = firebase({
				projectId: "demo-pubsub",
				pubsubTopics: ["orders.created", "emails.send"],
			});
			const env = createDevEnvironment(
				{
					projectPrefix: "fbps",
					services: {},
					integrations: [integration],
					apps: {},
				} as DevConfig,
				{ root: psRoot },
			);
			const portOffset = (env.ports.firebase ?? 4000) - 4000;
			const adjustedServerPort = serverPort - portOffset;
			writeFileSync(
				join(psRoot, "firebase.json"),
				JSON.stringify({
					emulators: {
						ui: { enabled: true, port: 4000 },
						pubsub: { port: adjustedServerPort },
					},
				}),
			);
			const freshIntegration = firebase({
				projectId: "demo-pubsub",
				pubsubTopics: ["orders.created", "emails.send"],
			});
			const freshEnv = createDevEnvironment(
				{
					projectPrefix: "fbps",
					services: {},
					integrations: [freshIntegration],
					apps: {},
				} as DevConfig,
				{ root: psRoot },
			);
			await freshIntegration.onAppReady?.({
				name: "firebase",
				config: freshEnv.apps.firebase,
				port: freshEnv.ports.firebase,
				ports: freshEnv.ports,
				urls: freshEnv.urls,
				loopbackUrls: freshEnv.loopbackUrls,
				root: psRoot,
				workspaceId: freshEnv.workspaceId,
			});
			expect(created).toEqual([
				"/v1/projects/demo-pubsub/topics/orders.created",
				"/v1/projects/demo-pubsub/topics/emails.send",
			]);
		} finally {
			server.stop(true);
			rmSync(psRoot, { recursive: true, force: true });
		}
	});
});
