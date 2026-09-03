import {
	BAR_APP_NAME,
	barDecline,
	findInstalledBar,
	installBar,
	isBarOfferDisabled,
	isBarSupported,
	openBar,
} from "../core/menubar";
import {
	askChoice,
	canPromptFirstRun,
	claimFirstRunPrompt,
} from "../core/prompt";
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
