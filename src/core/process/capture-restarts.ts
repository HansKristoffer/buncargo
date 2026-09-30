import type { AppConfig } from "../../types";
import { withSignal } from "../deadline";
import { formatWarn } from "../style";
import {
	type CapturedValue,
	createOutputCaptureScanner,
} from "./output-capture";

/** Serializes captured changes and dependent restarts in their arrival order. */
export function createCaptureRestarts(
	apps: Record<string, AppConfig>,
	options: {
		signal: AbortSignal;
		onCapture?: (
			app: string,
			captured: CapturedValue,
		) => readonly string[] | Promise<readonly string[]>;
		restart(name: string): Promise<void>;
	},
): (name: string, config: AppConfig) => ((text: string) => void) | undefined {
	let queue = Promise.resolve();
	return (name, config) => {
		if (!config.captures || !Object.keys(config.captures).length)
			return undefined;
		const scanner = createOutputCaptureScanner(config.captures);
		return (text) => {
			if (options.signal.aborted) return;
			for (const captured of scanner.push(text)) {
				queue = queue
					.then(async () => {
						options.signal.throwIfAborted();
						const changed = await withSignal(
							Promise.resolve().then(
								() => options.onCapture?.(name, captured) ?? [],
							),
							options.signal,
						);
						for (const [other, app] of Object.entries(apps)) {
							if (
								other !== name &&
								app.restartOn?.some((key) => changed.includes(key))
							) {
								options.signal.throwIfAborted();
								await options.restart(other);
							}
						}
					})
					.catch((error: unknown) => {
						if (!options.signal.aborted)
							console.warn(
								formatWarn(
									`Handling ${name}'s ${captured.name} failed: ${error instanceof Error ? error.message : String(error)}`,
								),
							);
					});
			}
		};
	};
}
