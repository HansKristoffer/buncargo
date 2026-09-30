import { stopDevServers } from "../../src/core/process";
import { loadDevEnv } from "../../src/loader";
import type config from "./dev.config";

const [web, api] = await Promise.all([
	loadDevEnv<typeof config>({ cwd: import.meta.dir, fresh: true }),
	loadDevEnv<typeof config>({ cwd: import.meta.dir, fresh: true }),
]);
const lifetime = new AbortController();
const owned: Record<string, number> = {};
try {
	await Promise.all([
		web
			.start({
				onlyApps: ["web"],
				productionBuild: false,
				signal: lifetime.signal,
			})
			.then((pids) => Object.assign(owned, pids)),
		api
			.start({
				onlyApps: ["api"],
				productionBuild: false,
				signal: lifetime.signal,
			})
			.then((pids) => Object.assign(owned, pids)),
	]);
	console.log(await (await fetch(web.urls.web)).text());
	console.log(await (await fetch(api.urls.api)).text());
} finally {
	lifetime.abort();
	await stopDevServers(owned);
	await Promise.all([web.releaseRun(), api.releaseRun()]);
}
