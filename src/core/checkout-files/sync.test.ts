import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CI_ENV_VARS } from "../runtime-flags";
import {
	type CheckoutFileSpec,
	checkoutFileErrors,
	checkoutFileSpecs,
} from "./spec";
import {
	MAX_FILE_BYTES,
	readManifest,
	readStoreManifest,
	sha256,
	storeDir,
	writeStoreEntries,
} from "./store";
import {
	dotenvKeyDiff,
	fileState,
	inspectCheckoutFiles,
	mergeCheckoutFile,
	saveCheckoutFiles,
	syncAction,
	syncCheckoutFiles,
	syncConfiguredCheckoutFiles,
} from "./sync";

const KEY = "github.com/acme/app";
const ENV = ".env.local";

function git(cwd: string, ...args: string[]): string {
	const result = spawnSync("git", args, { cwd, encoding: "utf-8" });
	if (result.status !== 0)
		throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
	return result.stdout;
}

interface Repo {
	dir: string;
	root: string;
	home: string;
	store: string;
	lines: string[];
}

const temps: string[] = [];
afterEach(() => {
	for (const dir of temps.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

function makeRepo(): Repo {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "buncargo-files-")));
	temps.push(dir);
	const root = join(dir, "app");
	mkdirSync(root);
	git(root, "init", "-q", "-b", "main");
	git(root, "remote", "add", "origin", "https://github.com/Acme/App.git");
	writeFileSync(
		join(root, ".gitignore"),
		".env*\n!.env.example\n.buncargo/\napps/*/.env\n",
	);
	const home = join(dir, "home");
	return { dir, root, home, store: storeDir(KEY, home), lines: [] };
}

const spec = (path = ENV, extra: Partial<CheckoutFileSpec> = {}) => [
	{ path, machine: false, ...extra },
];

function sync(
	repo: Repo,
	specs = spec(),
	options: Parameters<typeof syncCheckoutFiles>[2] = {},
) {
	return syncCheckoutFiles(repo.root, specs, {
		home: repo.home,
		log: (line) => repo.lines.push(line),
		...options,
	});
}

function writeLocal(repo: Repo, text: string, path = ENV): void {
	mkdirSync(dirname(join(repo.root, path)), { recursive: true });
	writeFileSync(join(repo.root, path), text);
}

function readLocal(repo: Repo, path = ENV): string | undefined {
	const full = join(repo.root, path);
	return existsSync(full) ? readFileSync(full, "utf8") : undefined;
}

function seedStore(
	repo: Repo,
	text: string,
	path = ENV,
	machine = false,
): void {
	writeStoreEntries(repo.store, readStoreManifest(repo.store), [
		{ path, data: Buffer.from(text), machine },
	]);
}

function readStore(repo: Repo, path = ENV): string | undefined {
	const full = join(repo.store, "data", ...path.split("/"));
	return existsSync(full) ? readFileSync(full, "utf8") : undefined;
}

function readBase(repo: Repo, path = ENV): string | undefined {
	try {
		return JSON.parse(
			readFileSync(join(repo.root, ".buncargo", "files.json"), "utf8"),
		).files[path]?.base;
	} catch {
		return undefined;
	}
}

const hash = (text: string) => sha256(Buffer.from(text));

describe("the sync table", () => {
	const [l, b, s, x] = ["local", "base", "store", "other"].map(hash);
	it.each([
		["missing", "present", undefined, undefined, s, "copy", "store-newer"],
		[
			"missing",
			"missing",
			undefined,
			undefined,
			undefined,
			"template",
			"missing",
		],
		[
			"present, no base",
			"missing",
			l,
			undefined,
			undefined,
			"adopt",
			"local-edits",
		],
		["present, no base", "equal", l, undefined, l, "record-base", "in-sync"],
		["present, no base", "different", l, undefined, s, "leave", "local-edits"],
		["equal to base", "changed", b, b, s, "copy", "store-newer"],
		["changed", "equal to base", l, b, b, "leave", "local-edits"],
		["changed", "changed and different", l, b, x, "leave", "conflict"],
		["equal to base", "equal", l, l, l, "none", "in-sync"],
	] as const)(
		"checkout %s, store %s",
		(_local, _store, local, base, store, action, state) => {
			expect(syncAction(local, base, store)).toBe(action);
			expect(fileState(local, base, store)).toBe(state);
		},
	);
});

