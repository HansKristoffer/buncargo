import {
	BAR_APP_NAME,
	barDecline,
	fetchLatestBarRelease,
	findInstalledBar,
	installBar,
	installBarFromSource,
	isBarRunning,
	isBarSupported,
	openBar,
	readBarManifest,
	uninstallBar,
} from "../../core/menubar";
import { findMonorepoRoot } from "../../core/ports";
import { hasFlag } from "../flags";
import * as log from "../log";
import { barSubcommandList, resolveBarSubcommand } from "./registry";

/**
 * `buncargo bar` — the menu bar app, from the CLI side.
 *
 * Install, open, check and remove. Never upgrade: the app has its own update
 * checker, and two updaters on one bundle is how it ends up half-replaced.
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
			openBar(installed);
			return;
		}
		case "uninstall": {
			// Deliberately does not persist a decline: removing the app is not
			// the same as never wanting to be asked, and the next `dev` offering
			// it again is the honest reading of an uninstall.
			const removed = uninstallBar();
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

async function printStatus(): Promise<void> {
	const installed = findInstalledBar();
	const manifest = readBarManifest();
	log.line(`app: ${installed ?? "not installed"}`);
	if (manifest) {
		log.line(`  version: ${manifest.appVersion}`);
		log.line(`  installed: ${manifest.installedAt}`);
	}
	if (installed) {
		log.line(`  running: ${isBarRunning() ? "yes" : "no"}`);
	}
	log.line(`offer: ${barDecline.has() ? "declined" : "enabled"}`);

	// Last, and tolerated when it fails: `bar status` has to work on a plane.
	try {
		const release = await fetchLatestBarRelease();
		log.line(`latest: ${release ? release.version : "none published"}`);
	} catch (error) {
		log.line(
			`latest: unknown (${error instanceof Error ? error.message : String(error)})`,
		);
	}
}
