import { expect, it } from "bun:test";

// A child that saw the developer's HOME or a reachable Docker would run the
// sweep against the real machine (AGENTS.md, "The ways to hurt yourself").
it.skipIf(process.platform === "win32")(
	"hands a spawned child the run's isolated environment",
	async () => {
		const script = 'printf "%s\\n%s" "$HOME" "$DOCKER_HOST"';
		const expected = `${process.env.HOME}\n${process.env.DOCKER_HOST}`;

		const sync = Bun.spawnSync(["sh", "-c", script]);
		expect(sync.stdout.toString()).toBe(expected);

		const child = Bun.spawn({ cmd: ["sh", "-c", script], stdout: "pipe" });
		expect(await new Response(child.stdout).text()).toBe(expected);
	},
);