describe("syncCheckoutFiles", () => {
	it("copies the store's file into a checkout that has none, and records its base", async () => {
		const repo = makeRepo();
		seedStore(repo, "A=1\n");
		const report = await sync(repo);
		expect(readLocal(repo)).toBe("A=1\n");
		expect(readBase(repo)).toBe(hash("A=1\n"));
		expect(report).toEqual({
			repoKey: KEY,
			files: [{ path: ENV, state: "in-sync", machine: false }],
		});
		expect(statSync(join(repo.root, ENV)).mode & 0o777).toBe(0o600);
	});

	it("copies the template when nobody has the file, without storing it", async () => {
		const repo = makeRepo();
		writeFileSync(join(repo.root, ".env.example"), "A=\n");
		const specs = spec(ENV, { template: ".env.example" });
		await sync(repo, specs);
		expect(readLocal(repo)).toBe("A=\n");
		expect(readManifest(repo.store).kind).toBe("absent");
		expect(readBase(repo)).toBeUndefined();

		// Filled in before the next command: that is what gets stored.
		writeLocal(repo, "A=filled\n");
		await sync(repo, specs);
		expect(readStore(repo)).toBe("A=filled\n");
	});

	it("leaves a file nobody has missing and writes nothing", async () => {
		const repo = makeRepo();
		const report = await sync(repo);
		expect(report.files[0]?.state).toBe("missing");
		expect(existsSync(repo.store)).toBe(false);
		expect(existsSync(join(repo.root, ".buncargo"))).toBe(false);
	});

	it("adopts a checkout's file into an empty store", async () => {
		const repo = makeRepo();
		writeLocal(repo, "A=1\n");
		await sync(repo);
		expect(readStore(repo)).toBe("A=1\n");
		expect(readBase(repo)).toBe(hash("A=1\n"));
		expect(statSync(join(repo.store, "manifest.json")).mode & 0o777).toBe(
			0o600,
		);
	});

	it("records the base of a copy that already matches the store", async () => {
		const repo = makeRepo();
		writeLocal(repo, "A=1\n");
		seedStore(repo, "A=1\n");
		await sync(repo);
		expect(readBase(repo)).toBe(hash("A=1\n"));
	});

	it("updates an untouched copy when the store changed, naming only the file", async () => {
		const repo = makeRepo();
		seedStore(repo, "SECRET=old\n");
		await sync(repo);
		seedStore(repo, "SECRET=new\n");
		repo.lines.length = 0;
		await sync(repo);
		expect(readLocal(repo)).toBe("SECRET=new\n");
		expect(readBase(repo)).toBe(hash("SECRET=new\n"));
		expect(repo.lines).toHaveLength(1);
		expect(repo.lines[0]).toContain(`Updated ${ENV} from the file store`);
		expect(repo.lines.join("")).not.toContain("new");
	});

	it("leaves a conflict and warns with the fix", async () => {
		const repo = makeRepo();
		seedStore(repo, "A=1\n");
		await sync(repo);
		writeLocal(repo, "A=mine\n");
		seedStore(repo, "A=theirs\n");
		const report = await sync(repo);
		expect(readLocal(repo)).toBe("A=mine\n");
		expect(report.files[0]).toMatchObject({
			state: "conflict",
			mergeable: true,
		});
		const warning = repo.lines.join("\n");
		expect(warning).toContain(`buncargo files merge ${ENV}`);
		expect(warning).toContain(`buncargo files save ${ENV}`);
		expect(warning).toContain(`buncargo files pull --force ${ENV}`);
		expect(warning).not.toContain("mine");

		// Not dotenv: merge cannot apply, so it is not offered.
		repo.lines.length = 0;
		writeLocal(repo, '{"a": "mine"}\n');
		const json = await sync(repo);
		expect(json.files[0]).toMatchObject({
			state: "conflict",
			mergeable: false,
		});
		expect(repo.lines.join("\n")).not.toContain("files merge");
		expect(repo.lines.join("\n")).toContain(`buncargo files save ${ENV}`);
	});

	it("backs local edits up before --force replaces them", async () => {
		const repo = makeRepo();
		seedStore(repo, "A=1\n");
		await sync(repo);
		writeLocal(repo, "A=mine\n");
		seedStore(repo, "A=theirs\n");
		const report = await sync(repo, spec(), { force: true });
		expect(readLocal(repo)).toBe("A=theirs\n");
		expect(report.files[0]?.state).toBe("in-sync");
		const backups = join(repo.root, ".buncargo", "files-backup");
		const [stamp] = readdirSync(backups);
		expect(readFileSync(join(backups, stamp ?? "", ENV), "utf8")).toBe(
			"A=mine\n",
		);
	});

	it("only syncs in CI when a store exists", async () => {
		const repo = makeRepo();
		writeLocal(repo, "A=1\n");
		await sync(repo, spec(), { ci: true });
		expect(existsSync(repo.store)).toBe(false);

		rmSync(join(repo.root, ENV));
		seedStore(repo, "A=store\n");
		await sync(repo, spec(), { ci: true });
		expect(readLocal(repo)).toBe("A=store\n");
	});

	it("leaves a store with an unknown version alone", async () => {
		const repo = makeRepo();
		mkdirSync(repo.store, { recursive: true });
		writeFileSync(
			join(repo.store, "manifest.json"),
			'{"version":2,"files":{}}',
		);
		writeLocal(repo, "A=1\n");
		await expect(sync(repo)).rejects.toThrow("version 2");
		expect(readFileSync(join(repo.store, "manifest.json"), "utf8")).toBe(
			'{"version":2,"files":{}}',
		);
	});
});

