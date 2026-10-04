import { afterEach, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyToClipboard } from "./clipboard";

const tool = process.platform === "darwin" ? "pbcopy" : "wl-copy";
const saved = { path: process.env.PATH, ssh: process.env.SSH_CONNECTION };
let dir = "";

afterEach(() => {
	process.env.PATH = saved.path;
	if (saved.ssh === undefined) delete process.env.SSH_CONNECTION;
	else process.env.SSH_CONNECTION = saved.ssh;
	rmSync(dir, { recursive: true, force: true });
});

/** A clipboard tool on PATH that runs `script`. */
function fakeTool(script: string) {
	dir = mkdtempSync(join(tmpdir(), "buncargo-clipboard-"));
	writeFileSync(join(dir, tool), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
	process.env.PATH = `${dir}:${saved.path}`;
	delete process.env.SSH_CONNECTION;
}

it("copies through the tool found on the current PATH", () => {
	fakeTool(`cat > "$(dirname "$0")/copied"`);
	const sequences: string[] = [];
	expect(copyToClipboard("hello", (s) => sequences.push(s))).toBe("clipboard");
	expect(Bun.file(join(dir, "copied")).size).toBe(5);
	expect(sequences).toEqual([]);
});

it("falls back to the terminal when the tool hangs", () => {
	fakeTool("exec sleep 30");
	const sequences: string[] = [];
	const started = performance.now();
	expect(copyToClipboard("hello", (s) => sequences.push(s))).toBe("terminal");
	expect(performance.now() - started).toBeLessThan(5000);
	expect(sequences).toEqual([
		`\u001b]52;c;${Buffer.from("hello").toString("base64")}\u0007`,
	]);
});
