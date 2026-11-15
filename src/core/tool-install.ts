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
	readdir,
	readFile,
	rename,
	rm,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { withSignal as aborted } from "./deadline";
import { withFileLock } from "./file-lock";
import { writeJsonDocument } from "./registry-file";
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

	const timer = setTimeout(() => {
		const timeout = new Error(`Tool download timed out after ${timeoutMs}ms`);
		controller.abort(timeout);
	}, timeoutMs);
	const { signal } = controller;

	let response: Response | undefined;
	let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
	let created = false;

	try {
		let current = new URL(url);

		// Redirects are followed by hand so each hop is checked for HTTPS.
		for (let redirects = 0; ; redirects++) {
			if (current.protocol !== "https:") {
				throw new Error(`Tool download requires HTTPS: ${current.origin}`);
			}

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
			const outOfRedirects = redirects >= (options.maxRedirects ?? 5);
			if (!location || outOfRedirects) {
				throw new Error(
					"Tool download exceeded its redirect limit or omitted the redirect location",
				);
			}
			current = new URL(location, current);
		}

		if (!response.ok) {
			throw new Error(
				`Tool download failed with HTTP ${response.status}: ${current.origin}${current.pathname}`,
			);
		}
		if (!response.body) {
			throw new Error("Tool download returned an empty response");
		}

		const lengthHeader = response.headers.get("content-length");
		const expected = lengthHeader === null ? undefined : Number(lengthHeader);
		const lengthIsValid =
			expected === undefined ||
			(Number.isSafeInteger(expected) && expected >= 1 && expected <= maxBytes);
		if (!lengthIsValid) {
			throw new Error(
				"Tool download has an invalid or excessive content length",
			);
		}

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
				if (size > maxBytes) {
					throw new Error("Tool download exceeded its size limit");
				}
				hash.update(chunk.value);
				await handle.writeFile(chunk.value);
			}

			const truncated = expected !== undefined && size !== expected;
			if (size === 0 || truncated) {
				throw new Error("Tool download was empty or truncated");
			}

			const checksumMismatch =
				options.sha256 &&
				hash.digest("hex").toLowerCase() !== options.sha256.toLowerCase();
			if (checksumMismatch) {
				throw new Error(
					"Tool download checksum did not match the release asset",
				);
			}

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
	if (!stat.isFile() || stat.size === 0) {
		throw new Error("Downloaded tool is not a regular executable file");
	}

	const { stdout, stderr } = await runFile(path, args, {
		timeout: 5000,
		signal,
		killSignal: "SIGKILL",
		maxBuffer: 1024 * 1024,
	});
	if (!expected.test(`${stdout}\n${stderr}`)) {
		throw new Error("Downloaded tool did not report the expected version");
	}
}

/**
 * A release asset whose digest GitHub publishes, for a version the user chose
 * and buncargo has no pin for. No published digest means no install.
 */
interface PublishedDigest {
	repository: string;
	version: string;
	name: string;
	/** The settings named when no digest is published: the version, and the binary path. */
	settings: { version: string; path: string };
}

export interface ToolInstallOptions {
	to: string;
	url: string;
	versionArgs: string[];
	expectedVersion: RegExp;
	archiveEntry?: string;
	/** The asset's sha256: pinned, or read from its release. Nothing unverified is executed. */
	sha256: string | PublishedDigest;
	fetch?: ToolFetch;
	timeoutMs?: number;
	signal?: AbortSignal;
}