describe("refusals", () => {
	it("refuses a file git does not ignore", async () => {
		const repo = makeRepo();
		writeLocal(repo, "A=1\n", "config.env");
		const report = await sync(repo, spec("config.env"));
		expect(readManifest(repo.store).kind).toBe("absent");
		expect(report.files[0]?.refusal).toBe("is not gitignored");
		expect(repo.lines.join("\n")).toContain(
			"`buncargo setup` adds it to .gitignore",
		);
	});

	it("refuses a tracked file", async () => {
		const repo = makeRepo();
		writeLocal(repo, "A=1\n", ".env.tracked");
		git(repo.root, "add", "-f", ".env.tracked");
		const report = await sync(repo, spec(".env.tracked"));
		expect(readManifest(repo.store).kind).toBe("absent");
		expect(report.files[0]?.refusal).toBe("is tracked by git");
	});

	it("refuses a symlink", async () => {
		const repo = makeRepo();
		writeFileSync(join(repo.dir, "elsewhere"), "A=1\n");
		symlinkSync(join(repo.dir, "elsewhere"), join(repo.root, ENV));
		seedStore(repo, "A=store\n");
		const report = await sync(repo);
		expect(report.files[0]?.refusal).toBe("is a symlink");
		expect(readFileSync(join(repo.dir, "elsewhere"), "utf8")).toBe("A=1\n");
	});

	it("refuses a path that leaves the checkout through a symlinked directory", async () => {
		const repo = makeRepo();
		mkdirSync(join(repo.dir, "outside"));
		mkdirSync(join(repo.root, "apps"));
		symlinkSync(join(repo.dir, "outside"), join(repo.root, "apps", "linked"));
		seedStore(repo, "A=1\n", "apps/linked/.env");
		const report = await sync(repo, spec("apps/linked/.env"));
		expect(report.files[0]?.refusal).toContain("outside the checkout");
		expect(existsSync(join(repo.dir, "outside", ".env"))).toBe(false);
	});

	it("refuses a file over 1 MiB", async () => {
		const repo = makeRepo();
		writeLocal(repo, "A".repeat(MAX_FILE_BYTES + 1));
		const report = await sync(repo);
		expect(report.files[0]?.refusal).toBe("is larger than 1 MiB");
		expect(readManifest(repo.store).kind).toBe("absent");
	});

	it("refuses config paths outside the checkout", () => {
		expect(
			checkoutFileErrors([
				"../x",
				"/etc/hosts",
				"a\\b",
				"a//b",
				"./a",
				".env",
				".env",
			]),
		).toEqual([
			'options.checkoutFiles.0 "../x" must stay inside the checkout',
			'options.checkoutFiles.1 "/etc/hosts" must be relative to the checkout root',
			'options.checkoutFiles.2 "a\\b" must use / as the separator',
			'options.checkoutFiles.3 "a//b" must not contain empty or . segments',
			'options.checkoutFiles.4 "./a" must not contain empty or . segments',
			'options.checkoutFiles.6 ".env" is listed twice',
		]);
		expect(
			checkoutFileSpecs([
				".env",
				{ path: "b/.env", template: "b/.env.example" },
			]),
		).toEqual([
			{ path: ".env", machine: false },
			{ path: "b/.env", template: "b/.env.example", machine: false },
		]);
	});

	it("reports every refusal when inspecting", () => {
		const repo = makeRepo();
		const report = inspectCheckoutFiles(
			repo.root,
			[...spec(), ...spec("config.env")],
			{
				home: repo.home,
			},
		);
		expect(report.files.map((file) => file.refusal)).toEqual([
			undefined,
			"is not gitignored",
		]);
	});
});

