import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { DockerComposeGenerationOptions, ServiceConfig } from "../types";
import { buildComposeModel, type ComposeIdentity } from "./model";
import { composeToYaml } from "./yaml";

export const DEFAULT_GENERATED_COMPOSE_FILE =
	".buncargo/docker-compose.generated.yml";

export function getGeneratedComposePath(
	root: string,
	docker?: DockerComposeGenerationOptions,
): { absolutePath: string; composeFileArg: string } {
	const generatedFile = docker?.generatedFile ?? DEFAULT_GENERATED_COMPOSE_FILE;
	const absolutePath = isAbsolute(generatedFile)
		? generatedFile
		: resolve(root, generatedFile);
	const relativePath = relative(root, absolutePath);
	const composeFileArg =
		relativePath && !relativePath.startsWith("..")
			? relativePath
			: absolutePath;
	return { absolutePath, composeFileArg };
}

export function writeGeneratedComposeFile(
	root: string,
	services: Record<string, ServiceConfig>,
	docker?: DockerComposeGenerationOptions,
	identity?: ComposeIdentity,
): string {
	const { absolutePath, composeFileArg } = getGeneratedComposePath(
		root,
		docker,
	);
	const writeStrategy = docker?.writeStrategy ?? "always";
	const shouldWrite = writeStrategy === "always" || !existsSync(absolutePath);
	if (shouldWrite) {
		const composeModel = buildComposeModel(services, docker, identity);
		const yaml = composeToYaml(composeModel);
		mkdirSync(dirname(absolutePath), { recursive: true });
		writeFileSync(absolutePath, yaml, "utf-8");
	}

	return composeFileArg;
}
