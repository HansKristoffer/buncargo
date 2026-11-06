import { afterEach, describe, expect, it } from "bun:test";
import {
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPrivilegedRunner } from "./privileged";

describe("createPrivilegedRunner", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0))
			rmSync(dir, { recursive: true, force: true });
	});

	const sibling = `/etc/.hosts.buncargo-${process.pid}.tmp`;

	// `sudo cp` onto /etc/hosts truncated it in place, and every name
	// resolution on the machine reads it, `localhost` included.
	it("replaces a root-owned file by a rename from a sibling, never in place", () => {
		const commands: string[][] = [];
		const runner = createPrivilegedRunner({
			isRoot: () => false,
			exec: (command, args) => {
				commands.push([command, ...args]);
			},
		});
		runner.writeFile("/etc/hosts", "127.0.0.1 localhost\n");

		expect(commands.map((command) => command.slice(0, 2))).toEqual([
			["sudo", "cp"],
			["sudo", "chmod"],
			["sudo", "mv"],
		]);
		expect(commands[0]?.[3]).toBe(sibling);
		expect(commands[1]).toEqual(["sudo", "chmod", "644", sibling]);
		expect(commands[2]).toEqual(["sudo", "mv", "-f", sibling, "/etc/hosts"]);
	});

	it("takes the sibling out again when the copy fails", () => {
		const commands: string[][] = [];
		const runner = createPrivilegedRunner({
			isRoot: () => false,
			exec: (command, args) => {
				commands.push([command, ...args]);
				if (args[0] === "cp") throw new Error("sudo: a password is required");
			},
		});
		expect(() => runner.writeFile("/etc/hosts", "x")).toThrow(
			"a password is required",
		);
		expect(commands.at(-1)).toEqual(["sudo", "rm", "-f", sibling]);
	});

	it("writes as root through a rename too, leaving no sibling behind", () => {
		const dir = mkdtempSync(join(tmpdir(), "buncargo-privileged-"));
		dirs.push(dir);
		const path = join(dir, "hosts");
		writeFileSync(path, "old\n");
		const runner = createPrivilegedRunner({
			isRoot: () => true,
			exec: () => {
				throw new Error("a root write runs no command");
			},
		});
		runner.writeFile(path, "new\n");
		expect(readFileSync(path, "utf8")).toBe("new\n");
		expect(readdirSync(dir)).toEqual(["hosts"]);
	});
});
