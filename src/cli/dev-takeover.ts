import { typedSwitch } from "hanzio";

/**
 * What a `dev` run decided about apps another run serves: nothing, every one
 * (`--takeover`), or the apps a prompt or the unhealthy-app rule accepted.
 *
 * One value read at every point that acts on it: the explicit takeover, the
 * unhealthy-app takeover, the "already running" prompt and the exclusive
 * leases. Each used to read `--takeover` alone, so an app taken over by a `y`
 * was asked about again at its lease, or refused there with no terminal after
 * the other run's server was already stopped.
 */
export type TakeoverDecision =
	| { kind: "none" }
	| { kind: "all" }
	| { kind: "apps"; names: ReadonlySet<string> };

export function initialTakeover(flag: boolean): TakeoverDecision {
	return flag ? { kind: "all" } : { kind: "none" };
}

/** Whether `app` is to be moved here from the run that has it. */
export function takesOver(decision: TakeoverDecision, app: string): boolean {
	return typedSwitch(decision, "kind", {
		none: () => false,
		all: () => true,
		apps: ({ names }) => names.has(app),
	});
}

/** `decision` with `names` accepted too. */
export function acceptTakeover(
	decision: TakeoverDecision,
	names: readonly string[],
): TakeoverDecision {
	return typedSwitch(decision, "kind", {
		none: (): TakeoverDecision => ({ kind: "apps", names: new Set(names) }),
		all: (): TakeoverDecision => decision,
		apps: ({ names: accepted }): TakeoverDecision => ({
			kind: "apps",
			names: new Set([...accepted, ...names]),
		}),
	});
}

/**
 * Whether to ask about taking over the selected apps when every one already
 * runs elsewhere. Not when `--takeover` already did, when the run has
 * something of its own to keep open (tunnels to open, frp sharing), or when
 * it inherited public URLs from the run it would stop: those tunnels end with
 * that run, and this one would advertise their dead URLs.
 */
export function shouldOfferTakeover(input: {
	decision: TakeoverDecision;
	nothingToSpawn: boolean;
	candidates: number;
	pendingTunnels: boolean;
	inheritsPublicUrls: boolean;
	sharing: boolean;
}): boolean {
	const ownWork = input.pendingTunnels || input.sharing;
	return (
		input.decision.kind !== "all" &&
		input.nothingToSpawn &&
		input.candidates > 0 &&
		!ownWork &&
		!input.inheritsPublicUrls
	);
}
