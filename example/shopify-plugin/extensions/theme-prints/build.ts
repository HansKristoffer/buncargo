// Writes the theme extension's asset; `--watch` keeps rebuilding it.
import { mkdirSync, writeFileSync } from "node:fs";

const build = () => {
	mkdirSync(`${import.meta.dir}/assets`, { recursive: true });
	writeFileSync(
		`${import.meta.dir}/assets/prints.js`,
		`// built ${Date.now()}\n`,
	);
};
build();
if (process.argv.includes("--watch")) setInterval(build, 60_000);
