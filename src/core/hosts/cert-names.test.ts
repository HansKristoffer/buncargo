import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
} from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unreadableCheckout } from "../checkout-presence.testing";
import { useTempHome } from "../test-env.testing";
import {
	type CertNameEntry,
	getCertNamesPath,
	pruneCertNameEntries,
	rememberCertNames,
} from "./cert-names";

useTempHome();
let dir: string;

/** A checkout on disk, which is what keeps its names remembered. */
function checkout(name: string): string {
	const root = join(dir, name);
	mkdirSync(root, { recursive: true });
	return root;
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "buncargo-cert-names-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

const unreadable = unreadableCheckout();
afterAll(() => unreadable?.cleanup());

/**
 * One leaf serves every project on the machine. Minting it from the live route
 * registry alone meant a project stopping dropped its names, and starting it
 * again reminted — which rebinds the daemon and drops every other project's
 * websockets. Two projects alternating reminted on every run.
 */
describe("rememberCertNames", () => {
	it("returns this project's names on a first run", async () => {
		const a = checkout("a");
		expect(
			await rememberCertNames({
				root: a,
				names: ["a.localhost", "*.a.localhost"],
			}),
		).toEqual(["*.a.localhost", "a.localhost"]);
	});

	it("keeps a project's names while it is not running", async () => {
		const a = checkout("a");
		await rememberCertNames({
			root: a,
			names: ["a.localhost"],
		});
		const union = await rememberCertNames({
			root: checkout("b"),
			names: ["b.localhost"],
		});
		expect(union).toEqual(["a.localhost", "b.localhost"]);
	});

	it("replaces a project's own names rather than accumulating them", async () => {
		const a = checkout("a");
		await rememberCertNames({
			root: a,
			names: ["old.localhost"],
		});
		expect(
			await rememberCertNames({
				root: a,
				names: ["new.localhost"],
			}),
		).toEqual(["new.localhost"]);
	});

	// A caller that only wants the union — the second sync pass in
	// `activateNamedHosts` — must not be able to erase a project by omission.
	it("does not erase a project when called with no names", async () => {
		const a = checkout("a");
		await rememberCertNames({
			root: a,
			names: ["a.localhost"],
		});
		expect(
			await rememberCertNames({
				root: a,
				names: [],
			}),
		).toEqual(["a.localhost"]);
	});

	it("drops the names of a checkout since deleted", async () => {
		const a = checkout("a");
		await rememberCertNames({
			root: a,
			names: ["a.localhost"],
		});
		const union = () => rememberCertNames({ names: [] });
		expect(await union()).toEqual(["a.localhost"]);
		rmSync(a, { recursive: true });
		expect(await union()).toEqual([]);
	});

	// This runs on every dev start, in a directory the daemon watches.
	it("leaves the file alone when a project's names have not changed", async () => {
		const a = checkout("a");
		const remember = () =>
			rememberCertNames({
				root: a,
				names: ["a.localhost", "*.a.localhost"],
			});
		await remember();
		const path = getCertNamesPath();
		const stored = JSON.parse(readFileSync(path, "utf8"));
		stored.projects[0].updatedAt = "2020-01-01T00:00:00.000Z";
		writeFileSync(path, JSON.stringify(stored));
		const before = readFileSync(path, "utf8");

		await remember();
		expect(readFileSync(path, "utf8")).toBe(before);
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
		const here = checkout("here");
		const kept = pruneCertNameEntries([
			entry(join(dir, "gone"), "2026-01-01T00:00:00.000Z"),
			entry(here, "2026-01-02T00:00:00.000Z"),
		]);
		expect(kept.map((item) => item.root)).toEqual([here]);
	});

	it.skipIf(!unreadable)(
		"keeps a checkout this user cannot read, and drops a deleted one",
		() => {
			const root = unreadable?.root ?? "";
			const kept = pruneCertNameEntries([
				entry(root, "2026-01-02T00:00:00.000Z"),
				entry(
					join(tmpdir(), "buncargo-never-existed"),
					"2026-01-01T00:00:00.000Z",
				),
			]);
			expect(kept.map((item) => item.root)).toEqual([root]);
		},
	);

	it("keeps the newest first, so a cap drops the stalest", () => {
		const [old, recent] = [checkout("old"), checkout("new")];
		const kept = pruneCertNameEntries([
			entry(old, "2026-01-01T00:00:00.000Z"),
			entry(recent, "2026-06-01T00:00:00.000Z"),
		]);
		expect(kept.map((item) => item.root)).toEqual([recent, old]);
	});
});
