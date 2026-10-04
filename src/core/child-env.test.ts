import { afterEach, expect, it } from "bun:test";
import { childProcessEnv, setUnsetEnv } from "./child-env";
import { execAsync } from "./process";

afterEach(() => setUnsetEnv(undefined));

it("removes the config's unsetEnv and the connect tokens from a child's env", () => {
	setUnsetEnv(["CLAUDECODE"]);
	expect(
		childProcessEnv({
			CLAUDECODE: "1",
			BUNCARGO_CONNECT_TOKENS: "secret",
			PATH: "/bin",
		}),
	).toEqual({ PATH: "/bin" });
});

it("reaches commands buncargo runs", async () => {
	process.env.BUNCARGO_TEST_AGENT = "1";
	setUnsetEnv(["BUNCARGO_TEST_AGENT"]);
	try {
		const result = await execAsync(
			// biome-ignore lint/suspicious/noTemplateCurlyInString: a shell expansion
			'printf "%s" "${BUNCARGO_TEST_AGENT:-unset}"',
			process.cwd(),
			{},
		);
		expect(result.stdout).toBe("unset");
		// buncargo's own environment is left alone.
		expect(process.env.BUNCARGO_TEST_AGENT).toBe("1");
	} finally {
		delete process.env.BUNCARGO_TEST_AGENT;
	}
});
