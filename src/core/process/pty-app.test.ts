import { expect, it } from "bun:test";
import { tmpdir } from "node:os";
import { PtyApp } from "./pty-app";

/** `argv` under a terminal of its own: what it printed and how it ended. */
async function run(argv: string[], input?: string) {
	const decoder = new TextDecoder();
	let printed = "";
	const app = new PtyApp(argv, {
		cwd: tmpdir(),
		env: process.env,
		cols: 80,
		rows: 24,
		onData: (data) => {
			printed += decoder.decode(data, { stream: true });
		},
	});
	if (input !== undefined) app.write(input);
	const code = await new Promise((resolve) => app.once("exit", resolve));
	return { pid: app.pid, printed, code };
}

it("reaps apps that print and exit at once, however many start together", async () => {
	// Before the child was gated, Bun on macOS could hang inside Bun.spawn
	// here for good, with no test timeout able to fire.
	const runs = await Promise.all(
		Array.from({ length: 25 }, () => run(["/bin/sh", "-c", "printf printed"])),
	);
	for (const { printed, code } of runs) {
		expect(code).toBe(0);
		expect(printed).toBe("printed");
	}
});

it("runs the command as the spawned process, with its arguments and input and none of our fds", async () => {
	const script = [
		'printf "pid:%s args:[%s][%s]" "$$" "$1" "$2"',
		"IFS= read -r line",
		'printf " line:%s fd3:" "$line"',
		"if [ -e /dev/fd/3 ]; then printf open; else printf closed; fi",
		"exit 3",
	].join("; ");

	const { pid, printed, code } = await run(
		["/bin/sh", "-c", script, "sh", "two words", ""],
		"typed\n",
	);

	expect(code).toBe(3);
	expect(printed).toContain(`pid:${pid} args:[two words][]`);
	expect(printed).toContain(" line:typed fd3:closed");
});
