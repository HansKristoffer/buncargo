import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, existsSync } from "node:fs";
import {
	chmod,
	copyFile,
	lstat,
	mkdir,
	mkdtemp,
	open,
	readFile,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { withSignal as aborted } from "./deadline";
import { withFileLock } from "./file-lock";
import { chownToInvokingUser } from "./state-paths";
import { isInstalledTool, toolBinaryFingerprint } from "./tool-binary";

const runFile = promisify(execFile);
const DOWNLOAD_TIMEOUT_MS = 120_000;
const MAX_DOWNLOAD_BYTES = 256 * 1024 * 1024;
export type ToolFetch = (
	url: string,
	options: RequestInit,
) => Promise<Response>;

/** Download only complete successful HTTPS responses, with one total deadline. */
export async function downloadToolAsset(
	url: string,
	to: string,
	options: {
		fetch?: ToolFetch;
		timeoutMs?: number;
		maxBytes?: number;
		maxRedirects?: number;
		sha256?: string;
		signal?: AbortSignal;
	} = {},
): Promise<void> {
	const timeoutMs = options.timeoutMs ?? DOWNLOAD_TIMEOUT_MS;
	const maxBytes = options.maxBytes ?? MAX_DOWNLOAD_BYTES;
	const controller = new AbortController();
	const onAbort = () => controller.abort(options.signal?.reason);
	options.signal?.addEventListener("abort", onAbort, { once: true });
	if (options.signal?.aborted) onAbort();
	const timer = setTimeout(
		() =>
			controller.abort(
				new Error(`Tool download timed out after ${timeoutMs}ms`),
			),
		timeoutMs,
	);
	const { signal } = controller;
	let response: Response | undefined;
	let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
	let created = false;
	try {
		let current = new URL(url);
		for (let redirects = 0; ; redirects++) {
			if (current.protocol !== "https:")
				throw new Error(`Tool download requires HTTPS: ${current.origin}`);
			response = await aborted(
				(options.fetch ?? fetch)(current.href, {
					redirect: "manual",
					signal,
					headers: { "Accept-Encoding": "identity" },
				}),
				signal,
			);
			if (![301, 302, 303, 307, 308].includes(response.status)) break;
			await response.body?.cancel();
			const location = response.headers.get("location");
			if (!location || redirects >= (options.maxRedirects ?? 5))
				throw new Error(
					"Tool download exceeded its redirect limit or omitted the redirect location",
				);
			current = new URL(location, current);
		}
		if (!response.ok)
			throw new Error(
				`Tool download failed with HTTP ${response.status}: ${current.origin}${current.pathname}`,
			);
		if (!response.body)
			throw new Error("Tool download returned an empty response");
		const lengthHeader = response.headers.get("content-length");
		const expected = lengthHeader === null ? undefined : Number(lengthHeader);
		if (
			expected !== undefined &&
			(!Number.isSafeInteger(expected) || expected < 1 || expected > maxBytes)
		)
			throw new Error(
				"Tool download has an invalid or excessive content length",
			);
		const handle = await open(to, "wx", 0o600);
		created = true;
		reader = response.body.getReader();
		let size = 0;
		const hash = createHash("sha256");
		try {
			for (;;) {
				const chunk = await aborted(reader.read(), signal);
				if (chunk.done) break;
				size += chunk.value.byteLength;
				if (size > maxBytes)
					throw new Error("Tool download exceeded its size limit");
				hash.update(chunk.value);
				await handle.writeFile(chunk.value);
			}
			if (size === 0 || (expected !== undefined && size !== expected))
				throw new Error("Tool download was empty or truncated");
			if (
				options.sha256 &&
				hash.digest("hex").toLowerCase() !== options.sha256.toLowerCase()
			)
				throw new Error(
					"Tool download checksum did not match the release asset",
				);
			signal.throwIfAborted();
		} finally {
			await handle.close();
		}
	} catch (error) {
		if (created) await rm(to, { force: true });
		throw error;
	} finally {
		clearTimeout(timer);
		options.signal?.removeEventListener("abort", onAbort);
		if (reader) void reader.cancel().catch(() => {});
		else if (response?.body) void response.body.cancel().catch(() => {});
	}
}

async function verifyBinary(
	path: string,
	args: string[],
	expected: RegExp,
	signal?: AbortSignal,
): Promise<void> {
	const stat = await lstat(path);
	if (!stat.isFile() || stat.size === 0)
		throw new Error("Downloaded tool is not a regular executable file");
	const { stdout, stderr } = await runFile(path, args, {
		timeout: 5000,
		signal,
		killSignal: "SIGKILL",
		maxBuffer: 1024 * 1024,
	});
	if (!expected.test(`${stdout}\n${stderr}`))
		throw new Error("Downloaded tool did not report the expected version");
}

export interface ToolInstallOptions {
	to: string;
	url: string;
	versionArgs: string[];
	expectedVersion: RegExp;
	archiveEntry?: string;
	sha256?: string;
	/** Optional release metadata; its digest is used when GitHub publishes one. */
	githubAsset?: { repository: string; version: string; name: string };
	fetch?: ToolFetch;
	timeoutMs?: number;
	signal?: AbortSignal;
}

async function githubDigest(
	asset: NonNullable<ToolInstallOptions["githubAsset"]>,
	directory: string,
	fetcher?: ToolFetch,
	signal?: AbortSignal,
): Promise<string | undefined> {
	const tag =
		asset.version === "latest"
			? "latest"
			: `tags/${encodeURIComponent(asset.version)}`;
	const path = join(directory, "release.json");
	try {
		await downloadToolAsset(
			`https://api.github.com/repos/${asset.repository}/releases/${tag}`,
			path,
			{ fetch: fetcher, timeoutMs: 15_000, maxBytes: 4 * 1024 * 1024, signal },
		);
		const document = JSON.parse(await readFile(path, "utf8"));
		const digest = Array.isArray(document.assets)
			? document.assets.find(
					(entry: { name?: unknown }) => entry.name === asset.name,
				)?.digest
			: undefined;
		return typeof digest === "string" && /^sha256:[a-f0-9]{64}$/i.test(digest)
			? digest.slice(7)
			: undefined;
	} catch {
		signal?.throwIfAborted();
		// Older releases have no digests, and public metadata is rate-limited.
		// HTTPS + executable/version validation remain required in either case.
		return undefined;
	}
}

/** Stage, verify and atomically publish one version/platform's executable. */
export async function installTool(
	options: ToolInstallOptions,
): Promise<string> {
	options.signal?.throwIfAborted();
	const { to } = options;
	if (isInstalledTool(to, options.expectedVersion.source)) return to;
	return withFileLock(
		`${to}.install`,
		async () => {
			if (isInstalledTool(to, options.expectedVersion.source)) return to;
			await mkdir(dirname(to), { recursive: true });
			chownToInvokingUser(dirname(to));
			// Adopt a legacy cache only after proving it executes the desired tool.
			if (existsSync(to)) {
				try {
					await verifyBinary(
						to,
						options.versionArgs,
						options.expectedVersion,
						options.signal,
					);
					await writeReceipt(to, options.expectedVersion.source);
					return to;
				} catch {
					options.signal?.throwIfAborted();
					/* Preserve it until a verified replacement is ready. */
				}
			}
			const staging = await mkdtemp(
				join(dirname(to), `.${basename(to)}.install-`),
			);
			try {
				const asset = join(staging, "download");
				const digest =
					options.sha256 ??
					(options.githubAsset
						? await githubDigest(
								options.githubAsset,
								staging,
								options.fetch,
								options.signal,
							)
						: undefined);
				await downloadToolAsset(options.url, asset, {
					fetch: options.fetch,
					sha256: digest,
					timeoutMs: options.timeoutMs,
					signal: options.signal,
				});
				let executable = asset;
				if (options.archiveEntry) {
					if (basename(options.archiveEntry) !== options.archiveEntry)
						throw new Error("Tool archive entry must be a basename");
					await runFile(
						"tar",
						["-xzf", asset, "-C", staging, "--", options.archiveEntry],
						{ timeout: 30_000, signal: options.signal, killSignal: "SIGKILL" },
					);
					executable = join(staging, options.archiveEntry);
				}
				if (!(await lstat(executable)).isFile())
					throw new Error("Tool archive did not contain a regular executable");
				await chmod(executable, 0o755);
				await verifyBinary(
					executable,
					options.versionArgs,
					options.expectedVersion,
					options.signal,
				);
				chownToInvokingUser(executable);
				options.signal?.throwIfAborted();
				if (existsSync(to)) {
					const quarantine = `${to}.invalid-${Date.now()}-${process.pid}`;
					await copyFile(to, quarantine, constants.COPYFILE_EXCL);
					await chmod(quarantine, 0o600);
					chownToInvokingUser(quarantine);
				}
				await rename(executable, to);
				await writeReceipt(to, options.expectedVersion.source);
				return to;
			} finally {
				await rm(staging, { recursive: true, force: true });
			}
		},
		{
			timeoutMs: (options.timeoutMs ?? DOWNLOAD_TIMEOUT_MS) + 60_000,
			signal: options.signal,
		},
	);
}

async function writeReceipt(path: string, identity: string): Promise<void> {
	const receipt = `${path}.installed.json`;
	const temporary = `${receipt}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
	try {
		await writeFile(
			temporary,
			JSON.stringify({
				version: 1,
				identity,
				fingerprint: toolBinaryFingerprint(path),
			}),
			{ mode: 0o600, flag: "wx" },
		);
		chownToInvokingUser(temporary);
		await rename(temporary, receipt);
	} finally {
		await rm(temporary, { force: true });
	}
}
