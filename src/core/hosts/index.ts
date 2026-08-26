export {
	ensureHostsDaemonRunning,
	isHostsDaemonHealthy,
	readDaemonConfig,
	runHostsDaemon,
} from "./daemon";
export { cleanHostsFile, syncHostsFile } from "./hosts-file";
export { getCaPath, mintCert, resolvedMkcertPath } from "./mkcert";
export {
	doctorFixHosts,
	ensureHostsReady,
	type HostsEnableResult,
	hasDeclinedHosts,
	runHostsInstall,
	runHostsUninstall,
} from "./onboarding";
export { getRoutesPath } from "./paths";
export {
	applyHostPlanToUrls,
	isHostsPlatformSupported,
	isHttpService,
	planNamedHosts,
	resolveHostsOptions,
	sanitizeDnsLabel,
	sanitizeTld,
} from "./plan";
export { HEALTH_PATH, HOPS_HEADER, startLocalProxy } from "./proxy";
export {
	type HostsRoute,
	HostsRouteConflictError,
	loadHostRoutes,
	pruneHostRoutes,
	removeHostRoutes,
	routesFromPlan,
	upsertHostRoutes,
} from "./registry";
export { isHostsServiceInstalled } from "./service";
export { describePortSquatter } from "./squatter";
