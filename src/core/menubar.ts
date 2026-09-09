import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { withFileLock } from "./file-lock";
import { exec } from "./process/exec";
import { declineMarker } from "./prompt";
import { readJsonDocumentSync, writeJsonDocumentSync } from "./registry-file";
import { isCI } from "./runtime-flags";
import { chownToInvokingUser, getStateDir, stateFilePath } from "./state-paths";
import { installTailnetBundle } from "./tailnet/bundle";

/**
 * BuncargoBar — the macOS menu bar app that reads the run registry.
 *
 * The CLI notices that it is missing, offers it once, installs a prebuilt
 * release, and keeps it current. It is the *only* updater: the app itself
 * ships no update checker, and one updater is what keeps two of them from
 * racing on the same bundle. `withFileLock` covers the remaining race, which
 * is two `buncargo dev`s starting at the same moment.
 *
 * Everything here is best-effort. The app is optional; a failed download must
 * read as "not installed" and never as a broken `buncargo dev`.
 */

export const BAR_APP_NAME = "BuncargoBar";
export const BAR_BUNDLE_NAME = `${BAR_APP_NAME}.app`;
export const BAR_DECLINE_FILENAME = "bar-declined";
export const BAR_MANIFEST_FILENAME = "bar.json";
const MANIFEST_VERSION = 1;

/**
 * `Info.plist` key holding the `runs.json` schema the bundle can decode.
 *
 * Stamped by `menubar/scripts/package.sh` from the shared fixture. Bundles
 * built before this key existed decode v1, which is what the fallback says.
 */
const REGISTRY_VERSION_KEY = "BuncargoRegistryVersion";
const ASSUMED_REGISTRY_VERSION = 1;

/** A background check has no user waiting on it, and no right to hang. */
const RELEASE_FETCH_TIMEOUT_MS = 5000;

/** How long a polite quit gets before `pkill`. */
const QUIT_TIMEOUT_MS = 3000;
const QUIT_POLL_MS = 100;

/** An install from `--source`, which has no release version to compare. */
export const BAR_SOURCE_VERSION = "source";

// 100, not 20: CLI releases share this list and only the `bar-v` ones count.
const RELEASES_ENDPOINT =
	"https://api.github.com/repos/HansKristoffer/buncargo/releases?per_page=100";
/** Tags for the app, kept apart from the CLI's own `v*` tags. */
export const BAR_TAG_PREFIX = "bar-v";

export const barDecline = declineMarker(BAR_DECLINE_FILENAME);

export interface BarManifest {
	cli?: { program: string; script: string };
	version: number;
	/** Absolute path to the installed `.app` bundle. */
	path: string;
	appVersion: string;
	installedAt: string;
}

export function getBarManifestPath(home?: string): string {
	return stateFilePath(BAR_MANIFEST_FILENAME, home);
}

function isBarManifest(value: unknown): BarManifest | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const manifest = value as Partial<BarManifest>;
	if (manifest.version !== MANIFEST_VERSION) return undefined;
	if (typeof manifest.path !== "string") return undefined;
	if (typeof manifest.appVersion !== "string") return undefined;
	return manifest as BarManifest;
}

export function readBarManifest(): BarManifest | undefined {
	return readJsonDocumentSync(getBarManifestPath(), isBarManifest);
}

function writeBarManifest(
	path: string,
	appVersion: string,
	script: string,
): void {
	writeJsonDocumentSync(
		getBarManifestPath(),
		{
			version: MANIFEST_VERSION,
			path,
			appVersion,
			installedAt: new Date().toISOString(),
			cli: { program: process.execPath, script },
		} satisfies BarManifest,
		{ afterWrite: chownToInvokingUser },
	);
}

/** Refresh the receiver command even when the menu app itself is already current. */
export async function rememberBarCli(): Promise<void> {
	await withFileLock(getBarManifestPath(), async () => {
		const manifest = readBarManifest();
		if (!manifest) return;
		writeJsonDocumentSync(
			getBarManifestPath(),
			{
				...manifest,
				cli: { program: process.execPath, script: installTailnetBundle() },
			},
			{ afterWrite: chownToInvokingUser },
		);
	});
}

/** Where the bundle can live, most preferred first. */
function candidateBundlePaths(home = homedir()): string[] {
	return [
		join("/Applications", BAR_BUNDLE_NAME),
		join(home, "Applications", BAR_BUNDLE_NAME),
	];
}

