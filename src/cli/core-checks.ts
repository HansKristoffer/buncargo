import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { containerRuntimeForEnv } from "../container-runtime";
import {
	type CheckoutFileStatus,
	checkoutFileErrors,
	checkoutFileSpecs,
	gitignoreRefusals,
	inspectCheckoutFiles,
	lastSyncReport,
} from "../core/checkout-files";
import { readEnvOverrides } from "../core/env-overrides";
import {
	appendToGitignore,
	gitignoreCovers,
	isGitIgnored,
} from "../core/gitignore";
import {
	describeStrayLoopbackUrl,
	findStrayLoopbackUrls,
	isDotenvPath,
	readDotenvFile,
	type StrayLoopbackUrl,
} from "../core/loopback-env";
import { canBindPort } from "../core/process";
import {
	describeSecretsError,
	fetchScopeSecrets,
	resolveScope,
	scopeKey,
} from "../core/secrets/infisical";
import {
	prismaSchemaHash,
	readGeneratedPrismaHash,
} from "../prisma/schema-hash";
import type { AnyDevEnvironment, SetupCheck } from "../types";

/**
 * The checks every checkout gets, before the config's and its integrations'.
 *
 * Only the cheap ones are `fast`: `dev` pays for a fast check on every run in
 * every worktree, and the runtime and Prisma are already handled by `dev`
 * itself (it starts the runtime and runs `prisma.generate`).
 */

/** The version `.bun-version` pins, when the checkout has one. */
function pinnedBunVersion(root: string): string | undefined {
	try {
		const pinned = readFileSync(join(root, ".bun-version"), "utf8").trim();
		return pinned.replace(/^v/, "") || undefined;
	} catch {
		return undefined;
	}
}

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

/**
 * What a checkout file needs and the command that fixes it, after its path
 * ("has local edits (…)"); undefined when nothing.
 */
export function checkoutFileProblem(
	file: CheckoutFileStatus,
): string | undefined {
	if (file.refusal) return `${file.refusal}, so it is not synced`;
	switch (file.state) {
		case "in-sync":
		case "missing":
			return undefined;
		case "local-edits":
			return `has local edits (\`buncargo files save ${file.path}\` shares them)`;
		case "store-newer":
			return `is behind the file store (\`buncargo files pull ${file.path}\`)`;
		case "conflict":
			return file.mergeable
				? `and the file store both changed (\`buncargo files merge ${file.path}\` keeps both, or \`files save\` keeps yours, \`files pull --force\` the store's)`
				: `and the file store both changed (\`buncargo files save ${file.path}\` keeps yours, \`files pull --force\` the store's)`;
		default: {
			const exhaustive: never = file.state;
			throw new Error(`Unhandled checkout file state: ${String(exhaustive)}`);
		}
	}
}

/**
 * Loopback URLs in this checkout's overrides, dotenv checkout files and
 * computed environment that point outside its port block: at a port nothing
 * serves, or at another checkout's.
 */
export function strayLoopbackUrls(env: AnyDevEnvironment): StrayLoopbackUrl[] {
	const files = checkoutFileErrors(env.checkoutFiles).length
		? []
		: checkoutFileSpecs(env.checkoutFiles).filter((file) =>
				isDotenvPath(file.path),
			);
	return findStrayLoopbackUrls({
		sources: [
			{ source: "buncargo env set", values: readEnvOverrides(env.root) },
			...files.map((file) => ({
				source: file.path,
				values: readDotenvFile(env.root, file.path),
			})),
			{
				source: "the injected environment",
				values: env.buildEnvVars() as Record<string, string>,
			},
		],
		ports: env.ports as Record<string, number>,
		isListening: (port) => !canBindPort(port),
	});
}

function coreChecks(env: AnyDevEnvironment): SetupCheck[] {
	const checks: SetupCheck[] = [];
	const pinned = pinnedBunVersion(env.root);

	// A fresh worktree has none, and every app then fails on its first import
	// (`tsgo: command not found`) after the containers were already started.
	// ponytail: presence only; a lockfile edit since the install is not caught.
	if (declaresDependencies(env.root)) {
		checks.push({
			name: "Dependencies are installed",
			check: ({ root }) =>
				hasNodeModules(root) || { ok: false, detail: "no node_modules" },
			fix: "bun install",
		});
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
			fix: `curl -fsSL https://bun.sh/install | bash -s "bun-v${pinned}"`,
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
			check: () => containerRuntimeForEnv(env).isAvailable(),
			fix: () => containerRuntimeForEnv(env).ensureRunning(),
			fixDescription: "start the container runtime",
		});
	}

	const scopes = [
		env.secrets,
		...Object.values(env.apps).map((app) => app.secrets),
	]
		.map((scope) => (scope ? resolveScope(scope, env.secrets) : undefined))
		.filter((scope) => scope !== undefined);
	if (scopes.length > 0) {
		checks.push({
			name: "Infisical secrets are readable",
			fast: false,
			check: async () => {
				const failures: string[] = [];
				for (const scope of new Map(
					scopes.map((entry) => [scopeKey(entry), entry]),
				).values()) {
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
			fix: `infisical login --domain=${scopes[0]?.siteUrl}`,
		});
	}

	const checkoutFiles = checkoutFileErrors(env.checkoutFiles).length
		? []
		: checkoutFileSpecs(env.checkoutFiles);
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
	// the run falls back to a refused connection minutes later.
	checks.push({
		name: "Loopback URLs point at this checkout",
		severity: "warning",
		check: () => {
			const stray = strayLoopbackUrls(env);
			return (
				stray.length === 0 || {
					ok: false,
					detail: stray.map(describeStrayLoopbackUrl).join("; "),
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
				if (code !== 0) throw new Error(`prisma generate exited with ${code}`);
			},
			fixDescription: `run \`${prisma.generateCommand}\``,
		});
	}

	return checks;
}

/** Core checks, then the config's own, then its integrations' (already appended there). */
export function allChecks(env: AnyDevEnvironment): SetupCheck[] {
	return [...coreChecks(env), ...(env.checks ?? [])];
}
