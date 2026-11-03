import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

/**
 * `bun build --sourcemap` writes every map's `sources` relative to the output
 * directory, which is only right for the chunks at its top level: the map of
 * `dist/cli/bin.js` names `../src/cli/bin.ts`, which from `dist/cli/` is
 * `dist/src/cli/bin.ts`. The maps are there so an agent or a tool reading
 * `dist` lands in the `src/` the package ships, so make each path relative to
 * its own map.
 */
export function fixSourcePaths(
	map: { sources?: string[] },
	mapPath: string,
	outdir: string,
): { sources?: string[] } {
	if (!map.sources) return map;
	return {
		...map,
		sources: map.sources.map((source) =>
			relative(dirname(mapPath), resolve(outdir, source)),
		),
	};
}

function mapsUnder(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true, recursive: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith(".js.map"))
		.map((entry) => join(entry.parentPath, entry.name));
}

if (import.meta.main) {
	const outdir = resolve(process.argv[2] ?? "dist");
	for (const path of mapsUnder(outdir)) {
		if (dirname(path) === outdir) continue;
		const map = JSON.parse(readFileSync(path, "utf8"));
		writeFileSync(path, JSON.stringify(fixSourcePaths(map, path, outdir)));
	}
}