/**
 * Is the app on this machine?
 *
 * Two `existsSync` calls and one small file read, deliberately: this runs on
 * every `buncargo dev`, and the whole point of the command is to start fast.
 * No Spotlight query, no `mdfind`, no process listing.
 */
export function findInstalledBar(home?: string): string | undefined {
	const manifest = readBarManifest();
	if (manifest && existsSync(manifest.path)) return manifest.path;
	return candidateBundlePaths(home).find((path) => existsSync(path));
}

export interface InstalledBarInfo {
	path: string;
	/** `CFBundleShortVersionString`, or `undefined` for an unreadable plist. */
	version?: string;
	/** The `runs.json` schema this bundle decodes. */
	registryVersion: number;
}

/**
 * What the installed bundle says about itself.
 *
 * A regex over our own `Info.plist` rather than a `plutil` spawn: this runs on
 * the `buncargo dev` path, the file is written by `package.sh` two lines from
 * the pattern below, and a process spawn costs more than reading it.
 */
export function readInstalledBarInfo(
	home?: string,
): InstalledBarInfo | undefined {
	const path = findInstalledBar(home);
	return path ? readBundleInfo(path) : undefined;
}

/** The same read, for a bundle that is not installed yet. */
export function readBundleInfo(path: string): InstalledBarInfo {
	let plist = "";
	try {
		plist = readFileSync(join(path, "Contents", "Info.plist"), "utf-8");
	} catch {
		// An unreadable plist still leaves an app we know the path of. Treat it
		// as the oldest thing it could be rather than as not installed.
		return { path, registryVersion: ASSUMED_REGISTRY_VERSION };
	}
	return {
		path,
		version: plistString(plist, "CFBundleShortVersionString"),
		registryVersion:
			plistInteger(plist, REGISTRY_VERSION_KEY) ?? ASSUMED_REGISTRY_VERSION,
	};
}

function plistValue(
	plist: string,
	key: string,
	type: "string" | "integer",
): string | undefined {
	const pattern = new RegExp(`<key>${key}</key>\\s*<${type}>([^<]*)</${type}>`);
	return pattern.exec(plist)?.[1]?.trim();
}

function plistString(plist: string, key: string): string | undefined {
	const value = plistValue(plist, key, "string");
	return value ? value : undefined;
}

function plistInteger(plist: string, key: string): number | undefined {
	const value = plistValue(plist, key, "integer");
	if (value === undefined) return undefined;
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) ? parsed : undefined;
}

export function isBarSupported(
	platform: NodeJS.Platform = process.platform,
): boolean {
	return platform === "darwin";
}

/** `BUNCARGO_BAR=0` turns the offer off without persisting a decline. */
export function isBarOfferDisabled(
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	return env.BUNCARGO_BAR === "0" || isCI(env);
}

export interface BarRelease {
	tag: string;
	version: string;
	zipUrl: string;
	checksumUrl?: string;
}

interface GithubAsset {
	name?: unknown;
	browser_download_url?: unknown;
}

interface GithubRelease {
	tag_name?: unknown;
	draft?: unknown;
	prerelease?: unknown;
	assets?: unknown;
}

/**
 * The newest app release.
 *
 * Not `releases/latest`: that endpoint returns whichever release was published
 * most recently across the whole repository, which here is usually a CLI `v7.x`
 * tag with no app in it.
 */
export async function fetchLatestBarRelease(): Promise<BarRelease | undefined> {
	const response = await fetch(RELEASES_ENDPOINT, {
		headers: { Accept: "application/vnd.github+json" },
		// The background check must not keep a dev run's event loop alive on a
		// hung connection.
		signal: AbortSignal.timeout(RELEASE_FETCH_TIMEOUT_MS),
	});
	if (!response.ok) {
		throw new Error(`GitHub returned ${response.status} listing releases`);
	}
	const releases = (await response.json()) as GithubRelease[];
	if (!Array.isArray(releases)) return undefined;

	for (const release of releases) {
		const tag = typeof release.tag_name === "string" ? release.tag_name : "";
		if (!tag.startsWith(BAR_TAG_PREFIX)) continue;
		if (release.draft === true || release.prerelease === true) continue;
		const assets = Array.isArray(release.assets)
			? (release.assets as GithubAsset[])
			: [];
		const zip = assets.find(
			(asset) => typeof asset.name === "string" && asset.name.endsWith(".zip"),
		);
		if (!zip || typeof zip.browser_download_url !== "string") continue;
		const checksum = assets.find(
			(asset) =>
				typeof asset.name === "string" && asset.name.endsWith(".zip.sha256"),
		);
		return {
			tag,
			version: tag.slice(BAR_TAG_PREFIX.length),
			zipUrl: zip.browser_download_url,
			checksumUrl:
				typeof checksum?.browser_download_url === "string"
					? checksum.browser_download_url
					: undefined,
		};
	}
	return undefined;
}

