import {
	type BarUpdateDecision,
	decideBarUpdate,
	isCacheFresh,
	readBarCheckCache,
	writeBarCheckCache,
} from "../core/bar-update";
import {
	BAR_APP_NAME,
	barDecline,
	fetchLatestBarRelease,
	findInstalledBar,
	installBar,
	isBarOfferDisabled,
	isBarSupported,
	openBar,
	readInstalledBarInfo,
} from "../core/menubar";
import {
	askChoice,
	canPromptFirstRun,
	claimFirstRunPrompt,
} from "../core/prompt";
import { REGISTRY_VERSION } from "../core/run-registry";
import * as log from "./log";

/**
 * Offering the menu bar app, once, from `buncargo dev`.
 *
 * The rules are the named-hosts first-run prompt's rules, because two
 * onboarding questions that behave differently feel like two products: needs a
 * TTY, never in CI, "skip" is not remembered, "no" is a marker file, and at
 * most one first-run question per run — `claimFirstRunPrompt` is what enforces
 * the last one, so a fresh machine that just set up named hosts is not asked
 * about this too.
 *
 * Cheap by construction. On the overwhelmingly common path — the app is
 * installed, or was declined once — this costs one or two `existsSync` calls
 * and returns. `buncargo dev` runs constantly; nothing here may cost more.
 */
export async function offerMenuBarApp(): Promise<void> {
	if (!isBarSupported()) return;
	if (isBarOfferDisabled()) return;
	if (barDecline.has()) return;
	if (findInstalledBar()) return;
	if (!canPromptFirstRun()) return;
	// Last, because claiming it consumes the run's single prompt slot.
	if (!claimFirstRunPrompt()) return;

	const choice = await askChoice(
		[
			`  buncargo has a menu bar app that lists your running projects and`,
			"  services: open URLs, copy connection strings, TablePlus, stop apps.",
			"",
			"  Enter to install  ·  s to skip this once  ·  n to never ask again",
		],
		[
			{ key: "s", value: "skip" as const },
			{ key: "n", value: "decline" as const },
		],
		"install",
	);

	if (choice === "skip") return;
	if (choice === "decline") {
		barDecline.persist();
		log.info(
			`Skipping ${BAR_APP_NAME}. \`buncargo bar install\` adds it later.`,
		);
		return;
	}

	// A failed install is one warning and nothing else: this is an optional app
	// and the dev run behind it is already starting.
	try {
		log.info(`Downloading ${BAR_APP_NAME}…`);
		const result = await installBar();
		openBar(result.path);
		log.done(`Installed ${BAR_APP_NAME} ${result.version}`);
	} catch (error) {
		log.warn(
			`Could not install ${BAR_APP_NAME}: ${error instanceof Error ? error.message : String(error)}`,
		);
		log.hint("Run `buncargo bar install` to try again.");
	}
}

/**
 * Keeping an installed app current, from `buncargo dev`.
 *
 * Runs after the run is published rather than during startup, and every path
 * out of it is swallowed: this is an optional app, and a GitHub outage must not
 * colour a dev run. The common case — app current, cache fresh — is one small
 * JSON read and one `Info.plist` read, no network at all.
 *
 * Disabled by the same `BUNCARGO_BAR=0` and CI checks as the offer, because a
 * user who turned the app off should not have it downloading in the background.
 */
export async function checkMenuBarAppUpdate(): Promise<void> {
	if (!isBarSupported()) return;
	if (isBarOfferDisabled()) return;

	try {
		const installed = readInstalledBarInfo();
		if (!installed) return;

		const required = installed.registryVersion < REGISTRY_VERSION;
		const cache = readBarCheckCache();

		let latestVersion = cache?.latest?.version;
		if (!isCacheFresh(cache, { required })) {
			const release = await fetchLatestBarRelease();
			latestVersion = release?.version;
			writeBarCheckCache({
				checkedAt: new Date().toISOString(),
				latest: release,
				hintedVersion: cache?.hintedVersion,
			});
		}

		const decision = decideBarUpdate({
			installed,
			cliRegistryVersion: REGISTRY_VERSION,
			latestVersion,
			hintedVersion: cache?.hintedVersion,
		});
		await applyDecision(decision, installed.version);
	} catch {
		// Nothing here is worth a word on a successful dev run.
	}
}

async function applyDecision(
	decision: BarUpdateDecision,
	installedVersion: string | undefined,
): Promise<void> {
	if (decision.action === "none") return;

	if (decision.action === "hint") {
		log.hint(
			`${BAR_APP_NAME} ${decision.version} is available — \`buncargo bar update\``,
		);
		// Remembered even though nothing was installed: the point of the hint is
		// to be seen once, not on every run until it is acted on.
		const cache = readBarCheckCache();
		writeBarCheckCache({
			checkedAt: cache?.checkedAt ?? new Date().toISOString(),
			latest: cache?.latest,
			hintedVersion: decision.version,
		});
		return;
	}

	// Required: the installed app cannot read this CLI's registry, so its menu
	// is empty right now. Not a question — the user already said yes to the app.
	const label = installedVersion
		? `${BAR_APP_NAME} ${installedVersion}`
		: BAR_APP_NAME;
	log.info(`${label} cannot read this buncargo's runs.json — updating…`);
	try {
		const result = await installBar({ minRegistryVersion: REGISTRY_VERSION });
		log.done(`Updated ${BAR_APP_NAME} to ${result.version}`);
	} catch (error) {
		log.warn(
			`Could not update ${BAR_APP_NAME}: ${error instanceof Error ? error.message : String(error)}`,
		);
		log.hint("The menu will stay empty until it is updated.");
	}
}
