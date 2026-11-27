import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { containerRuntimeForEnv, isRuntimeUp } from "../container-runtime";
import {
	checkoutFileErrors,
	checkoutFileProblem,
	checkoutFileSpecs,
	gitignoreRefusals,
	inspectCheckoutFiles,
	lastSyncReport,
} from "../core/checkout-files";
import { childProcessEnv } from "../core/child-env";
import { supportsNodeEnvProxy } from "../core/egress-guard";
import { readEnvOverrides } from "../core/env-overrides";
import {
	appendToGitignore,
	gitignoreCovers,
	isGitIgnored,
} from "../core/gitignore";
import { linkedPortsOf } from "../core/links";
import {
	describeStrayLoopbackUrl,
	findStrayLoopbackUrls,
	isDotenvPath,
	readDotenvFile,
	type StrayLoopbackUrl,
} from "../core/loopback-env";
import {
	detectPackageManager,
	matchesNodeVersion,
	parseNodeVersionOutput,
	readPinnedNodeVersion,
} from "../core/package-manager";
import { canBindPort } from "../core/process";
import { isInteractive } from "../core/prompt";
import { isCI } from "../core/runtime-flags";
import {
	InfisicalLoginError,
	infisicalLoginCommand,
} from "../core/secrets/errors";
import { describeSecretsError, fetchScopeSecrets } from "../core/secrets/index";
import { lookupOnPath } from "../core/tool-binary";
import {
	prismaSchemaHash,
	readGeneratedPrismaHash,
} from "../prisma/schema-hash";
import type { AnyDevEnvironment, ResolvedLink, SetupCheck } from "../types";
import {
	bunInstallCommand,
	pinnedBunVersion,
} from "./commands/check/bun-version";
import { configSecretScopes } from "./secrets-scopes";

/**
 * The checks every checkout gets, before the config's and its integrations'.
 *
 * Only the cheap ones are `fast`: `dev` pays for a fast check on every run in
 * every worktree, and the runtime and Prisma are already handled by `dev`
 * itself (it starts the runtime and runs `prisma.generate`).
 */

/** Whether the root `package.json` declares anything to install. */
function declaresDependencies(root: string): boolean {
	try {
		const manifest = JSON.parse(
			readFileSync(join(root, "package.json"), "utf8"),
		) as Record<string, unknown>;
		return ["dependencies", "devDependencies", "workspaces"].some(
			(field) =>
				manifest[field] !== undefined &&
				Object.keys(manifest[field] as object).length > 0,
		);
	} catch {
		return false;
	}
}

/** `node_modules` here or above: module resolution walks up, so a nested project may use its parent's. */
function hasNodeModules(root: string): boolean {
	for (let dir = root; ; dir = dirname(dir)) {
		if (existsSync(join(dir, "node_modules"))) return true;
		if (dirname(dir) === dir) return false;
	}
}

/** The config's checkout files, or none when their declaration is invalid (`doctor` reports that). */
function declaredCheckoutFiles(env: AnyDevEnvironment) {
	return checkoutFileErrors(env.checkoutFiles).length > 0
		? []
		: checkoutFileSpecs(env.checkoutFiles);
}

/**
 * Loopback URLs in this checkout's overrides, dotenv checkout files and
 * computed environment that point outside its port block: at a port nothing
 * serves, or at another checkout's.
 */
export function strayLoopbackUrls(
	env: AnyDevEnvironment,
	links: Readonly<Record<string, ResolvedLink | undefined>> = env.links,
): StrayLoopbackUrl[] {
	const dotenvFiles = declaredCheckoutFiles(env).filter((file) =>
		isDotenvPath(file.path),
	);

	return findStrayLoopbackUrls({
		sources: [
			{ source: "buncargo env set", values: readEnvOverrides(env.root) },
			...dotenvFiles.map((file) => ({
				source: file.path,
				values: readDotenvFile(env.root, file.path),
			})),
			{
				source: "the injected environment",
				values: env.buildEnvVars() as Record<string, string>,
			},
		],
		ports: env.ports as Record<string, number>,
		allowedPorts: linkedPortsOf(links),
		isListening: (port) => !canBindPort(port),
	});
}

const NODE_VERSION_TIMEOUT_MS = 5_000;

/** App subdirectories that manage their own `package.json` in a rootless repo. */
function independentAppDirs(env: AnyDevEnvironment): string[] {
	const seen = new Set<string>();
	const dirs: string[] = [];
	for (const app of Object.values(env.apps)) {
		if (!app.cwd) continue;
		const abs = resolve(env.root, app.cwd);
		if (abs === env.root || seen.has(abs)) continue;
		seen.add(abs);
		if (declaresDependencies(abs)) dirs.push(app.cwd);
	}
	return dirs;
}

/** Detect installed `node --version` on PATH, bounded so a broken shim never hangs. */
function detectNodeVersion(): string | undefined {
	const nodeBin = lookupOnPath("node", childProcessEnv());
	if (!nodeBin) return undefined;
	try {
		const result = Bun.spawnSync([nodeBin, "--version"], {
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			env: childProcessEnv(),
			timeout: NODE_VERSION_TIMEOUT_MS,
		});
		if (result.exitCode !== 0) return undefined;
		return parseNodeVersionOutput(result.stdout.toString());
	} catch {
		return undefined;
	}
}