async function download(url: string, destination: string): Promise<void> {
	const response = await fetch(url, { redirect: "follow" });
	if (!response.ok) {
		throw new Error(`Download failed with ${response.status}: ${url}`);
	}
	await Bun.write(destination, response);
}

/**
 * Verify the zip against the published checksum.
 *
 * A release without one still installs: the asset is ours to publish and an
 * older release may predate it. A checksum that is present and wrong is fatal.
 */
async function verifyChecksum(
	zipPath: string,
	checksumUrl: string | undefined,
): Promise<void> {
	if (!checksumUrl) return;
	const response = await fetch(checksumUrl, { redirect: "follow" });
	if (!response.ok) return;
	const expected = (await response.text()).trim().split(/\s+/)[0];
	if (!expected) return;

	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(await Bun.file(zipPath).arrayBuffer());
	const actual = hasher.digest("hex");
	if (actual !== expected) {
		throw new Error(
			`Checksum mismatch for the downloaded app (expected ${expected}, got ${actual}).`,
		);
	}
}

function installDirectory(home = homedir()): string {
	// `/Applications` when we can write it, the user's own otherwise. Never
	// asks for a password: an optional menu bar app is not worth a sudo prompt.
	try {
		const probe = join("/Applications", `.buncargo-write-probe-${process.pid}`);
		Bun.write(probe, "");
		rmSync(probe, { force: true });
		return "/Applications";
	} catch {
		return join(home, "Applications");
	}
}

export interface BarInstallResult {
	path: string;
	version: string;
	/** The app was running before the swap and was started again after it. */
	relaunched?: boolean;
}

/**
 * Download and install the app.
 *
 * `ditto` rather than `unzip`, matching how the release is packed: it is the
 * only extractor that reliably preserves a bundle's code signature and
 * resource forks.
 */
export interface BarInstallOptions {
	/**
	 * Refuse a release whose bundle cannot decode this `runs.json` version.
	 *
	 * The guard for a CLI release that goes out before its matching `bar-v*`
	 * one: better to keep the old app and say so than to install a second app
	 * that also cannot read the registry.
	 */
	minRegistryVersion?: number;
}

/**
 * Download and install the app, replacing any copy already there.
 *
 * `ditto` rather than `unzip`, matching how the release is packed: it is the
 * only extractor that reliably preserves a bundle's code signature and
 * resource forks.
 *
 * The lock is on the manifest, so two `buncargo dev`s starting together
 * serialise here instead of racing on one bundle — the whole reason the CLI is
 * the only updater.
 */
export async function installBar(
	options: BarInstallOptions = {},
): Promise<BarInstallResult> {
	if (!isBarSupported()) {
		throw new Error(`${BAR_APP_NAME} is macOS only.`);
	}

	const release = await fetchLatestBarRelease();
	if (!release) {
		throw new Error(
			`No ${BAR_APP_NAME} release published yet. Build it from source with \`buncargo bar install --source\`.`,
		);
	}

	return withFileLock(getBarManifestPath(), () =>
		applyRelease(release, options),
	);
}

