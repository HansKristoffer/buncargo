import { relative } from "node:path";
import type { SetupCheck } from "../types";
import {
	isSupabaseInstalled,
	isTestedSupabaseVersion,
	parseSupabaseVersion,
	resolveSupabaseBin,
	supabaseVersion,
} from "./cli";
import type { SupabaseProject } from "./project";

export function supabaseChecks(state: {
	project: (root: string) => SupabaseProject;
	workdir: (root: string) => string;
}): SetupCheck[] {
	return [
		{
			name: "Supabase CLI is installed",
			check: ({ root }) => isSupabaseInstalled(root),
			fix: "bun add -d supabase",
		},
		{
			name: "supabase/config.toml exists",
			check: ({ root }) => {
				const project = state.project(root);
				if (project.error) {
					return {
						ok: false,
						detail: `${relative(root, project.path)}: ${project.error}`,
					};
				}
				return (
					project.exists || {
						ok: false,
						detail: `No ${relative(root, project.path)}`,
					}
				);
			},
			fix: ({ root }) => {
				const result = Bun.spawnSync(
					[resolveSupabaseBin(root), "init", "--yes"],
					{ cwd: state.workdir(root), stdout: "inherit", stderr: "inherit" },
				);
				if (result.exitCode !== 0) throw new Error("supabase init failed");
			},
			fixDescription: "Run `supabase init`",
		},
		{
			// The CLI drives Docker (or Podman) itself, through Docker's current
			// context. Apple's runtime leaves it with no daemon, and a pinned
			// OrbStack would split the project across two engines.
			name: "Supabase runs on Docker",
			check: ({ env }) =>
				env.containerRuntime === "apple"
					? {
							ok: false,
							detail:
								'The Supabase CLI needs Docker or Podman; set docker.runtime to "docker"',
						}
					: env.containerRuntime === "orbstack"
						? {
								ok: false,
								detail:
									'The Supabase CLI uses Docker\'s current context, not docker.runtime "orbstack". Set docker.runtime to "docker" and run `docker context use orbstack` to run Supabase on OrbStack.',
							}
						: true,
		},
		{
			name: "Supabase CLI version is tested",
			fast: false,
			severity: "warning",
			check: ({ root }) => {
				const version = supabaseVersion(resolveSupabaseBin(root), root);
				if (!version)
					return { ok: false, detail: "`supabase --version` failed" };
				const parsed = parseSupabaseVersion(version);
				return (
					(parsed !== undefined && isTestedSupabaseVersion(parsed)) || {
						ok: false,
						detail: `Supabase CLI ${version} is outside the tested 2.x range`,
					}
				);
			},
		},
	];
}
