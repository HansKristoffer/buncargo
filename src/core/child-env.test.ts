import { expect, it } from "bun:test";
import { childProcessEnv, connectProcessEnv } from "./child-env";
import { execAsync } from "./process";

it("gives buncargo's own tools everything but the connect tokens", () => {
	expect(
		connectProcessEnv({
			CLAUDECODE: "1",
			BUNCARGO_CONNECT_TOKENS: "secret",
			PATH: "/bin",
		}),
	).toEqual({ CLAUDECODE: "1", PATH: "/bin" });
});

it("removes the config's unsetEnv and the connect tokens from a child's env", () => {
	expect(
		childProcessEnv(
			{
				CLAUDECODE: "1",
				BUNCARGO_CONNECT_TOKENS: "secret",
				PATH: "/bin",
			},
			["CLAUDECODE"],
		),
	).toEqual({ PATH: "/bin" });
});

it("keeps a detached run's mark from its apps, so a buncargo they start is not detached", () => {
	expect(childProcessEnv({ BUNCARGO_DETACHED: "1", PATH: "/bin" })).toEqual({
		PATH: "/bin",
	});
});

it("reaches commands buncargo runs", async () => {
	process.env.BUNCARGO_TEST_AGENT = "1";
	try {
		const result = await execAsync(
			// biome-ignore lint/suspicious/noTemplateCurlyInString: a shell expansion
			'printf "%s" "${BUNCARGO_TEST_AGENT:-unset}"',
			process.cwd(),
			{},
			{ unsetEnv: ["BUNCARGO_TEST_AGENT"] },
		);
		expect(result.stdout).toBe("unset");
		// buncargo's own environment is left alone.
		expect(process.env.BUNCARGO_TEST_AGENT).toBe("1");
	} finally {
		delete process.env.BUNCARGO_TEST_AGENT;
	}
});
