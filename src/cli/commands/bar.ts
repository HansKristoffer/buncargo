import { getErrorMessage } from "hanzio";
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
import {
	type AnyCommand,
	BASE_EXITS,
	defineCommand,
	defineGroup,
} from "../command-spec";
import * as log from "../log";

/**
 * Never fires: Ctrl-C ends a `bar` command's process, and the download's own
 * deadline bounds the rest.
 */
const COMMAND_SIGNAL = new AbortController().signal;

/**
 * `buncargo bar` — the menu bar app, from the CLI side.
 *
 * Install, update, open, check and remove. The CLI is the only updater — the
 * app ships no update checker — so `update` here and the background check in
 * `dev` are the two ways an installed app ever moves forward.
 */
function barStep(
	name: string,
	summary: string,
	run: () => Promise<void> | void,
): AnyCommand {
	return defineCommand({
		spec: { name: `bar ${name}`, summary, flags: {} },
		exits: BASE_EXITS,
		run: async () => {
			requireMacOS();
			await run();
			return 0;
		},
	});
}

function requireMacOS(): void {
	if (!isBarSupported()) log.fail(`${BAR_APP_NAME} is macOS only.`);
}

const statusCommand = barStep(
	"status",
	"Installed version, and whether it is running",
	() => printStatus(),
);

export const barCommand = defineGroup({
	spec: { name: "bar", summary: "The BuncargoBar menu bar app" },
	subcommands: {
		install: defineCommand({
			spec: {
				name: "bar install",
				summary: "Download and install the menu bar app",
				flags: {
					source: {
						kind: "boolean",
						description: "Build it from this checkout's menubar/ instead",
					},
				},
			},
			exits: BASE_EXITS,
			run: async ({ values }) => {
				requireMacOS();
				await runInstall(values.source);
				return 0;
			},
		}),
		update: barStep("update", "Update the app to the latest release", () =>
			runUpdate(),
		),
		status: statusCommand,
		open: barStep(
			"open",
			"Open the app, installing it first if needed",
			async () => {
				const installed = findInstalledBar();
				if (!installed) {
					log.info(`${BAR_APP_NAME} is not installed yet — installing it now.`);
					await runInstall(false);
					return;
				}
				await rememberBarCli();
				openBar(installed);
			},
		),
		// Deliberately does not persist a decline: removing the app is not the
		// same as never wanting to be asked, and the next `dev` offering it
		// again is the honest reading of an uninstall.
		uninstall: barStep("uninstall", "Quit and remove the app", async () => {
			const removed = await uninstallBar();
			log.done(
				removed
					? `Removed ${BAR_APP_NAME}`
					: `${BAR_APP_NAME} was not installed`,
			);
		}),
		// The one that works anywhere: it only forgets a decline.
		reset: defineCommand({
			spec: {
				name: "bar reset",
				summary: "Offer the app again after declining it",
				flags: {},
			},
			exits: BASE_EXITS,
			run: () => {
				barDecline.clear();
				log.done(`buncargo dev will offer ${BAR_APP_NAME} again`);
				return 0;
			},
		}),
	},
	fallback: statusCommand,
});

async function runInstall(fromSource: boolean): Promise<void> {
	if (fromSource) {
		const result = await installBarFromSource(findMonorepoRoot());
		log.done(`Installed ${BAR_APP_NAME} to ${result.path}`);
		return;
	}

	log.info(`Downloading ${BAR_APP_NAME}…`);
	const result = await installBar({ signal: COMMAND_SIGNAL });
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
	const result = await installBar({
		signal: COMMAND_SIGNAL,
		minRegistryVersion: REGISTRY_VERSION,
	});
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
		log.line(`latest: unknown (${getErrorMessage(error)})`);
	}
}
