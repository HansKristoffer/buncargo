import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type {
	ComposeDocument,
	ContainerRuntimeName,
	DockerComposeGenerationOptions,
	ServiceConfig,
} from "../types";
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
	runtime?: ContainerRuntimeName,
	model?: ComposeDocument,
): string {
	const { absolutePath, composeFileArg } = getGeneratedComposePath(
		root,
		docker,
	);
	const yaml = composeToYaml(
		model ?? buildComposeModel(services, docker, identity, runtime),
	);
	const existing = existsSync(absolutePath)
		? readFileSync(absolutePath, "utf-8")
		: undefined;
	if (existing === yaml) return composeFileArg;
	if (existing !== undefined && docker?.writeStrategy === "if-missing") {
		throw new Error(
			`Generated Compose file ${absolutePath} differs from the current config. Set docker.writeStrategy to "always" to regenerate it; move customizations into service.docker. An existing file cannot be reconciled against a different model.`,
		);
	}
	mkdirSync(dirname(absolutePath), { recursive: true });
	const temporary = `${absolutePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
	try {
		writeFileSync(temporary, yaml, {
			encoding: "utf-8",
			flag: "wx",
			mode: 0o600,
		});
		renameSync(temporary, absolutePath);
	} finally {
		try {
			unlinkSync(temporary);
		} catch {
			/* Already published. */
		}
	}

	return composeFileArg;
}
