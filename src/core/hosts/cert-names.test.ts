import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type CertNameEntry,
	forgetCertNames,
	pruneCertNameEntries,
	readCertNames,
	rememberCertNames,
} from "./cert-names";

const dirs: string[] = [];

function tempPath(): string {
	const dir = mkdtempSync(join(tmpdir(), "buncargo-cert-names-"));
	dirs.push(dir);
	return join(dir, "cert-names.json");
}

afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

const alive = () => true;

/**
 * One leaf serves every project on the machine. Minting it from the live route
 * registry alone meant a project stopping dropped its names, and starting it
 * again reminted — which rebinds the daemon and drops every other project's
 * websockets. Two projects alternating reminted on every run.
 */
describe("rememberCertNames", () => {
	it("returns this project's names on a first run", async () => {
		const path = tempPath();
		expect(
			await rememberCertNames({
				root: "/repo/a",
				names: ["a.localhost", "*.a.localhost"],
				path,
				rootExists: alive,
			}),
		).toEqual(["*.a.localhost", "a.localhost"]);
	});

	it("keeps a project's names while it is not running", async () => {
		const path = tempPath();
		await rememberCertNames({
			root: "/repo/a",
			names: ["a.localhost"],
			path,
			rootExists: alive,
		});
		const union = await rememberCertNames({
			root: "/repo/b",
			names: ["b.localhost"],
			path,
			rootExists: alive,
		});
		expect(union).toEqual(["a.localhost", "b.localhost"]);
	});

	it("replaces a project's own names rather than accumulating them", async () => {
		const path = tempPath();
		await rememberCertNames({
			root: "/repo/a",
			names: ["old.localhost"],
			path,
			rootExists: alive,
		});
		expect(
			await rememberCertNames({
				root: "/repo/a",
				names: ["new.localhost"],
				path,
				rootExists: alive,
			}),
		).toEqual(["new.localhost"]);
	});

	// A caller that only wants the union — the second sync pass in
	// `activateNamedHosts` — must not be able to erase a project by omission.
	it("does not erase a project when called with no names", async () => {
		const path = tempPath();
		await rememberCertNames({
			root: "/repo/a",
			names: ["a.localhost"],
			path,
			rootExists: alive,
		});
		expect(
			await rememberCertNames({
				root: "/repo/a",
				names: [],
				path,
				rootExists: alive,
			}),
		).toEqual(["a.localhost"]);
	});

	it("reads the union without recording anything", async () => {
		const path = tempPath();
		await rememberCertNames({
			root: "/repo/a",
			names: ["a.localhost"],
			path,
			rootExists: alive,
		});
		// The real `existsSync` applies here, and /repo/a is fictional.
		expect(await readCertNames(path)).toEqual([]);
	});

	it("forgets a project on request", async () => {
		const path = tempPath();
		await rememberCertNames({
			root: "/repo/a",
			names: ["a.localhost"],
			path,
			rootExists: alive,
		});
		await forgetCertNames("/repo/a", path);
		expect(
			await rememberCertNames({ names: [], path, rootExists: alive }),
		).toEqual([]);
	});
});

/**
 * A deleted worktree is the one case where names must go: nothing else retires
 * them, and its hostnames would widen the certificate forever.
 */
describe("pruneCertNameEntries", () => {
	const entry = (root: string, updatedAt: string): CertNameEntry => ({
		root,
		names: [`${root}.localhost`],
		updatedAt,
	});

	it("drops entries whose checkout is gone", () => {
		const kept = pruneCertNameEntries(
			[
				entry("/gone", "2026-01-01T00:00:00.000Z"),
				entry("/here", "2026-01-02T00:00:00.000Z"),
			],
			(root) => root === "/here",
		);
		expect(kept.map((item) => item.root)).toEqual(["/here"]);
	});

	it("keeps the newest first, so a cap drops the stalest", () => {
		const kept = pruneCertNameEntries(
			[
				entry("/old", "2026-01-01T00:00:00.000Z"),
				entry("/new", "2026-06-01T00:00:00.000Z"),
			],
			alive,
		);
		expect(kept.map((item) => item.root)).toEqual(["/new", "/old"]);
	});
});
