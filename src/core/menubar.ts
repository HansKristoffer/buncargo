import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { exec } from "./process/exec";
import { declineMarker } from "./prompt";
import { readJsonDocumentSync, writeJsonDocumentSync } from "./registry-file";
import { isCI } from "./runtime-flags";
import { chownToInvokingUser, getStateDir, stateFilePath } from "./state-paths";

/**
 * BuncargoBar — the macOS menu bar app that reads the run registry.
 *
 * The CLI's only jobs are to notice that it is missing, offer it once, and
 * install a prebuilt release. It never upgrades: once installed the app checks
 * for its own updates, and two updaters racing on the same bundle is how you
 * get a half-replaced app.
 *
 * Everything here is best-effort. The app is optional; a failed download must
 * read as "not installed" and never as a broken `buncargo dev`.
 */

export const BAR_APP_NAME = "BuncargoBar";
export const BAR_BUNDLE_NAME = `${BAR_APP_NAME}.app`;
export const BAR_DECLINE_FILENAME = "bar-declined";
export const BAR_MANIFEST_FILENAME = "bar.json";
const MANIFEST_VERSION = 1;

const RELEASES_ENDPOINT =
	"https://api.github.com/repos/HansKristoffer/buncargo/releases?per_page=20";
/** Tags for the app, kept apart from the CLI's own `v*` tags. */
export const BAR_TAG_PREFIX = "bar-v";

export const barDecline = declineMarker(BAR_DECLINE_FILENAME);

export interface BarManifest {
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

function writeBarManifest(path: string, appVersion: string): void {
	writeJsonDocumentSync(
		getBarManifestPath(),
		{
			version: MANIFEST_VERSION,
			path,
			appVersion,
			installedAt: new Date().toISOString(),
		} satisfies BarManifest,
		{ afterWrite: chownToInvokingUser },
	);
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
}

/**
 * Download and install the app.
 *
 * `ditto` rather than `unzip`, matching how the release is packed: it is the
 * only extractor that reliably preserves a bundle's code signature and
 * resource forks.
 */
export async function installBar(): Promise<BarInstallResult> {
	if (!isBarSupported()) {
		throw new Error(`${BAR_APP_NAME} is macOS only.`);
	}

	const release = await fetchLatestBarRelease();
	if (!release) {
		throw new Error(
			`No ${BAR_APP_NAME} release published yet. Build it from source with \`buncargo bar install --source\`.`,
		);
	}

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

		const target = join(installDirectory(), BAR_BUNDLE_NAME);
		rmSync(target, { recursive: true, force: true });
		const copy = run(`ditto ${quote(source)} ${quote(target)}`);
		if (copy.exitCode !== 0) {
			throw new Error(copy.stderr.trim() || `could not install to ${target}`);
		}

		// The bundle is ad-hoc signed, so Gatekeeper would otherwise refuse a
		// download the user did not open through Finder themselves.
		run(`xattr -dr com.apple.quarantine ${quote(target)}`);

		writeBarManifest(target, release.version);
		barDecline.clear();
		return { path: target, version: release.version };
	} finally {
		rmSync(workspace, { recursive: true, force: true });
	}
}

/** Build and install from `menubar/` in a checkout of this repo. */
export function installBarFromSource(repoRoot: string): BarInstallResult {
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
	writeBarManifest(path, "source");
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

export function uninstallBar(): boolean {
	const path = findInstalledBar();
	run(`osascript -e 'quit app "${BAR_APP_NAME}"'`);
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
