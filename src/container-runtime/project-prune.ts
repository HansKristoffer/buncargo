/**
 * `buncargo prune --project`: this project's leftover stacks, and nothing else.
 *
 * The machine-wide prune can only say "no container and no run mentions this
 * volume's project", which is true of every project's leftovers alike. Here
 * the config and Git say which stacks are this project's, by exact name: the
 * names buncargo gives each checkout Git knows of, the deleted worktrees
 * included. Never a prefix match, which another project's or another
 * checkout's stack can share.
 *
 * Disposable: every checkout's `ci` stack, and every stack of a deleted
 * worktree. Kept, whatever its name: an existing checkout's dev stack (its
 * database), a stack with a running container or a live run, and a stack
 * with a container that buncargo did not start from one of these checkouts.
 */

import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { GitCheckout } from "../core/git-checkouts";
import {
	CI_PROJECT_SUFFIX,
	checkoutProjectNames,
	getProjectName,
	worktreeProjectSuffix,
} from "../core/ports";
import type { ComposeProjectResources } from "./types";

export interface ProjectPruneStack {
	projectName: string;
	/** The checkout it belongs to, for its lifecycle lock. */
	root: string;
	containers: string[];
	volumes: string[];
	networks: string[];
}

export interface ProjectPruneInput {
	projectPrefix: string;
	worktreeIsolation?: boolean;
	checkouts: readonly GitCheckout[];
	resources: ComposeProjectResources;
	/** Projects a live run in `runs.json` is using. */
	liveProjects: ReadonlySet<string>;
}

export interface ProjectPrunePlan {
	remove: ProjectPruneStack[];
	/** Disposable by name, but left alone, and why. */
	kept: { projectName: string; reason: string }[];
}

/**
 * Every name a checkout's stacks have had. Before 12.0 a worktree's name was
 * always appended, even when its directory already said it.
 */
function namesOf(input: ProjectPruneInput, checkout: GitCheckout) {
	const { projectPrefix, worktreeIsolation } = input;
	const current = checkoutProjectNames({
		projectPrefix,
		root: checkout.root,
		worktree: checkout.worktree,
		worktreeIsolation,
	});
	const dev = [current.dev];
	const ci = [current.ci];
	if (checkout.worktree !== null && worktreeIsolation !== false) {
		const suffix = worktreeProjectSuffix(checkout.worktree);
		dev.push(getProjectName(projectPrefix, suffix, checkout.root));
		ci.push(
			getProjectName(
				projectPrefix,
				`${CI_PROJECT_SUFFIX}-${suffix}`,
				checkout.root,
			),
		);
	}
	return { dev, ci };
}

/** A path as a label recorded it: real, where it still exists. */
function canonical(path: string): string {
	if (existsSync(path)) return realpathSync(path);
	const parent = dirname(path);
	return existsSync(parent)
		? join(realpathSync(parent), basename(path))
		: resolve(path);
}

export function planProjectPrune(input: ProjectPruneInput): ProjectPrunePlan {
	const kept = new Set<string>();
	const disposable = new Map<string, string>();
	for (const checkout of input.checkouts) {
		const names = namesOf(input, checkout);
		for (const name of names.ci) disposable.set(name, checkout.root);
		for (const name of names.dev) {
			if (checkout.exists) kept.add(name);
			else disposable.set(name, checkout.root);
		}
	}

	const roots = new Set(
		input.checkouts.map((checkout) => canonical(checkout.root)),
	);
	const why = new Map<string, string>();
	for (const name of input.liveProjects) why.set(name, "a run is using it");
	for (const container of input.resources.containers) {
		if (container.running)
			why.set(container.project, "a container is running (stop it first)");
		else if (!container.root || !roots.has(canonical(container.root)))
			why.set(
				container.project,
				"a container was not started by buncargo from one of this project's checkouts",
			);
	}

	const plan: ProjectPrunePlan = { remove: [], kept: [] };
	const stacks = new Map<string, ProjectPruneStack>();
	const stackOf = (project: string) => {
		const root = disposable.get(project);
		if (root === undefined || kept.has(project) || why.has(project))
			return undefined;
		let stack = stacks.get(project);
		if (!stack) {
			stack = {
				projectName: project,
				root,
				containers: [],
				volumes: [],
				networks: [],
			};
			stacks.set(project, stack);
			plan.remove.push(stack);
		}
		return stack;
	};
	for (const container of input.resources.containers)
		stackOf(container.project)?.containers.push(container.id);
	for (const volume of input.resources.volumes)
		stackOf(volume.project)?.volumes.push(volume.name);
	for (const network of input.resources.networks)
		stackOf(network.project)?.networks.push(network.name);

	const present = new Set(
		[
			...input.resources.containers,
			...input.resources.volumes,
			...input.resources.networks,
		].map((resource) => resource.project),
	);
	for (const [project, reason] of why) {
		if (disposable.has(project) && !kept.has(project) && present.has(project))
			plan.kept.push({ projectName: project, reason });
	}
	plan.remove.sort((a, b) => a.projectName.localeCompare(b.projectName));
	plan.kept.sort((a, b) => a.projectName.localeCompare(b.projectName));
	return plan;
}
