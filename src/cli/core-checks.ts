import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { containerRuntimeForEnv } from "../container-runtime";
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

/** Whether `.gitignore` names a path, the way a person would write it. */
function gitignoreCovers(root: string, path: string): boolean {
	try {
		const bare = path.replace(/^\/+|\/+$/g, "");
		return readFileSync(join(root, ".gitignore"), "utf8")
			.split("\n")
			.map((line) => line.trim().replace(/^\/+|\/+$/g, ""))
			.some((line) => line === bare || line === `${bare}/**`);
	} catch {
		return false;
	}
}

/** Whether git ignores a path; outside a git checkout nothing is. */
function isGitIgnored(root: string, path: string): boolean {
	const result = Bun.spawnSync(["git", "check-ignore", "-q", path], {
		cwd: root,
		stdout: "ignore",
		stderr: "ignore",
	});
	return result.exitCode === 0;
}

/** Append lines to `.gitignore`, creating it when missing. */
function appendToGitignore(root: string, lines: readonly string[]): void {
	const path = join(root, ".gitignore");
	const current = existsSync(path) ? readFileSync(path, "utf8") : "";
	const prefix = current && !current.endsWith("\n") ? "\n" : "";
	writeFileSync(path, `${current}${prefix}${lines.join("\n")}\n`);
}

function coreChecks(env: AnyDevEnvironment): SetupCheck[] {
	const checks: SetupCheck[] = [];
	const pinned = pinnedBunVersion(env.root);

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
