import { describe, expect, it } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { defineDevConfig } from "../config";
import { updateEnvOverrides } from "../core/env-overrides";
import { updateLinkPins } from "../core/links";
import { loadRuns } from "../core/run-registry";
import { freePorts, useTempHome } from "../core/test-env.testing";
import { getEnvVar } from "../core/utils";
import { firebase } from "../firebase";
import { createDevEnvironment } from "./create-dev-environment";
import { internalsOf } from "./internals";

const home = useTempHome();

/** Tiny Bun HTTP server returning 200 on every request, kept alive until killed. */
function okServerCommand(portEnvVar = "PORT"): string {
	const script = `Bun.serve({ port: Number(process.env.${portEnvVar}), fetch: () => new Response("ok") });`;
	return `${process.execPath} -e ${JSON.stringify(script)}`;
}

/** Fake `firebase` executable that prints `All emulators ready` and stays alive. */
function installFakeFirebaseCli(root: string): void {
	const binDir = join(root, "node_modules", ".bin");
	mkdirSync(binDir, { recursive: true });
	const script = join(binDir, "firebase");
	writeFileSync(
		script,
		`#!/usr/bin/env sh
echo "All emulators ready"
while true; do sleep 60; done
`,
		{ mode: 0o755 },
	);
}

describe("cross-repo linking (Kanpla mono <-> backend)", () => {
	it("supports bidirectional linking, automatic firebase emulator exports, live refresh, profiles, and never leaks unexported secrets", async () => {
		const [
			fbUiPort,
			fbHubPort,
			fbLogPort,
			fbFirestorePort,
			fbFsWsPort,
			fbAuthPort,
			fbStoragePort,
			fbPubsubPort,
			monoApiPort,
			monoFrontendPort,
			corePort,
			emailsPort,
		] = freePorts(12);

		const monoRoot = realpathSync(mkdtempSync(join(home(), "kanpla-mono-")));
		const backendRoot = realpathSync(
			mkdtempSync(join(home(), "kanpla-backend-")),
		);

		installFakeFirebaseCli(monoRoot);
		writeFileSync(
			join(monoRoot, "firebase.local-env.json"),
			JSON.stringify({
				emulators: {
					ui: { enabled: true, port: fbUiPort },
					hub: { port: fbHubPort },
					logging: { port: fbLogPort },
					firestore: { port: fbFirestorePort, websocketPort: fbFsWsPort },
					auth: { port: fbAuthPort },
					storage: { port: fbStoragePort },
					pubsub: { port: fbPubsubPort },
				},
			}),
		);
		// Local dotenv values (even if listed in exportEnv) and `buncargo env set`
		// overrides must NEVER be published to runs.json exports.
		writeFileSync(
			join(monoRoot, ".env.local"),
			"SUPER_SECRET_TOKEN=never-publish-me\nDOTENV_LISTED_SECRET=never-export-from-dotenv\n",
		);
		await updateEnvOverrides(monoRoot, {
			set: {
				OVERRIDE_LISTED_SECRET: "never-export-from-override",
				NEXT_PUBLIC_FIREBASE_CONFIG: "overridden-secret-locally",
			},
		});

		const monoConfig = defineDevConfig({
			projectPrefix: "kanpla",
			services: {},
			integrations: [
				firebase({
					configFile: "firebase.local-env.json",
					projectId: "demo-kanpla",
					persist: false,
				}),
			],
			exportEnv: [
				"NEXT_PUBLIC_FIREBASE_CONFIG",
				"DOTENV_LISTED_SECRET",
				"OVERRIDE_LISTED_SECRET",
			],
			links: {
				backend: {
					project: "kanpla-backend",
					path: "../backend",
				},
			},
			options: {
				verbose: false,
				envFiles: [".env.local"],
			},
			apps: {
				api: {
					port: monoApiPort,
					devCommand: okServerCommand(),
					healthEndpoint: "/",
					startAfter: ["firebase"],
				},
				frontend: {
					port: monoFrontendPort,
					devCommand: okServerCommand(),
					healthEndpoint: "/",
				},
			},
			env: (_ports, _urls, ctx) => ({
				NEXT_PUBLIC_FIREBASE_CONFIG: JSON.stringify({
					projectId: "demo-kanpla",
				}),
				NEXT_PUBLIC_BB_CORE_URL: ctx.links.backend?.urls.core,
				BB_CORE_URL: ctx.links.backend?.urls.core,
				EMAIL_API_URL: ctx.links.backend?.urls.emails,
			}),
			profiles: {
				cloud: {
					links: { backend: false },
				},
			},
		});

		const backendConfig = defineDevConfig({
			projectPrefix: "kanpla-backend",
			services: {},
			links: {
				kanpla: {
					project: "kanpla",
					path: "../kanpla",
					required: true,
					apps: ["firebase", "api"],
				},
			},
			options: { verbose: false },
			apps: {
				core: {
					port: corePort,
					devCommand: okServerCommand(),
					healthEndpoint: "/",
					envVars: (_ports, _urls, ctx) => {
						const kanpla = ctx.links.kanpla;
						const origins = [
							kanpla?.urls.frontend,
							kanpla?.loopbackUrls.frontend,
						].filter((value): value is string => Boolean(value));
						return {
							MONO_BASE_URL: kanpla?.loopbackUrls.api,
							FIRESTORE_EMULATOR_HOST: kanpla?.env.FIRESTORE_EMULATOR_HOST,
							FIREBASE_AUTH_EMULATOR_HOST:
								kanpla?.env.FIREBASE_AUTH_EMULATOR_HOST,
							FIREBASE_STORAGE_EMULATOR_HOST:
								kanpla?.env.FIREBASE_STORAGE_EMULATOR_HOST,
							PUBSUB_EMULATOR_HOST: kanpla?.env.PUBSUB_EMULATOR_HOST,
							FIRESTORE_MONOREPO_PROJECT_ID: kanpla?.env.GCLOUD_PROJECT,
							ALLOWED_ORIGINS: JSON.stringify([...new Set(origins)]),
						};
					},
				},
				emails: {
					port: emailsPort,
					devCommand: okServerCommand(),
					healthEndpoint: "/",
				},
			},
			env: (_ports, _urls, ctx) => ({
				MONO_REPO_PATH: ctx.links.kanpla?.root,
			}),
		});

		const monoEnv = createDevEnvironment(monoConfig, { root: monoRoot });
		const backendEnv = createDevEnvironment(backendConfig, {
			root: backendRoot,
		});

		// 1. Required link blocks backend start before mono is running.
		await expect(
			backendEnv.start({
				verbose: false,
				watchdog: false,
				productionBuild: false,
			}),
		).rejects.toThrow(/Required link "kanpla"/);

		// 2. Start mono first (backend is optional, so mono starts cleanly).
		await monoEnv.start({
			verbose: false,
			watchdog: false,
			productionBuild: false,
		});

		try {
			// Verify runs.json published Firebase emulator exports + explicit exportEnv,
			// and did NOT publish .env.local secrets.
			const monoRun = (await loadRuns()).find(
				(run) => run.sessionId === monoEnv.sessionId,
			);
			expect(monoRun?.exports?.GCLOUD_PROJECT).toBe("demo-kanpla");
			expect(monoRun?.exports?.FIRESTORE_EMULATOR_HOST).toBe(
				`127.0.0.1:${fbFirestorePort + monoEnv.portOffset}`,
			);
			expect(monoRun?.exports?.FIREBASE_AUTH_EMULATOR_HOST).toBe(
				`127.0.0.1:${fbAuthPort + monoEnv.portOffset}`,
			);
			expect(monoRun?.exports?.FIREBASE_STORAGE_EMULATOR_HOST).toBe(
				`127.0.0.1:${fbStoragePort + monoEnv.portOffset}`,
			);
			expect(monoRun?.exports?.PUBSUB_EMULATOR_HOST).toBe(
				`127.0.0.1:${fbPubsubPort + monoEnv.portOffset}`,
			);
			expect(monoRun?.exports?.NEXT_PUBLIC_FIREBASE_CONFIG).toContain(
				"demo-kanpla",
			);
			expect(monoRun?.exports?.SUPER_SECRET_TOKEN).toBeUndefined();
			expect(monoRun?.exports?.DOTENV_LISTED_SECRET).toBeUndefined();
			expect(monoRun?.exports?.OVERRIDE_LISTED_SECRET).toBeUndefined();

			// Mono has no backend link yet → NEXT_PUBLIC_BB_CORE_URL omitted so cloud/Infisical wins.
			expect(monoEnv.buildEnvVars().NEXT_PUBLIC_BB_CORE_URL).toBeUndefined();

			// 3. Backend now sees live mono and starts cleanly!
			await backendEnv.start({
				verbose: false,
				watchdog: false,
				productionBuild: false,
			});

			try {
				const coreVars = backendEnv.buildAppEnvVars("core");
				expect(coreVars.MONO_REPO_PATH).toBe(monoRoot);
				expect(coreVars.MONO_BASE_URL).toBe(monoEnv.loopbackUrls.api);
				expect(coreVars.FIRESTORE_EMULATOR_HOST).toBe(
					`127.0.0.1:${fbFirestorePort + monoEnv.portOffset}`,
				);
				expect(coreVars.FIREBASE_AUTH_EMULATOR_HOST).toBe(
					`127.0.0.1:${fbAuthPort + monoEnv.portOffset}`,
				);
				expect(coreVars.FIRESTORE_MONOREPO_PROJECT_ID).toBe("demo-kanpla");
				expect(JSON.parse(coreVars.ALLOWED_ORIGINS)).toContain(
					monoEnv.loopbackUrls.frontend,
				);

				// 4. Bidirectional live refresh: mono's buildEnvVars immediately sees
				// newly started backend (what `buncargo restart api` uses!).
				const refreshedMonoVars = monoEnv.buildEnvVars();
				expect(refreshedMonoVars.NEXT_PUBLIC_BB_CORE_URL).toBe(
					backendEnv.urls.core,
				);
				expect(refreshedMonoVars.EMAIL_API_URL).toBe(backendEnv.urls.emails);

				// 5. Profile disabling the link hides backend even while it runs.
				const cloudMono = internalsOf(monoEnv).withProfile("cloud");
				expect(cloudMono.links.backend).toBeUndefined();
				expect(
					cloudMono.buildEnvVars().NEXT_PUBLIC_BB_CORE_URL,
				).toBeUndefined();

				// 6. getEnvVar sees the live link from mono's checkout directory.
				const prevCwd = process.cwd();
				process.chdir(monoRoot);
				try {
					expect(getEnvVar(monoConfig, "NEXT_PUBLIC_BB_CORE_URL")).toBe(
						backendEnv.urls.core,
					);
				} finally {
					process.chdir(prevCwd);
				}
			} finally {
				await backendEnv.stop({ verbose: false });
			}
		} finally {
			await monoEnv.stop({ verbose: false });
		}
	});

	it("disambiguates two running worktrees of a linked project once pinned", async () => {
		const [portA, portB] = freePorts(2);
		const consumerRoot = realpathSync(mkdtempSync(join(home(), "consumer-")));
		const targetA = realpathSync(mkdtempSync(join(home(), "target-a-")));
		const targetB = realpathSync(mkdtempSync(join(home(), "target-b-")));

		const makeTarget = (root: string, port: number) =>
			createDevEnvironment(
				defineDevConfig({
					projectPrefix: "shared-api",
					services: {},
					options: { verbose: false },
					apps: {
						api: { port, devCommand: okServerCommand(), healthEndpoint: "/" },
					},
				}),
				{ root },
			);

		const envA = makeTarget(targetA, portA);
		const envB = makeTarget(targetB, portB);
		const consumer = createDevEnvironment(
			defineDevConfig({
				projectPrefix: "frontend-app",
				services: {},
				links: {
					api: { project: "shared-api", required: true },
				},
				env: (_ports, _urls, ctx) => ({
					UPSTREAM_API_URL: ctx.links.api?.urls.api,
				}),
			}),
			{ root: consumerRoot },
		);

		await envA.start({
			verbose: false,
			watchdog: false,
			productionBuild: false,
		});
		await envB.start({
			verbose: false,
			watchdog: false,
			productionBuild: false,
		});

		try {
			// Unpinned with two running worktrees -> ambiguous!
			expect(consumer.links.api).toBeUndefined();
			expect(internalsOf(consumer).inspectLinks()[0]?.status).toBe("ambiguous");
			await expect(
				consumer.start({ verbose: false, watchdog: false }),
			).rejects.toThrow(/matched 2 running checkouts/);

			// Pin to targetB -> resolves deterministically to targetB.
			await updateLinkPins(consumerRoot, { set: { api: targetB } });
			expect(consumer.links.api?.root).toBe(targetB);
			expect(consumer.buildEnvVars().UPSTREAM_API_URL).toBe(envB.urls.api);
		} finally {
			await envA.stop({ verbose: false });
			await envB.stop({ verbose: false });
		}
	});

	it("omits firebase emulator exports when firebase app is not started and ignores suffixed CI runs", async () => {
		const [
			fbUiPort,
			fbHubPort,
			fbLogPort,
			fbFirestorePort,
			fbFsWsPort,
			apiPort,
			ciApiPort,
		] = freePorts(7);
		const monoRoot = realpathSync(mkdtempSync(join(home(), "fb-partial-")));
		const consumerRoot = realpathSync(
			mkdtempSync(join(home(), "fb-consumer-")),
		);

		installFakeFirebaseCli(monoRoot);
		writeFileSync(
			join(monoRoot, "firebase.json"),
			JSON.stringify({
				emulators: {
					ui: { enabled: true, port: fbUiPort },
					hub: { port: fbHubPort },
					logging: { port: fbLogPort },
					firestore: { port: fbFirestorePort, websocketPort: fbFsWsPort },
				},
			}),
		);

		const monoConfig = defineDevConfig({
			projectPrefix: "partial-mono",
			services: {},
			integrations: [
				firebase({
					projectId: "demo-partial",
					persist: false,
				}),
			],
			options: { verbose: false },
			apps: {
				api: {
					port: apiPort,
					devCommand: okServerCommand(),
					healthEndpoint: "/",
				},
			},
		});

		const monoEnv = createDevEnvironment(monoConfig, { root: monoRoot });
		const suffixedEnv = createDevEnvironment(
			defineDevConfig({
				projectPrefix: "partial-mono",
				services: {},
				options: { verbose: false },
				apps: {
					api: {
						port: ciApiPort,
						devCommand: okServerCommand(),
						healthEndpoint: "/",
					},
				},
			}),
			{ root: monoRoot, suffix: "ci-throwaway" },
		);
		const consumer = createDevEnvironment(
			defineDevConfig({
				projectPrefix: "partial-backend",
				services: {},
				links: { mono: { project: "partial-mono" } },
			}),
			{ root: consumerRoot },
		);

		// Start only `api` (NOT `firebase`) + a suffixed CI run on the same root.
		await monoEnv.start({
			onlyApps: ["api"],
			verbose: false,
			watchdog: false,
			productionBuild: false,
		});
		await suffixedEnv.start({
			verbose: false,
			watchdog: false,
			productionBuild: false,
		});

		try {
			const monoRun = (await loadRuns()).find(
				(run) => run.sessionId === monoEnv.sessionId,
			);
			// No dead emulator env vars published when `firebase` did not run.
			expect(monoRun?.exports?.FIRESTORE_EMULATOR_HOST).toBeUndefined();
			expect(monoRun?.exports?.GCLOUD_PROJECT).toBeUndefined();

			// Consumer links to the real dev run, NOT the suffixed CI run!
			expect(consumer.links.mono?.ports.api).toBe(monoEnv.ports.api);
			expect(consumer.links.mono?.projectName).toBe(monoEnv.projectName);
		} finally {
			await suffixedEnv.stop({ verbose: false });
			await monoEnv.stop({ verbose: false });
		}
	});

	it("restarts apps declaring restartOn: ['links.<alias>'] and re-renders generatedFiles when a linked repo starts or stops", async () => {
		const [monoApiPort, backendCorePort] = freePorts(2);
		const monoRoot = realpathSync(mkdtempSync(join(home(), "reactive-mono-")));
		const backendRoot = realpathSync(
			mkdtempSync(join(home(), "reactive-backend-")),
		);

		const echoServerScript = `Bun.serve({ port: Number(process.env.PORT), fetch: () => new Response(process.env.BB_CORE_URL ?? "unset") });`;
		const echoServerCommand = `${process.execPath} -e ${JSON.stringify(echoServerScript)}`;

		const monoEnv = createDevEnvironment(
			defineDevConfig({
				projectPrefix: "reactive-mono",
				services: {},
				links: {
					backend: {
						project: "reactive-backend",
						apps: ["core"],
					},
				},
				options: { verbose: false },
				generatedFiles: [
					{
						path: ".linked-backend.txt",
						render: (ctx) => ctx.links.backend?.urls.core ?? "none",
					},
				],
				apps: {
					api: {
						port: monoApiPort,
						devCommand: echoServerCommand,
						healthEndpoint: "/",
						restartOn: ["links.backend"],
					},
				},
				env: (_ports, _urls, ctx) => ({
					BB_CORE_URL: ctx.links.backend?.urls.core,
				}),
			}),
			{ root: monoRoot },
		);

		const backendEnv = createDevEnvironment(
			defineDevConfig({
				projectPrefix: "reactive-backend",
				services: {},
				options: { verbose: false },
				apps: {
					core: {
						port: backendCorePort,
						devCommand: okServerCommand(),
						healthEndpoint: "/",
					},
				},
			}),
			{ root: backendRoot },
		);

		async function fetchText(url: string): Promise<string | undefined> {
			try {
				const res = await fetch(url);
				return res.ok ? await res.text() : undefined;
			} catch {
				return undefined;
			}
		}

		async function waitForValue(
			read: () => Promise<string | undefined>,
			expected: string,
			timeoutMs = 8_000,
		): Promise<void> {
			const deadline = Date.now() + timeoutMs;
			let last: string | undefined;
			while (Date.now() < deadline) {
				last = await read();
				if (last === expected) return;
				await Bun.sleep(50);
			}
			throw new Error(
				`Expected "${expected}" within ${timeoutMs}ms, last value was "${String(last)}"`,
			);
		}

		await monoEnv.start({
			verbose: false,
			watchdog: false,
			productionBuild: false,
		});

		try {
			const apiUrl = monoEnv.loopbackUrls.api;
			expect(await fetchText(apiUrl)).toBe("unset");
			expect(readFileSync(join(monoRoot, ".linked-backend.txt"), "utf8")).toBe(
				"none",
			);

			// Starting backend triggers reactive restart of mono's `api` + generated file update!
			await backendEnv.start({
				verbose: false,
				watchdog: false,
				productionBuild: false,
			});
			try {
				await waitForValue(() => fetchText(apiUrl), backendEnv.urls.core);
				expect(
					readFileSync(join(monoRoot, ".linked-backend.txt"), "utf8"),
				).toBe(backendEnv.urls.core);
			} finally {
				await backendEnv.stop({ verbose: false });
			}

			// Stopping backend triggers reactive restart back to unset!
			await waitForValue(() => fetchText(apiUrl), "unset");
			expect(readFileSync(join(monoRoot, ".linked-backend.txt"), "utf8")).toBe(
				"none",
			);
		} finally {
			await monoEnv.stop({ verbose: false });
		}
	});
});