describe("saveCheckoutFiles", () => {
	it("promotes local edits so other checkouts pick them up", async () => {
		const repo = makeRepo();
		seedStore(repo, "A=1\n");
		await sync(repo);
		writeLocal(repo, "A=2\n");
		const { failed } = await saveCheckoutFiles(repo.root, spec(), {
			home: repo.home,
			log: () => {},
		});
		expect(failed).toEqual([]);
		expect(readStore(repo)).toBe("A=2\n");
		expect(readBase(repo)).toBe(hash("A=2\n"));
	});

	it("fails for a file the checkout does not have", async () => {
		const repo = makeRepo();
		const { failed } = await saveCheckoutFiles(repo.root, spec(), {
			home: repo.home,
			log: () => {},
		});
		expect(failed).toEqual([ENV]);
	});
});

describe("mergeCheckoutFile", () => {
	const merge = (repo: Repo, take = new Map<string, "checkout" | "store">()) =>
		mergeCheckoutFile(repo.root, spec(), ENV, {
			home: repo.home,
			log: (line) => repo.lines.push(line),
			take,
		});

	/** Synced at `base`, then edited in the checkout and in the store. */
	async function diverged(base: string, mine: string, theirs: string) {
		const repo = makeRepo();
		seedStore(repo, base);
		await sync(repo);
		writeLocal(repo, mine);
		seedStore(repo, theirs);
		return repo;
	}

	it("merges both sides' changes from the last synced copy into the checkout and the store", async () => {
		const repo = await diverged(
			"A=1\nB=1\n",
			"A=mine\nB=1\nLOCAL=1\n",
			"A=1\nB=theirs\n",
		);
		const result = await merge(repo);
		expect(result).toMatchObject({ conflicts: [], merged: true, base: true });
		expect(readLocal(repo)).toBe("A=mine\nB=theirs\nLOCAL=1\n");
		expect(readStore(repo)).toBe("A=mine\nB=theirs\nLOCAL=1\n");
		expect(readBase(repo)).toBe(hash("A=mine\nB=theirs\nLOCAL=1\n"));
		expect(readFileSync(join(repo.root, result.backup ?? ""), "utf8")).toBe(
			"A=mine\nB=1\nLOCAL=1\n",
		);
		expect((await sync(repo)).files[0]?.state).toBe("in-sync");
	});

	it("writes nothing while a key changed on both sides is unresolved, and names only the key", async () => {
		const repo = await diverged("A=1\n", "A=mine\n", "A=theirs\n");
		const result = await merge(repo);
		expect(result).toEqual({ conflicts: ["A"], merged: false, base: true });
		expect(readLocal(repo)).toBe("A=mine\n");
		expect(readStore(repo)).toBe("A=theirs\n");
		expect(repo.lines.join("\n")).not.toMatch(/mine|theirs/);

		await merge(repo, new Map([["A", "store"]]));
		expect(readLocal(repo)).toBe("A=theirs\n");
	});

	it("records base copies for checkouts synced before they existed", async () => {
		const repo = await diverged("A=1\n", "A=1\n", "A=1\n");
		rmSync(join(repo.root, ".buncargo", "files-base"), { recursive: true });
		writeLocal(repo, "A=1\nMINE=1\n");
		seedStore(repo, "A=2\n");
		// The store no longer has the base, and the checkout changed: lost.
		await sync(repo);
		expect((await merge(repo, new Map([["A", "store"]]))).base).toBe(false);

		const fresh = await diverged("A=1\n", "A=1\n", "A=1\n");
		rmSync(join(fresh.root, ".buncargo", "files-base"), { recursive: true });
		await sync(fresh);
		writeLocal(fresh, "A=1\nMINE=1\n");
		seedStore(fresh, "B=1\n");
		const result = await merge(fresh);
		expect(result.base).toBe(true);
		// A was removed in the store and untouched here, so it goes.
		expect(readLocal(fresh)).toBe("B=1\nMINE=1\n");
	});

	it("repairs a base copy whose hash is not the recorded base", async () => {
		const repo = await diverged("A=1\n", "A=1\n", "A=1\n");
		// A crash between writing the base copy and files.json leaves one stale.
		writeFileSync(join(repo.root, ".buncargo", "files-base", ENV), "A=0\n");
		await sync(repo);
		writeLocal(repo, "A=1\nMINE=1\n");
		seedStore(repo, "B=1\n");
		const result = await merge(repo);
		expect(result.base).toBe(true);
		expect(readLocal(repo)).toBe("B=1\nMINE=1\n");
	});

	it("refuses a file that is not dotenv, naming the alternatives", async () => {
		const repo = await diverged("{}\n", '{"a": 1}\n', '{"b": 2}\n');
		await expect(merge(repo)).rejects.toThrow(
			`only dotenv files merge key by key`,
		);
		expect(readLocal(repo)).toBe('{"a": 1}\n');
	});
});

