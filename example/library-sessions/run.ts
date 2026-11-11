// In external projects, import from "buncargo/api".
import { loadDevEnv } from "../../src/api";
import type config from "./dev.config";

const [web, api] = await Promise.all([
	loadDevEnv<typeof config>({ cwd: import.meta.dir, fresh: true }),
	loadDevEnv<typeof config>({ cwd: import.meta.dir, fresh: true }),
]);
const lifetime = new AbortController();
try {
	await Promise.all([
		web.start({
			onlyApps: ["web"],
			productionBuild: false,
			signal: lifetime.signal,
		}),
		api.start({
			onlyApps: ["api"],
			productionBuild: false,
			signal: lifetime.signal,
		}),
	]);
	console.log(await (await fetch(web.urls.web)).text());
	console.log(await (await fetch(api.urls.api)).text());
} finally {
	lifetime.abort();
	// stop() waits for each session's apps to exit, then ends its run.
	await Promise.all([web.stop(), api.stop()]);
}
