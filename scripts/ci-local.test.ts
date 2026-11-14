import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	ciEnvironment,
	OPT_IN_JOBS,
	readCiJobs,
	selectCiJobs,
} from "./ci-local";

const WORKFLOW = `
jobs:
  title:
    steps:
      - uses: actions/github-script@v8
  test:
    strategy:
      matrix:
        os: [ubuntu-latest, macos-15]
    steps:
      - uses: actions/checkout@v5
      - name: Test
        run: bun run test
      - run: |
          bun run build
          bun run verify:package
      - name: Tag
        run: echo \${{ github.sha }}
  docker:
    steps:
      - run: bun scripts/verify-docker.ts
`;

describe("readCiJobs", () => {
	it("reads each job's commands in order and names what only a runner can do", () => {
		const [title, test] = readCiJobs(WORKFLOW, "linux");

		expect(title).toEqual({
			name: "title",
			steps: [],
			skipped: ["actions/github-script@v8"],
			otherPlatforms: [],
		});
		expect(test).toEqual({
			name: "test",
			steps: [
				{ name: "Test", run: "bun run test" },
				{
					name: "bun run build",
					run: "bun run build\nbun run verify:package\n",
				},
			],
			skipped: ["actions/checkout@v5", "Tag"],
			otherPlatforms: ["macos-15"],
		});
		expect(readCiJobs(WORKFLOW, "darwin")[1]?.otherPlatforms).toEqual([
			"ubuntu-latest",
		]);
	});
});

describe("selectCiJobs", () => {
	const jobs = readCiJobs(WORKFLOW, "linux");
	const names = (named?: string[]) =>
		selectCiJobs(jobs, named).map((job) => job.name);

	it("takes every job with a command but the opt-in ones, unless named", () => {
		expect(names()).toEqual(["test"]);
		expect(names(["docker", "test"])).toEqual(["test", "docker"]);
	});

	it("refuses a job the workflow does not have", () => {
		expect(() => names(["tests"])).toThrow(
			"No job named tests in .github/workflows/ci.yml. Jobs: title, test, docker",
		);
	});
});

it("gives every command a runner's variables and none of the shell's buncargo flags", () => {
	expect(
		ciEnvironment({
			PATH: "/usr/bin",
			BUNCARGO_HOSTS: "0",
			BUNCARGO_URL_HOST: "worker.ts.net",
		}),
	).toEqual({ PATH: "/usr/bin", CI: "true", GITHUB_ACTIONS: "true" });
});

// A job added to ci.yml runs here by default. One that must not (it needs a
// daemon, or reaches outside the checkout) gets a reason in OPT_IN_JOBS.
it("covers this repository's workflow", () => {
	const workflow = readFileSync(
		join(import.meta.dir, "..", ".github/workflows/ci.yml"),
		"utf8",
	);
	const jobs = readCiJobs(workflow, "linux");

	expect(selectCiJobs(jobs, undefined).map((job) => job.name)).toEqual([
		"lint",
		"test",
		"startup",
	]);
	for (const name of Object.keys(OPT_IN_JOBS))
		expect(jobs.map((job) => job.name)).toContain(name);
	// No command is left out for an expression this script cannot evaluate.
	const unrunnable = jobs.flatMap((job) =>
		job.skipped.filter((step) => !step.includes("@")),
	);
	expect(unrunnable).toEqual([]);
});
