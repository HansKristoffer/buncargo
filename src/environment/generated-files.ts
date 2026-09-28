import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { toPortMap, toUrlMap } from "../core/ports";
import type {
	AppConfig,
	EnvValues,
	GeneratedFileContext,
	ServiceConfig,
} from "../types";
import type { DevEnvContext } from "./context";
import type { DevEnvVarsApi } from "./env-vars";

/**
 * Write a file atomically, and only when its content changed.
 *
 * Unchanged content is not written at all, so a watcher on the file does not
 * rebuild on every render. The temp file sits beside the target so the rename
 * never crosses a filesystem.
 */
export function writeIfChanged(path: string, content: string): boolean {
	if (existsSync(path) && readFileSync(path, "utf8") === content) return false;
	mkdirSync(dirname(path), { recursive: true });
	const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
	try {
		writeFileSync(temp, content);
		renameSync(temp, path);
	} catch (error) {
		rmSync(temp, { force: true });
		throw error;
	}
	return true;
}

export function generatedFileContext<
	TServices extends Record<string, ServiceConfig>,
	TApps extends Record<string, AppConfig>,
	TEnv extends EnvValues,
>(
	ctx: DevEnvContext<TServices, TApps, TEnv>,
	envVars: DevEnvVarsApi<TServices, TApps, TEnv>,
): GeneratedFileContext {
	return {
		root: ctx.root,
		projectName: ctx.projectName,
		ports: toPortMap(ctx.ports),
		urls: toUrlMap(ctx.urls),
		loopbackUrls: toUrlMap(ctx.loopbackUrls),
		publicUrls: { ...ctx.publicUrls },
		captured: { ...ctx.captured },
		// The process environment underneath, so CI can hand in a value that
		// no run captured: `BASE_URL=https://… bunx buncargo generate`.
		env: { ...process.env, ...envVars.buildEnvVars() },
	};
}

/** Render every configured file; returns the paths (relative) that changed. */
export function renderGeneratedFiles<
	TServices extends Record<string, ServiceConfig>,
	TApps extends Record<string, AppConfig>,
	TEnv extends EnvValues,
>(
	ctx: DevEnvContext<TServices, TApps, TEnv>,
	envVars: DevEnvVarsApi<TServices, TApps, TEnv>,
): string[] {
	const files = ctx.config.generatedFiles ?? [];
	if (files.length === 0) return [];
	const renderCtx = generatedFileContext(ctx, envVars);
	return files.flatMap((file) => {
		let content: string;
		try {
			content = file.render(renderCtx);
		} catch (error) {
			throw new Error(
				`Rendering ${file.path} failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		return writeIfChanged(resolve(ctx.root, file.path), content)
			? [file.path]
			: [];
	});
}
