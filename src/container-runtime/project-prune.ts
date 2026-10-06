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

import { resolve } from "node:path";
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

export function planProjectPrune(input: ProjectPruneInput): ProjectPrunePlan {
	const kept = new Set<string>();
	// Each disposable name, and the checkouts whose name it is.
	const disposable = new Map<string, Set<string>>();
	const dispose = (name: string, root: string) =>
		disposable.set(
			name,
			(disposable.get(name) ?? new Set()).add(resolve(root)),
		);
	for (const checkout of input.checkouts) {
		const names = namesOf(input, checkout);
		for (const name of names.ci) dispose(name, checkout.root);
		for (const name of names.dev) {
			if (checkout.exists) kept.add(name);
			else dispose(name, checkout.root);
		}
	}

	const why = new Map<string, string>();
	for (const name of input.liveProjects) why.set(name, "a run is using it");
	for (const container of input.resources.containers) {
		// Compared as recorded, not resolved through links: a stack started
		// from a symlink to a checkout is named after the link, so its name
		// can read as that checkout's ci stack while being a dev stack.
		const owners = disposable.get(container.project);
		if (container.running)
			why.set(container.project, "a container is running (stop it first)");
		else if (!container.root || !owners?.has(resolve(container.root)))
			why.set(
				container.project,
				"a container was not started by buncargo from the checkout this name belongs to",
			);
	}

	const plan: ProjectPrunePlan = { remove: [], kept: [] };
	const stacks = new Map<string, ProjectPruneStack>();
	const stackOf = (project: string) => {
		const owners = disposable.get(project);
		if (!owners || kept.has(project) || why.has(project)) return undefined;
		// Its containers' checkout when it has any (they all agree by now).
		const root =
			input.resources.containers.find((c) => c.project === project)?.root ??
			[...owners][0] ??
			"";
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
