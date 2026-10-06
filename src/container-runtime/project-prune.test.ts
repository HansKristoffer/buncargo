import { describe, expect, it } from "bun:test";
import type { GitCheckout } from "../core/git-checkouts";
import { type ProjectPruneInput, planProjectPrune } from "./project-prune";
import type { ComposeProjectContainer } from "./types";

const main: GitCheckout = {
	root: "/code/shopify-app-template",
	worktree: null,
	exists: true,
};
const feature: GitCheckout = {
	root: "/wt/t3code-feature",
	worktree: "t3code-feature",
	exists: true,
};
const deleted: GitCheckout = {
	root: "/wt/t3code-gone",
	worktree: "t3code-gone",
	exists: false,
};

const container = (
	id: string,
	project: string,
	options: Partial<ComposeProjectContainer> = {},
): ComposeProjectContainer => ({
	id,
	project,
	running: false,
	root: "",
	...options,
});

function plan(
	input: {
		checkouts?: GitCheckout[];
		containers?: ComposeProjectContainer[];
		volumes?: string[];
	} & Partial<Pick<ProjectPruneInput, "liveProjects" | "worktreeIsolation">>,
) {
	return planProjectPrune({
		projectPrefix: "shopify-app",
		worktreeIsolation: input.worktreeIsolation,
		checkouts: input.checkouts ?? [main, feature, deleted],
		resources: {
			containers: input.containers ?? [],
			volumes: (input.volumes ?? []).map((project) => ({
				name: `${project}_data`,
				project,
			})),
			networks: [],
		},
		liveProjects: input.liveProjects ?? new Set(),
	});
}

const removedVolumes = (result: ReturnType<typeof plan>) =>
	result.remove.flatMap((stack) => stack.volumes).sort();

describe("planProjectPrune", () => {
	it("removes existing checkouts' ci stacks and every stack of a deleted worktree, current and older names", () => {
		const result = plan({
			containers: [
				container("ci", "shopify-app-t3code-feature-ci", {
					root: feature.root,
				}),
				container("gone", "shopify-app-t3code-gone", { root: deleted.root }),
				container("dev", "shopify-app-t3code-feature", { root: feature.root }),
			],
			volumes: [
				"shopify-app-t3code-feature-ci",
				"shopify-app-t3code-feature-ci-t3code-feature",
				"shopify-app-shopify-app-template-ci",
				"shopify-app-t3code-gone",
				"shopify-app-t3code-gone-t3code-gone",
				"shopify-app-t3code-gone-ci-t3code-gone",
				"shopify-app-t3code-feature",
				"shopify-app-t3code-feature-t3code-feature",
				"shopify-app-shopify-app-template",
			],
		});
		expect(result.remove.flatMap((stack) => stack.containers).sort()).toEqual([
			"ci",
			"gone",
		]);
		expect(removedVolumes(result)).toEqual([
			"shopify-app-shopify-app-template-ci_data",
			"shopify-app-t3code-feature-ci-t3code-feature_data",
			"shopify-app-t3code-feature-ci_data",
			"shopify-app-t3code-gone-ci-t3code-gone_data",
			"shopify-app-t3code-gone-t3code-gone_data",
			"shopify-app-t3code-gone_data",
		]);
		expect(result.kept).toEqual([]);
	});

	it("names the checkout each stack belongs to, for its lock", () => {
		const result = plan({ volumes: ["shopify-app-t3code-gone"] });
		expect(result.remove).toEqual([
			{
				projectName: "shopify-app-t3code-gone",
				root: deleted.root,
				containers: [],
				volumes: ["shopify-app-t3code-gone_data"],
				networks: [],
			},
		]);
	});

	it("never touches a stack it cannot trace to one of this project's checkouts, whatever its prefix", () => {
		expect(
			plan({
				containers: [container("other", "shopify-app-other-main")],
				volumes: [
					"shopify-app-other-main",
					"shopify-app-other-main-ci",
					"shopify-app-t3code-feature-ci-extra",
					"bulkhead-wp-1-ci",
				],
			}),
		).toEqual({ remove: [], kept: [] });
	});

	it("keeps a renamed checkout's dev stack even though it looks like a ci name", () => {
		const renamed = {
			root: "/wt/renamed",
			worktree: "ci-feature",
			exists: true,
		};
		expect(
			removedVolumes(
				plan({
					checkouts: [main, renamed],
					volumes: ["shopify-app-renamed-ci-feature", "shopify-app-renamed-ci"],
				}),
			),
		).toEqual([]);
	});

	it("lets an existing checkout's dev stack win over another checkout's ci name", () => {
		const a = { root: "/wt/a", worktree: "a", exists: true };
		const aCi = { root: "/other/a", worktree: "ci", exists: true };
		expect(
			removedVolumes(
				plan({ checkouts: [main, a, aCi], volumes: ["shopify-app-a-ci"] }),
			),
		).toEqual([]);
	});

	it("keeps all of a stack while one of its containers runs, and says why", () => {
		const result = plan({
			containers: [
				container("pg", "shopify-app-t3code-feature-ci", {
					running: true,
					root: feature.root,
				}),
				container("redis", "shopify-app-t3code-feature-ci", {
					root: feature.root,
				}),
			],
			volumes: ["shopify-app-t3code-feature-ci"],
		});
		expect(result.remove).toEqual([]);
		expect(result.kept).toEqual([
			{
				projectName: "shopify-app-t3code-feature-ci",
				reason: "a container is running (stop it first)",
			},
		]);
	});

	it("keeps a stack a live run is using, containers or not", () => {
		const result = plan({
			volumes: ["shopify-app-t3code-feature-ci"],
			liveProjects: new Set(["shopify-app-t3code-feature-ci"]),
		});
		expect(result.remove).toEqual([]);
		expect(result.kept.map((stack) => stack.reason)).toEqual([
			"a run is using it",
		]);
	});

	it("keeps a stack with a container buncargo did not label", () => {
		expect(
			removedVolumes(
				plan({
					containers: [container("x", "shopify-app-t3code-gone")],
					volumes: ["shopify-app-t3code-gone"],
				}),
			),
		).toEqual([]);
	});

	it("keeps a stack another checkout started, even when its name matches one of ours", () => {
		expect(
			removedVolumes(
				plan({
					containers: [
						container("x", "shopify-app-t3code-gone", {
							root: "/elsewhere/t3code-gone",
						}),
					],
					volumes: ["shopify-app-t3code-gone"],
				}),
			),
		).toEqual([]);
	});

	it("follows worktreeIsolation: false, where worktrees share no name suffix", () => {
		const renamed = { root: "/wt/renamed", worktree: "feature", exists: false };
		expect(
			removedVolumes(
				plan({
					checkouts: [main, renamed],
					worktreeIsolation: false,
					volumes: ["shopify-app-renamed", "shopify-app-renamed-feature"],
				}),
			),
		).toEqual(["shopify-app-renamed_data"]);
	});
});
