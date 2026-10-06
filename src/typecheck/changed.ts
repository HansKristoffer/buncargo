import { readFileSync } from "node:fs";
import { join } from "node:path";
import fg from "fast-glob";
import { CONFIG_FILES } from "../loader/find-config-file";

/**
 * `typecheck --changed`: which workspaces a change can break.
 *
 * A changed file selects the workspace that contains it, and every workspace
 * that depends on that one through its package.json, transitively: a change
 * to a shared package can break an app that only imports it. A change to a
 * root file that shapes every program (a manifest, the lockfile, a root
 * tsconfig, the dev config) selects everything, the root config check
 * included.
 */

export interface WorkspaceNode {
	path: string;
	name?: string;
	dependencies: string[];
}

export type ChangedSelection =
	| { kind: "all" }
	| { kind: "workspaces"; paths: string[] };

const ROOT_WIDE_FILE =
	/^(package\.json|bun\.lockb?|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|tsconfig[^/]*\.json)$/;

function containingPath(file: string, paths: readonly string[]) {
	// Longest match first, so `packages/a/b` beats `packages/a`.
	return [...paths]
		.sort((a, b) => b.length - a.length)
		.find((path) => path === "." || file.startsWith(`${path}/`));
}

export function selectChangedWorkspaces(
	changedFiles: readonly string[],
	graph: readonly WorkspaceNode[],
	checkablePaths: readonly string[],
): ChangedSelection {
	const graphPaths = graph.map((node) => node.path);
	// A `typecheck.include` of "." contains everything; it must not hide a
	// root-wide file.
	const nestedPaths = [...graphPaths, ...checkablePaths].filter(
		(path) => path !== ".",
	);
	const rootWide = changedFiles.some(
		(file) =>
			!containingPath(file, nestedPaths) &&
			(ROOT_WIDE_FILE.test(file) || CONFIG_FILES.includes(file)),
	);
	if (rootWide) return { kind: "all" };

	const pathByName = new Map(
		graph.flatMap((node) => (node.name ? [[node.name, node.path]] : [])),
	);
	const dependents = new Map<string, string[]>();
	for (const node of graph) {
		for (const dependency of node.dependencies) {
			const target = pathByName.get(dependency);
			if (!target) continue;
			dependents.set(target, [...(dependents.get(target) ?? []), node.path]);
		}
	}

	const affected = new Set<string>();
	const visit = (path: string) => {
		if (affected.has(path)) return;
		affected.add(path);
		for (const dependent of dependents.get(path) ?? []) visit(dependent);
	};
	for (const file of changedFiles) {
		const path = containingPath(file, [...graphPaths, ...checkablePaths]);
		if (path) visit(path);
	}

	return {
		kind: "workspaces",
		paths: checkablePaths.filter((path) => affected.has(path)),
	};
}

/** Every package in the workspace patterns, typecheck script or not. */
export async function readWorkspaceGraph(
	root: string,
	patterns: readonly string[],
): Promise<WorkspaceNode[]> {
	const manifests = await fg(
		patterns.map((pattern) => `${pattern.replace(/\/$/, "")}/package.json`),
		{ cwd: root, ignore: ["**/node_modules/**"] },
	);

	const nodes: WorkspaceNode[] = [];
	for (const manifest of manifests) {
		try {
			const pkg = JSON.parse(readFileSync(join(root, manifest), "utf8"));
			nodes.push({
				path: manifest.replace(/\/package\.json$/, ""),
				name: typeof pkg.name === "string" ? pkg.name : undefined,
				dependencies: Object.keys({
					...pkg.dependencies,
					...pkg.devDependencies,
					...pkg.peerDependencies,
				}),
			});
		} catch {
			// An unreadable manifest has no edges to follow.
		}
	}
	return nodes;
}

function git(root: string, args: string[]) {
	const result = Bun.spawnSync(["git", ...args], {
		cwd: root,
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		ok: result.exitCode === 0,
		lines: result.stdout.toString().split("\n").filter(Boolean),
	};
}

/**
 * Files changed since the merge base with `ref` (default: the remote's default
 * branch), committed or not, plus untracked files. Deleted files count: a
 * removed export breaks its importers. Paths are relative to `root`.
 */
export function changedFilesSince(root: string, ref?: string): string[] {
	const candidates = ref ? [ref] : ["origin/HEAD", "origin/main", "main"];
	const base = candidates
		.map((candidate) => git(root, ["merge-base", "HEAD", candidate]))
		.find((result) => result.ok)?.lines[0];
	if (!base) {
		throw new Error(
			ref
				? `--changed: no merge base between HEAD and "${ref}".`
				: "--changed: no origin/HEAD, origin/main or main to compare against. Pass --changed=<ref>.",
		);
	}

	// --no-renames: a rename lists only its new path, and the workspace the
	// file left can break too.
	const tracked = git(root, [
		"diff",
		"--name-only",
		"--relative",
		"--no-renames",
		base,
	]);
	const untracked = git(root, ["ls-files", "--others", "--exclude-standard"]);
	return [...new Set([...tracked.lines, ...untracked.lines])];
}