function coreChecks(
	env: AnyDevEnvironment,
	options: { egressGuardEnabled?: boolean } = {},
): SetupCheck[] {
	const checks: SetupCheck[] = [];
	const pinned = pinnedBunVersion(env.root);
	const pinnedNode = readPinnedNodeVersion(env.root);
	let detectedNode: string | null | undefined;
	const getNodeVersion = (): string | undefined => {
		if (detectedNode === undefined) {
			detectedNode = detectNodeVersion() ?? null;
		}
		return detectedNode ?? undefined;
	};

	// A fresh worktree has none, and every app then fails on its first import
	// (`tsgo: command not found`) after the containers were already started.
	// ponytail: presence only; a lockfile edit since the install is not caught.
	if (declaresDependencies(env.root)) {
		const manager = detectPackageManager(env.root);
		checks.push({
			name: "Dependencies are installed",
			check: ({ root }) =>
				hasNodeModules(root) || { ok: false, detail: "no node_modules" },
			fix: manager.installCommand,
		});
	} else {
		// Rootless multi-package repos (no root `package.json`) install per app dir.
		const appDirs = independentAppDirs(env);
		if (appDirs.length > 0) {
			const missingDirs = (root: string) =>
				appDirs.filter((cwd) => !hasNodeModules(resolve(root, cwd)));
			const fixCommands = appDirs
				.map(
					(cwd) =>
						`(cd ${cwd} && ${detectPackageManager(resolve(env.root, cwd)).installCommand})`,
				)
				.join(" && ");
			checks.push({
				name: "App dependencies are installed",
				check: ({ root }) => {
					const missing = missingDirs(root);
					return (
						missing.length === 0 || {
							ok: false,
							detail: `no node_modules in ${missing.join(", ")}`,
						}
					);
				},
				fix: async ({ root, env: checkEnv }) => {
					for (const cwd of missingDirs(root)) {
						const manager = detectPackageManager(resolve(root, cwd));
						await checkEnv.exec(manager.installCommand, {
							cwd,
							verbose: true,
							secrets: false,
						});
					}
				},
				fixDescription: `run \`${fixCommands}\``,
			});
		}
	}

	if (pinned) {
		checks.push({
			name: `Bun ${pinned} (.bun-version)`,
			severity: "warning",
			check: () =>
				Bun.version === pinned || {
					ok: false,
					detail: `running ${Bun.version}`,
				},
			fix: bunInstallCommand(pinned),
		});
	}

	if (pinnedNode) {
		checks.push({
			name: `Node ${pinnedNode.version} (${pinnedNode.source})`,
			severity: "warning",
			fast: false,
			check: () => {
				const actual = getNodeVersion();
				if (!actual) {
					return {
						ok: false,
						detail: `node not found on PATH (expected ${pinnedNode.version})`,
					};
				}
				return (
					matchesNodeVersion(actual, pinnedNode.version) || {
						ok: false,
						detail: `running ${actual}`,
					}
				);
			},
		});
	}

	if (options.egressGuardEnabled) {
		checks.push({
			name: "Node supports NODE_USE_ENV_PROXY (egressGuard)",
			severity: "warning",
			fast: false,
			check: () => {
				const actual = getNodeVersion();
				if (!actual) return true;
				return (
					supportsNodeEnvProxy(actual) || {
						ok: false,
						detail: `Node ${actual} ignores NODE_USE_ENV_PROXY; upgrade to Node >= 22.21 or >= 24.5 so Node apps honor egressGuard`,
					}
				);
			},
		});
	}

	checks.push({
		name: ".buncargo/ is gitignored",
		severity: "warning",
		check: ({ root }) => gitignoreCovers(root, ".buncargo"),
		fix: ({ root }) => appendToGitignore(root, [".buncargo/"]),
		fixDescription: "add `.buncargo/` to .gitignore",
	});

	if (Object.keys(env.services).length > 0) {
		checks.push({
			name: "Container runtime is running",
			fast: false,
			check: () => isRuntimeUp(containerRuntimeForEnv(env)),
			fix: () => containerRuntimeForEnv(env).ensureRunning(),
			fixDescription: "start the container runtime",
		});
	}

	const scopes = configSecretScopes(env).map(({ scope }) => scope);
	const [firstScope] = scopes;
	if (firstScope) {
		const { siteUrl } = firstScope;
		const login = infisicalLoginCommand(siteUrl);
		checks.push({
			name: "Infisical secrets are readable",
			fast: false,
			check: async () => {
				const failures: string[] = [];
				for (const scope of scopes) {
					try {
						await fetchScopeSecrets(scope);
					} catch (error) {
						failures.push(
							`${scope.projectId}/${scope.environment}: ${describeSecretsError(error)}`,
						);
					}
				}
				return (
					failures.length === 0 || { ok: false, detail: failures.join("; ") }
				);
			},
			fix: async (ctx) => {
				if (!isInteractive() || isCI()) {
					throw new InfisicalLoginError(
						`The Infisical session for ${siteUrl} is missing or expired and cannot run an interactive login in a headless/CI shell.`,
						siteUrl,
					);
				}
				// `secrets: false` keeps `exec` from prefetching the expired scope before logging in.
				const result = await ctx.env.exec(login, {
					verbose: true,
					throwOnError: false,
					secrets: false,
				});
				if (result.exitCode !== 0) {
					throw new Error(`exited with code ${result.exitCode}`);
				}
			},
			fixDescription: `run \`${login}\``,
		});
	}

	const checkoutFiles = declaredCheckoutFiles(env);
	if (checkoutFiles.length > 0) {
		const paths = checkoutFiles.map((file) => file.path);

		// Fast because loading already synced them: `dev` reads that report
		// rather than forking git again. `doctor` loads without syncing and
		// inspects here.
		checks.push({
			name: "Checkout files are current",
			severity: "warning",
			check: ({ root }) => {
				const report =
					lastSyncReport(root) ?? inspectCheckoutFiles(root, checkoutFiles);
				const problems = report.files.flatMap((file) => {
					const problem = checkoutFileProblem(file);
					return problem ? [`${file.path} ${problem}`] : [];
				});
				return (
					problems.length === 0 || { ok: false, detail: problems.join("; ") }
				);
			},
		});

		checks.push({
			name: "Checkout files are gitignored",
			severity: "warning",
			fast: false,
			check: ({ root }) => {
				const refused = [...gitignoreRefusals(root, paths)].map(
					([path, reason]) => `${path} ${reason}`,
				);
				return (
					refused.length === 0 || { ok: false, detail: refused.join("; ") }
				);
			},
			// Tracked files stay tracked; the detail says how to untrack them.
			fix: ({ root }) =>
				appendToGitignore(
					root,
					[...gitignoreRefusals(root, paths)]
						.filter(([, reason]) => reason === "is not gitignored")
						.map(([path]) => `/${path}`),
				),
			fixDescription: "add them to .gitignore",
		});
	}

	// Fast: a few files and one bind probe per stray port. Silent otherwise:
	// the run falls back to a refused connection minutes later. Not before the
	// checkout has ever allocated its ports: the block is an unprobed preview
	// then, and every URL a shared file carries would read as stray. One line
	// per variable: joined, they made a warning of kilobytes on one line.
	checks.push({
		name: "Loopback URLs point at this checkout",
		severity: "warning",
		check: () => {
			// A preview (hashed, shifted past a claim, or unallocated) is no
			// block of this checkout's yet; its claim or BUNCARGO_PORT_OFFSET is.
			const ownsBlock =
				env.portOffsetProvenance === "claim" ||
				env.portOffsetProvenance === "env";
			if (!ownsBlock) return true;

			const stray = strayLoopbackUrls(env);
			return (
				stray.length === 0 || {
					ok: false,
					detail: stray.map(describeStrayLoopbackUrl).join("\n"),
				}
			);
		},
	});

	const ignored = (env.generatedFiles ?? []).filter((file) => file.gitignore);
	if (ignored.length > 0) {
		checks.push({
			name: "Generated files are gitignored",
			severity: "warning",
			// `git check-ignore` rather than reading .gitignore: patterns, nested
			// ignore files and negations all count, and only git knows them.
			fast: false,
			check: ({ root }) => {
				const tracked = ignored
					.map((file) => file.path)
					.filter((path) => !isGitIgnored(root, path));
				return (
					tracked.length === 0 || {
						ok: false,
						detail: `not ignored: ${tracked.join(", ")}`,
					}
				);
			},
			fix: ({ root }) =>
				appendToGitignore(
					root,
					ignored
						.map((file) => file.path)
						.filter((path) => !isGitIgnored(root, path)),
				),
			fixDescription: "add them to .gitignore",
		});
	}

	const prisma = env.prisma;
	if (prisma?.generateCommand) {
		const dir = join(env.root, prisma.cwd);
		checks.push({
			name: "Prisma client is generated",
			fast: false,
			check: ({ root }) => {
				const current = prismaSchemaHash(dir);
				const generated = readGeneratedPrismaHash(root);
				if (!current || current === generated) return true;
				return {
					ok: false,
					detail: generated
						? "the schema changed since the last generate"
						: "not generated by buncargo yet",
				};
			},
			fix: async () => {
				const code = await prisma.generate();
				if (code !== 0) {
					throw new Error(`prisma generate exited with ${code}`);
				}
			},
			fixDescription: `run \`${prisma.generateCommand}\``,
		});
	}

	return checks;
}

/** Core checks, then the config's `setupChecks` (its integrations' already appended there). */
export function allChecks(
	env: AnyDevEnvironment,
	configured: readonly SetupCheck[] | undefined,
	options: { egressGuardEnabled?: boolean } = {},
): SetupCheck[] {
	return [...coreChecks(env, options), ...(configured ?? [])];
}
