import { typedSwitch, typedSwitchGroup } from "hanzio";
import type { CheckoutFileStatus } from "./sync";

/**
 * What a checkout file needs and the command that fixes it, after its path
 * ("has local edits (…)"); undefined when nothing.
 */
export function checkoutFileProblem(
	file: CheckoutFileStatus,
): string | undefined {
	if (file.refusal) return `${file.refusal}, so it is not synced`;

	return typedSwitch(file.state, {
		...typedSwitchGroup(file.state, ["in-sync", "missing"], () => undefined),
		"local-edits": () =>
			`has local edits (\`buncargo files save ${file.path}\` shares them)`,
		"store-newer": () =>
			`is behind the file store (\`buncargo files pull ${file.path}\`)`,
		conflict: () =>
			file.mergeable
				? `and the file store both changed (\`buncargo files merge ${file.path}\` keeps both, or \`files save\` keeps yours, \`files pull --force\` the store's)`
				: `and the file store both changed (\`buncargo files save ${file.path}\` keeps yours, \`files pull --force\` the store's)`,
	});
}
