import { cliTool } from "../core/integration-cli";

/** The Supabase CLI, tested against 2.x; looked up in the project root. */
export const supabaseCli = cliTool({
	name: "supabase",
	versionArgs: ["--version"],
	tested: { min: "2.0.0", below: "3.0.0" },
});