describe("dotenvKeyDiff", () => {
	it("names keys, never values", () => {
		expect(
			dotenvKeyDiff(
				Buffer.from("A=1\nB=2\nC=3\n"),
				Buffer.from("A=1\nB=changed\nD=4\n"),
			),
		).toEqual({ added: ["C"], removed: ["D"], changed: ["B"] });
	});
});

describe("syncConfiguredCheckoutFiles", () => {
	async function withHome<T>(home: string, body: () => Promise<T>): Promise<T> {
		const saved = new Map(
			["HOME", ...CI_ENV_VARS].map((name) => [name, process.env[name]]),
		);
		for (const name of CI_ENV_VARS) delete process.env[name];
		process.env.HOME = home;
		try {
			return await body();
		} finally {
			for (const [name, value] of saved) {
				if (value === undefined) delete process.env[name];
				else process.env[name] = value;
			}
		}
	}

	it("copies a required envFiles entry before it is read", async () => {
		const repo = makeRepo();
		seedStore(repo, "A=1\n");
		await withHome(repo.home, () =>
			syncConfiguredCheckoutFiles(repo.root, {
				options: { envFiles: [ENV], checkoutFiles: [ENV] },
			}),
		);
		expect(readLocal(repo)).toBe("A=1\n");
	});

	it("names the fix when a required envFiles entry is still missing", async () => {
		const repo = makeRepo();
		await expect(
			withHome(repo.home, () =>
				syncConfiguredCheckoutFiles(repo.root, {
					options: { envFiles: [ENV], checkoutFiles: [ENV] },
				}),
			),
		).rejects.toThrow(`buncargo files save ${ENV}`);
	});

	it("lets an optional envFiles entry stay missing", async () => {
		const repo = makeRepo();
		await withHome(repo.home, () =>
			syncConfiguredCheckoutFiles(repo.root, {
				options: {
					envFiles: [{ path: ENV, optional: true }],
					checkoutFiles: [ENV],
				},
			}),
		);
		expect(readLocal(repo)).toBeUndefined();
	});
});
