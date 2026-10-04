import { expect, it } from "bun:test";
import { describeFileTable } from "./doctor";
import { parseFileHolders } from "./file-table";

it("counts descriptors per process from lsof's field output", () => {
	const output = ["p10", "cbun", "f1", "f2", "f3", "p20", "cnode", "f1"].join(
		"\n",
	);
	expect(parseFileHolders(output)).toEqual([
		{ pid: 10, command: "bun", files: 3 },
		{ pid: 20, command: "node", files: 1 },
	]);
});

it("names the holders only once the table is filling up", () => {
	let asked = 0;
	const holders = () => {
		asked++;
		return [{ pid: 7, command: "bun", files: 42_000 }];
	};
	expect(describeFileTable({ open: 1000, max: 368_640 }, holders)).toEqual({
		level: "note",
		lines: ["Open files: 1,000 of 368,640 (0%)"],
	});
	expect(asked).toBe(0);
	const full = describeFileTable({ open: 368_587, max: 368_640 }, holders);
	expect(full.level).toBe("issue");
	expect(full.lines[1]).toBe("  42,000 held by bun (pid 7)");
});
