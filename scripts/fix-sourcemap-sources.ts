import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

interface SourceMap {
	sources?: string[];
	sourcesContent?: unknown;
}

/**
 * The map a build output ships with: the source paths right, and no source
 * text.
 *
 * The package ships no `src/`, so the maps are there for stack traces, which
 * need only the mappings and the paths. `sourcesContent` was more than twice
 * the size of the JavaScript.
 *
 * `bun build --sourcemap` writes every map's `sources` relative to the output
 * directory, which is only right for the chunks at its top level: the map of
 * `dist/cli/bin.js` names `../src/cli/bin.ts`, which from `dist/cli/` is
 * `dist/src/cli/bin.ts`. So each path is made relative to its own map, and a
 * trace names the repository's file.
 */
export function shippedSourceMap(
	map: SourceMap,
	mapPath: string,
	outdir: string,
): SourceMap {
	const { sourcesContent: _content, ...rest } = map;
	if (!rest.sources) return rest;
	return {
		...rest,
		sources: rest.sources.map((source) =>
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
		const map = JSON.parse(readFileSync(path, "utf8"));
		writeFileSync(path, JSON.stringify(shippedSourceMap(map, path, outdir)));
	}
}