async function publishedDigest(
	asset: PublishedDigest,
	directory: string,
	fetcher?: ToolFetch,
	signal?: AbortSignal,
): Promise<string> {
	const tag =
		asset.version === "latest"
			? "latest"
			: `tags/${encodeURIComponent(asset.version)}`;
	const path = join(directory, "release.json");

	let digest: unknown;
	try {
		await downloadToolAsset(
			`https://api.github.com/repos/${asset.repository}/releases/${tag}`,
			path,
			{ fetch: fetcher, timeoutMs: 15_000, maxBytes: 4 * 1024 * 1024, signal },
		);
		const document = JSON.parse(await readFile(path, "utf8"));
		digest = Array.isArray(document.assets)
			? document.assets.find(
					(entry: { name?: unknown }) => entry.name === asset.name,
				)?.digest
			: undefined;
	} catch {
		signal?.throwIfAborted();
		// A rate limit or an outage reads as no digest: the install fails closed below.
	}

	if (typeof digest === "string" && /^sha256:[a-f0-9]{64}$/i.test(digest)) {
		return digest.slice(7);
	}

	const { settings } = asset;
	throw new Error(
		`${settings.version}=${asset.version} has no pinned sha256, and none for ${asset.name} could be read from its GitHub release, so buncargo will not download it. Unset ${settings.version} to use the pinned version, or set ${settings.path} to a binary you installed.`,
	);
}

/**
 * Extract one entry of a downloaded archive into `staging` and return the
 * extracted file.
 *
 * Bottles nest the binary. Its parents are stripped so extraction writes one
 * basename into staging, never an archive-controlled directory tree.
 */
async function extractArchiveEntry(
	archive: string,
	entry: string,
	staging: string,
	signal?: AbortSignal,
): Promise<string> {
	const parts = entry.split("/");
	const hasUnsafePart = parts.some(
		(part) => !part || part === "." || part === ".." || part.includes("\\"),
	);
	if (hasUnsafePart) {
		throw new Error(
			"Tool archive entry must be a relative path without traversal",
		);
	}

	await runFile(
		"tar",
		[
			"-xzf",
			archive,
			"-C",
			staging,
			`--strip-components=${parts.length - 1}`,
			"--",
			entry,
		],
		{ timeout: 30_000, signal, killSignal: "SIGKILL" },
	);

	return join(staging, basename(entry));
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
			// Another process may have finished the install while this one waited for the lock.
			if (isInstalledTool(to, options.expectedVersion.source)) return to;

			await mkdir(dirname(to), { recursive: true });
			chownToInvokingUser(dirname(to));
			const staging = await mkdtemp(
				join(dirname(to), `.${basename(to)}.install-`),
			);

			try {
				const asset = join(staging, "download");
				const digest =
					typeof options.sha256 === "string"
						? options.sha256
						: await publishedDigest(
								options.sha256,
								staging,
								options.fetch,
								options.signal,
							);
				await downloadToolAsset(options.url, asset, {
					fetch: options.fetch,
					sha256: digest,
					timeoutMs: options.timeoutMs,
					signal: options.signal,
				});

				const executable = options.archiveEntry
					? await extractArchiveEntry(
							asset,
							options.archiveEntry,
							staging,
							options.signal,
						)
					: asset;
				if (!(await lstat(executable)).isFile()) {
					throw new Error("Tool archive did not contain a regular executable");
				}
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
					// Only the copy being replaced now is kept to look at: one per
					// replacement piled up beside the tool forever.
					await removeQuarantines(to);
					const quarantine = `${to}${QUARANTINE_INFIX}${Date.now()}-${process.pid}`;
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

/** A replaced executable, kept beside the tool as `<tool>.invalid-<time>-<pid>`. */
const QUARANTINE_INFIX = ".invalid-";

async function removeQuarantines(to: string): Promise<void> {
	const prefix = `${basename(to)}${QUARANTINE_INFIX}`;
	const names = await readdir(dirname(to));
	await Promise.all(
		names
			.filter((name) => name.startsWith(prefix))
			.map((name) => rm(join(dirname(to), name), { force: true })),
	);
}

async function writeReceipt(path: string, identity: string): Promise<void> {
	await writeJsonDocument(
		`${path}.installed.json`,
		{ version: 1, identity, fingerprint: toolBinaryFingerprint(path) },
		{ afterWrite: chownToInvokingUser },
	);
}