async function applyRelease(
	release: BarRelease,
	options: BarInstallOptions,
): Promise<BarInstallResult> {
	const discoveryScript = installTailnetBundle();
	const workspace = mkdtempSync(join(tmpdir(), "buncargo-bar-"));
	try {
		const zipPath = join(workspace, "bar.zip");
		await download(release.zipUrl, zipPath);
		await verifyChecksum(zipPath, release.checksumUrl);

		const extracted = join(workspace, "extracted");
		const unzip = run(`ditto -x -k ${quote(zipPath)} ${quote(extracted)}`);
		if (unzip.exitCode !== 0) {
			throw new Error(unzip.stderr.trim() || "could not expand the archive");
		}

		const source = join(extracted, BAR_BUNDLE_NAME);
		if (!existsSync(source)) {
			throw new Error(`The release archive has no ${BAR_BUNDLE_NAME} in it.`);
		}

		// Before touching the installed copy: a release that still cannot read
		// this CLI's registry is not an upgrade, and swapping it in would only
		// replace one unusable app with another.
		const incoming = readBundleInfo(source);
		const required = options.minRegistryVersion;
		if (required !== undefined && incoming.registryVersion < required) {
			throw new Error(
				`${BAR_APP_NAME} ${release.version} reads runs.json v${incoming.registryVersion}, but this buncargo writes v${required}. No compatible release is published yet.`,
			);
		}

		// Quit before replacing: a bundle swapped out from under a running app
		// is how you get a half-updated one, and relaunching is only honest if
		// it was running to begin with.
		const wasRunning = await quitBar();

		const target = join(installDirectory(), BAR_BUNDLE_NAME);
		rmSync(target, { recursive: true, force: true });
		const copy = run(`ditto ${quote(source)} ${quote(target)}`);
		if (copy.exitCode !== 0) {
			throw new Error(copy.stderr.trim() || `could not install to ${target}`);
		}

		// The bundle is ad-hoc signed, so Gatekeeper would otherwise refuse a
		// download the user did not open through Finder themselves.
		run(`xattr -dr com.apple.quarantine ${quote(target)}`);

		writeBarManifest(target, release.version, discoveryScript);
		barDecline.clear();
		if (wasRunning) openBar(target);
		return { path: target, version: release.version, relaunched: wasRunning };
	} finally {
		rmSync(workspace, { recursive: true, force: true });
	}
}

/** Build and install from `menubar/` in a checkout of this repo. */
export function installBarFromSource(repoRoot: string): BarInstallResult {
	const discoveryScript = installTailnetBundle();
	const script = join(repoRoot, "menubar", "scripts", "install.sh");
	if (!existsSync(script)) {
		throw new Error(`No menubar sources at ${script}.`);
	}
	const result = run(`bash ${quote(script)}`, { verbose: true });
	if (result.exitCode !== 0) {
		throw new Error("Building the app from source failed.");
	}
	const path = findInstalledBar();
	if (!path) {
		throw new Error("The build finished but no app bundle was installed.");
	}
	writeBarManifest(path, "source", discoveryScript);
	barDecline.clear();
	return { path, version: "source" };
}

export function openBar(path?: string): void {
	const bundle = path ?? findInstalledBar();
	if (!bundle) throw new Error(`${BAR_APP_NAME} is not installed.`);
	run(`open ${quote(bundle)}`);
}

export function isBarRunning(): boolean {
	return run(`pgrep -x ${BAR_APP_NAME}`).exitCode === 0;
}

/**
 * Quit a running app and wait for it to actually go.
 *
 * `osascript` asks politely, which is what lets the app tear its status item
 * down; `pkill` is the backstop for one that ignores the request. Both callers
 * remove or replace the bundle next, so returning while the process still
 * holds it is the bug this exists to prevent.
 *
 * Returns whether it was running, which is what decides a relaunch.
 */
export async function quitBar(): Promise<boolean> {
	if (!isBarRunning()) return false;
	run(`osascript -e 'quit app "${BAR_APP_NAME}"'`);

	const deadline = Date.now() + QUIT_TIMEOUT_MS;
	while (Date.now() < deadline) {
		if (!isBarRunning()) return true;
		await Bun.sleep(QUIT_POLL_MS);
	}
	run(`pkill -x ${BAR_APP_NAME}`);
	return true;
}

export async function uninstallBar(): Promise<boolean> {
	const path = findInstalledBar();
	await quitBar();
	if (path) rmSync(path, { recursive: true, force: true });
	rmSync(getBarManifestPath(), { force: true });
	return path !== undefined;
}

/** `exec` with the arguments this module never varies. */
function run(command: string, options: { verbose?: boolean } = {}) {
	return exec(
		command,
		process.cwd(),
		{},
		{
			throwOnError: false,
			verbose: options.verbose ?? false,
		},
	);
}

/** Shell-quote a path. Everything here is a path, and paths have spaces. */
function quote(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

/** So callers can report where state lives without importing state-paths. */
export function barStateDir(): string {
	return getStateDir();
}
