import { isAbsolute, normalize } from "node:path";
import {
	CONTAINER_RUNTIME_SELECTIONS,
	isContainerRuntimeSelection,
} from "../../container-runtime/names";
import type { AnyDevConfig } from "../../types";
import type { ValidationContext } from "./context";

export function validateRuntimeOptions(
	config: AnyDevConfig,
	context: ValidationContext,
): void {
	const { errors } = context;
	if (config.docker?.writeStrategy) {
		const writeStrategy = config.docker.writeStrategy;
		if (writeStrategy !== "always" && writeStrategy !== "if-missing") {
			errors.push(
				`docker.writeStrategy "${String(writeStrategy)}" is invalid. Use "always" or "if-missing".`,
			);
		}
	}

	if (
		config.docker?.runtime &&
		!isContainerRuntimeSelection(config.docker.runtime)
	) {
		errors.push(
			`docker.runtime "${String(config.docker.runtime)}" is invalid. Use ${CONTAINER_RUNTIME_SELECTIONS.map((value) => `"${value}"`).join(", ")}.`,
		);
	}

	if (config.docker?.binary && !isAbsolute(config.docker.binary)) {
		errors.push("docker.binary must be an absolute path to a runtime binary.");
	}

	// One override, two backends: under "auto" there is no way to tell which
	// one the path belongs to until after the probe that would have to run it.
	if (config.docker?.binary && config.docker.runtime === "auto") {
		errors.push(
			'docker.binary cannot be combined with docker.runtime: "auto" - it names one runtime\'s executable, so set docker.runtime to "docker" or "apple".',
		);
	}

	if (config.docker?.generatedFile) {
		const generatedFile = config.docker.generatedFile;
		if (isAbsolute(generatedFile)) {
			errors.push(
				"docker.generatedFile must be a relative path inside the repo.",
			);
		}

		const normalized = normalize(generatedFile).replace(/\\/g, "/");
		if (normalized === ".." || normalized.startsWith("../")) {
			errors.push(
				"docker.generatedFile cannot point outside the repository root.",
			);
		}
	}
}
