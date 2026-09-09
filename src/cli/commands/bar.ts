import {
	BAR_APP_NAME,
	BAR_SOURCE_VERSION,
	barDecline,
	fetchLatestBarRelease,
	findInstalledBar,
	installBar,
	installBarFromSource,
	isBarRunning,
	isBarSupported,
	openBar,
	readBarManifest,
	readInstalledBarInfo,
	rememberBarCli,
	uninstallBar,
} from "../../core/menubar";
import { findMonorepoRoot } from "../../core/ports";
import { REGISTRY_VERSION } from "../../core/run-registry";
import { hasFlag } from "../flags";
import * as log from "../log";
import { barSubcommandList, resolveBarSubcommand } from "./registry";

/**
 * `buncargo bar` — the menu bar app, from the CLI side.
 *
 * Install, update, open, check and remove. The CLI is the only updater — the
 * app ships no update checker — so `update` here and the background check in
 * `dev` are the two ways an installed app ever moves forward.
 */
export async function handleBar(args: string[]): Promise<void> {
	const requested = args[0] ?? "status";
	const subcommand = resolveBarSubcommand(requested);
	if (!subcommand) {
		log.fail(`Unknown bar command: ${requested}`, [
			`Use: buncargo bar ${barSubcommandList()}`,
		]);
	}

	if (!isBarSupported() && subcommand !== "reset") {
		log.fail(`${BAR_APP_NAME} is macOS only.`);
	}

	switch (subcommand) {
		case "install":
			await runInstall(hasFlag(args, "--source"));
			return;
		case "update":
			await runUpdate();
			return;
		case "status":
			await printStatus();
			return;
		case "open": {
			const installed = findInstalledBar();
			if (!installed) {
				log.info(`${BAR_APP_NAME} is not installed yet — installing it now.`);
				await runInstall(false);
				return;
			}
			await rememberBarCli();
			openBar(installed);
			return;
		}
		case "uninstall": {
			// Deliberately does not persist a decline: removing the app is not
			// the same as never wanting to be asked, and the next `dev` offering
			// it again is the honest reading of an uninstall.
			const removed = await uninstallBar();
			log.done(
				removed
					? `Removed ${BAR_APP_NAME}`
					: `${BAR_APP_NAME} was not installed`,
			);
			return;
		}
		case "reset":
			barDecline.clear();
			log.done(`buncargo dev will offer ${BAR_APP_NAME} again`);
			return;
		default: {
			const exhaustive: never = subcommand;
			throw new Error(`Unhandled bar subcommand: ${String(exhaustive)}`);
		}
	}
}

async function runInstall(fromSource: boolean): Promise<void> {
	if (fromSource) {
		const result = installBarFromSource(findMonorepoRoot());
		log.done(`Installed ${BAR_APP_NAME} to ${result.path}`);
		return;
	}

	log.info(`Downloading ${BAR_APP_NAME}…`);
	const result = await installBar();
	log.done(`Installed ${BAR_APP_NAME} ${result.version} to ${result.path}`);
	openBar(result.path);
}

/**
 * `bar update` — the manual half of the same path `dev` takes automatically.
 *
 * Always passes `minRegistryVersion`, so a release that still cannot read this
 * CLI's registry is refused with a message rather than installed over a working
 * app.
 */
async function runUpdate(): Promise<void> {
	const installed = readInstalledBarInfo();
	if (!installed) {
		log.info(`${BAR_APP_NAME} is not installed yet — installing it now.`);
		await runInstall(false);
		return;
	}

	const release = await fetchLatestBarRelease();
	if (!release) {
		log.info(`No ${BAR_APP_NAME} release is published yet.`);
		return;
	}

	const compatible = installed.registryVersion >= REGISTRY_VERSION;
	if (compatible && installed.version === release.version) {
		await rememberBarCli();
		log.done(`${BAR_APP_NAME} ${release.version} is already current`);
		return;
	}

	log.info(
		`Updating ${BAR_APP_NAME} ${installed.version ?? "?"} → ${release.version}…`,
	);
	const result = await installBar({ minRegistryVersion: REGISTRY_VERSION });
	log.done(
		result.relaunched
			? `Updated ${BAR_APP_NAME} to ${result.version} and restarted it`
			: `Updated ${BAR_APP_NAME} to ${result.version}`,
	);
}

async function printStatus(): Promise<void> {
	const info = readInstalledBarInfo();
	const manifest = readBarManifest();
	log.line(`app: ${info?.path ?? "not installed"}`);
	if (info) {
		log.line(`  version: ${info.version ?? manifest?.appVersion ?? "unknown"}`);
		// The number that decides whether the app can read this CLI at all.
		log.line(
			`  runs.json: reads v${info.registryVersion}, buncargo writes v${REGISTRY_VERSION}` +
				(info.registryVersion < REGISTRY_VERSION
					? " — run `buncargo bar update`"
					: ""),
		);
	}
	if (manifest) {
		log.line(`  installed: ${manifest.installedAt}`);
	}
	if (info) {
		log.line(`  running: ${isBarRunning() ? "yes" : "no"}`);
	}
	log.line(`offer: ${barDecline.has() ? "declined" : "enabled"}`);

	// Last, and tolerated when it fails: `bar status` has to work on a plane.
	try {
		const release = await fetchLatestBarRelease();
		const behind =
			release &&
			info?.version &&
			info.version !== BAR_SOURCE_VERSION &&
			info.version !== release.version;
		log.line(
			`latest: ${release ? release.version : "none published"}${behind ? " — `buncargo bar update`" : ""}`,
		);
	} catch (error) {
		log.line(
			`latest: unknown (${error instanceof Error ? error.message : String(error)})`,
		);
	}
}
