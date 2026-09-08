import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { terminateOwnedProcess } from "../../process/terminate";
import { tailcatDerpMap } from "../../runtime-flags";
import { ensureTailcat } from "./binary";
import { TAILCAT_GUARD } from "./process-guard";
export interface TailcatProcess<T> {
	value: T;
	exited: Promise<void>;
	close(): Promise<void>;
}
/** Own the process group and discard diagnostic output: addresses are credentials. */
export async function startTailcat<T>(
	args: string[],
	parse: (line: string) => T | undefined,
	signal?: AbortSignal,
): Promise<TailcatProcess<T>> {
	const binary = await ensureTailcat(signal);
	signal?.throwIfAborted();
	const map = tailcatDerpMap();
	const child = spawn(
		process.execPath,
		["-e", TAILCAT_GUARD, "--", binary, `--derpmap-url=${map}`, ...args],
		{ detached: true, stdio: ["pipe", "pipe", "pipe"] },
	);
	let closing: Promise<void> | undefined;
	const close = () => {
		closing ??= terminateOwnedProcess(child, 1000);
		return closing;
	};
	const exited = new Promise<void>((resolve) => {
		child.once("exit", () => resolve());
		child.once("error", () => resolve());
	});
	const abort = () => {
		void close().catch(() => {});
	};
	signal?.addEventListener("abort", abort, { once: true });
	void exited.then(() => signal?.removeEventListener("abort", abort));
	const readers = [child.stdout, child.stderr].map((input) =>
		createInterface({ input }),
	);
	try {
		const value = await new Promise<T>((resolve, reject) => {
			const timeout = setTimeout(
				() =>
					reject(
						new Error(
							"Tailcat startup timed out; check network access to the DERP relay",
						),
					),
				30_000,
			);
			const finish = (error?: Error, value?: T) => {
				clearTimeout(timeout);
				error ? reject(error) : resolve(value as T);
			};
			for (const reader of readers)
				reader.on("line", (line) => {
					if (line.length > 16384) return;
					try {
						const value = parse(line);
						if (value !== undefined) finish(undefined, value);
					} catch {
						finish(new Error("Invalid Tailcat startup response"));
					}
				});
			void exited.then(() =>
				finish(
					new Error(
						"Tailcat exited; check the binary version and relay connectivity",
					),
				),
			);
		});
		if (signal?.aborted) throw new Error("Tailcat startup cancelled");
		return { value, exited, close };
	} catch (error) {
		await close();
		throw error;
	} finally {
		for (const reader of readers) {
			reader.removeAllListeners("line");
			reader.on("line", () => {});
		}
	}
}
