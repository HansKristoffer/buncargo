// Started under a pseudo-terminal by prompt.test.ts: asks one question and
// reports how it ended. `listener` stands in for `dev`, which keeps a SIGINT
// listener for its teardown; without it the process has none, like `stop`.
import { askConfirm, PromptInterruptedError } from "./prompt";

if (process.argv[2] === "listener") process.on("SIGINT", () => {});

try {
	console.log(`answer: ${await askConfirm(["  Continue? [y/N]"])}`);
} catch (error) {
	if (!(error instanceof PromptInterruptedError)) throw error;
	console.log("interrupted");
	process.exit(130);
}
