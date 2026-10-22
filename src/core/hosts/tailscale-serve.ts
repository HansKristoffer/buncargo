/**
 * Named hosts through Tailscale Serve (`BUNCARGO_HOSTS=tailscale`): each app
 * on its own HTTPS port of this machine's MagicDNS name, with the certificate
 * Tailscale issues for it. For a remote machine, where `*.localhost` resolves
 * to whoever is looking.
 *
 * The owner of `~/.buncargo/tailscale-serve.json`: every entry buncargo
 * added, with the run that owns it. Serve entries are machine state that
 * outlives the run (`--bg` survives a reboot), and the machine may carry
 * serve config of its own, so nothing here touches an entry that file does
 * not name, or one whose live config no longer matches what was recorded.
 */

import { connect } from "node:tls";
import { getErrorMessage, promiseTimeout } from "hanzio";
import { withFileLock } from "../file-lock";
import { isProcessAlive } from "../process/lifecycle";
import { defineListRegistry, readJsonDocumentSync } from "../registry-file";
import type { HostsMode } from "../runtime-flags";
import { chownToInvokingUser } from "../state-paths";
import { getTailscaleServePath } from "./paths";
import {
	describeServePermission,
	failureLine,
	isPermissionDenied,
	readServeConfig,
	readTailscaleSelf,
	runCli,
	runServeChange,
	type ServeConfig,
	type ServedPort,
	type TailscaleCli,
	tailscaleCli,
} from "./tailscale-cli";

// ═══════════════════════════════════════════════════════════════════════════
// Ports
// ═══════════════════════════════════════════════════════════════════════════

/**
 * An app's HTTPS port is its own port plus this.
 *
 * It cannot be the app's port: the app listens on `*:<port>`, and Tailscale
 * binds the tailnet address on the HTTPS port, which the wildcard already
 * holds. A fixed shift keeps the HTTPS port a pure function of the app port,
 * so the allocator can claim it with the block before any run serves it, and
 * no other checkout's port lands on it. 20000 puts the usual dev ports
 * (3000-9000, plus an offset of up to 11000) clear of the range other
 * checkouts' ports occupy.
 */
export const TAILSCALE_HTTPS_PORT_SHIFT = 20_000;

/** The HTTPS port Tailscale serves `appPort` on, or undefined above 65535. */
export function tailscaleHttpsPort(appPort: number): number | undefined {
	const port = appPort + TAILSCALE_HTTPS_PORT_SHIFT;
	return port <= 65535 ? port : undefined;
}

/**
 * The HTTPS ports a block also holds in tailscale mode, for the allocator to
 * claim with it; undefined outside that mode or without named hosts.
 *
 * Claimed but never probed: Tailscale's listener on a port this checkout
 * already serves fails the allocator's bind probe, which would read the
 * checkout's own entry as a stranger and move its whole block.
 */
export function tailscaleBlockPorts(input: {
	mode: HostsMode;
	hosts: boolean;
	appNames: readonly string[];
}): ((ports: Record<string, number>) => number[]) | undefined {
	if (!input.hosts || input.mode !== "tailscale") return undefined;
	return (ports) =>
		input.appNames.flatMap((name) => {
			const port = ports[name];
			const https = port === undefined ? undefined : tailscaleHttpsPort(port);
			return https === undefined ? [] : [https];
		});
}

// ═══════════════════════════════════════════════════════════════════════════
// The record of what buncargo added
// ═══════════════════════════════════════════════════════════════════════════

/** One serve entry buncargo added, and the run that owns it. */
export interface TailscaleServeEntry {
	root: string;
	app: string;
	/** The run that owns the entry; its exit removes it. */
	pid: number;
	httpsPort: number;
	/** `http://127.0.0.1:<app port>`. */
	target: string;
	/** The MagicDNS name, without the trailing dot. */
	hostname: string;
	/** When this run's probe was first answered through it. Readers advertise only these. */
	servedAt?: string;
}

function isServeEntry(value: unknown): value is TailscaleServeEntry {
	if (typeof value !== "object" || value === null) return false;
	const entry = value as Partial<TailscaleServeEntry>;
	return (
		typeof entry.root === "string" &&
		typeof entry.app === "string" &&
		typeof entry.pid === "number" &&
		typeof entry.httpsPort === "number" &&
		typeof entry.target === "string" &&
		typeof entry.hostname === "string" &&
		(entry.servedAt === undefined || typeof entry.servedAt === "string")
	);
}

const REGISTRY_VERSION = 1;

const registry = defineListRegistry<TailscaleServeEntry>({
	version: REGISTRY_VERSION,
	key: "entries",
	isEntry: isServeEntry,
	afterWrite: chownToInvokingUser,
});

/**
 * How long a run waits for another to finish changing Serve. Longer than the
 * default: the holder runs `tailscale serve` once per app, and a slow
 * `tailscaled` makes that seconds rather than milliseconds.
 */
const SERVE_LOCK_TIMEOUT_MS = 30_000;

function withServeLock<T>(operation: () => Promise<T>): Promise<T> {
	return withFileLock(getTailscaleServePath(), operation, {
		timeoutMs: SERVE_LOCK_TIMEOUT_MS,
	});
}

export function loadTailscaleServeEntries(): Promise<TailscaleServeEntry[]> {
	return registry.read(getTailscaleServePath());
}

export function tailscaleServeUrl(entry: {
	hostname: string;
	httpsPort: number;
}): string {
	return `https://${entry.hostname}:${entry.httpsPort}`;
}

export function serveTarget(appPort: number): string {
	return `http://127.0.0.1:${appPort}`;
}

function matchesConfig(
	entry: TailscaleServeEntry,
	served: ServedPort | undefined,
): boolean {
	return (
		served !== undefined &&
		served !== "other" &&
		served.hostname === entry.hostname &&
		served.target === entry.target
	);
}

/** The same entry: one app of one checkout, on one port, to one target. */
function sameEntry(a: TailscaleServeEntry, b: TailscaleServeEntry): boolean {
	return (
		a.root === b.root &&
		a.app === b.app &&
		a.httpsPort === b.httpsPort &&
		a.target === b.target
	);
}

/**
 * The served URLs of `root`'s live run, by app, as a reader without the run
 * sees them (`buncargo env`, `status`, `getEnvVar`): entries Tailscale was
 * seen answering, for the port each app has now.
 */
export function servedTailscaleUrls(
	entries: readonly TailscaleServeEntry[],
	input: {
		root: string;
		ports: Readonly<Record<string, number>>;
		isAlive: (pid: number) => boolean;
	},
): Record<string, string> {
	const urls: Record<string, string> = {};
	for (const entry of entries) {
		const port = input.ports[entry.app];
		const current =
			entry.root === input.root &&
			entry.servedAt !== undefined &&
			port !== undefined &&
			entry.target === serveTarget(port);
		if (current && input.isAlive(entry.pid))
			urls[entry.app] = tailscaleServeUrl(entry);
	}
	return urls;
}

export async function readServedTailscaleUrls(
	root: string,
	ports: Readonly<Record<string, number>>,
): Promise<Record<string, string>> {
	return servedTailscaleUrls(await loadTailscaleServeEntries(), {
		root,
		ports,
		isAlive: isProcessAlive,
	});
}

/** {@link readServedTailscaleUrls} for `getEnvVar`, which is synchronous. */
export function readServedTailscaleUrlsSync(
	root: string,
	ports: Readonly<Record<string, number>>,
): Record<string, string> {
	const entries =
		readJsonDocumentSync(getTailscaleServePath(), (value) => {
			const file = value as { version?: unknown; entries?: unknown };
			return file?.version === REGISTRY_VERSION && Array.isArray(file.entries)
				? file.entries.filter(isServeEntry)
				: undefined;
		}) ?? [];
	return servedTailscaleUrls(entries, { root, ports, isAlive: isProcessAlive });
}

// ═══════════════════════════════════════════════════════════════════════════
// Deciding what to change
// ═══════════════════════════════════════════════════════════════════════════

/** An app this run wants served. */
export interface ServeWant {
	app: string;
	httpsPort: number;
	target: string;
}

export interface ServePlan {
	/** The record once every command below has succeeded. */
	records: TailscaleServeEntry[];
	/** Entries to add with `tailscale serve --bg`. */
	register: TailscaleServeEntry[];
	/** Recorded entries to take out with `tailscale serve --https=<port> off`. */
	off: TailscaleServeEntry[];
	/** Wanted apps Tailscale already serves as recorded. */
	serving: TailscaleServeEntry[];
	/** Why a wanted app is not served at all. */
	refused: string[];
}

/**
 * Whether a recorded entry that has to go is still there to take out:
 * `"off"` when the live config is exactly what was recorded, `"forget"` when
 * it is gone or has changed, which makes it someone else's.
 */
export function decideRemoval(
	entry: TailscaleServeEntry,
	config: ServeConfig,
): "off" | "forget" {
	return matchesConfig(entry, config.get(entry.httpsPort)) ? "off" : "forget";
}

function wantedAs(entry: TailscaleServeEntry, want: ServeWant): boolean {
	return (
		entry.app === want.app &&
		entry.httpsPort === want.httpsPort &&
		entry.target === want.target
	);
}

/**
 * What a run's activation changes, from the record, the live config and the
 * apps it wants served. Pure: every ownership rule is tested here.
 *
 * - An entry whose run has ended goes, from any checkout, unless it is exactly
 *   what this run wants: then this run adopts it (a run that crashed and was
 *   started again), with no command at all, and probes it afresh.
 * - A wanted app another live run of this checkout already serves keeps that
 *   owner, as a second `buncargo dev` reusing its servers does with named
 *   routes; `takeover` moves it to this run, whose exit must then remove it.
 * - This run's own entry for an app that is now on another port goes.
 * - A port whose live config buncargo did not record is never touched.
 */
export function planServeChanges(input: {
	entries: readonly TailscaleServeEntry[];
	config: ServeConfig;
	root: string;
	pid: number;
	hostname: string;
	wants: readonly ServeWant[];
	takeover: ReadonlySet<string>;
	isAlive: (pid: number) => boolean;
}): ServePlan {
	const { root, pid, hostname, config } = input;
	const wantByApp = new Map(input.wants.map((want) => [want.app, want]));
	const records: TailscaleServeEntry[] = [];
	const off: TailscaleServeEntry[] = [];
	const serving: TailscaleServeEntry[] = [];
	const register: TailscaleServeEntry[] = [];
	const refused: string[] = [];
	const handled = new Set<string>();

	for (const entry of input.entries) {
		const want = root === entry.root ? wantByApp.get(entry.app) : undefined;
		const wanted =
			want !== undefined &&
			!handled.has(want.app) &&
			entry.hostname === hostname &&
			wantedAs(entry, want);
		const alive = input.isAlive(entry.pid);

		if (!wanted) {
			// Dead, or this run's own entry for a port the app no longer has.
			const stale = !alive || (want !== undefined && entry.pid === pid);
			if (stale) {
				if (decideRemoval(entry, config) === "off") off.push(entry);
			} else records.push(entry);
			continue;
		}

		handled.add(want.app);
		const takenOver = input.takeover.has(entry.app);
		const owner = !alive || entry.pid === pid || takenOver ? pid : entry.pid;
		// What answered for a run that ended says nothing about this one.
		const servedAt = alive ? entry.servedAt : undefined;
		const kept = { ...entry, pid: owner, servedAt };
		const served = config.get(entry.httpsPort);
		if (matchesConfig(entry, served)) {
			records.push(kept);
			serving.push(kept);
		} else if (served === undefined) {
			// Recorded but gone from Tailscale (a `tailscale serve reset`): add it again.
			const again = { ...kept, servedAt: undefined };
			register.push(again);
			records.push(again);
		} else {
			// Changed outside buncargo: someone else's now. Forget it, touch nothing.
			refused.push(unrecordedPortMessage(want, hostname));
		}
	}

	// Ports whose recorded entry is about to come out are free once it has.
	const freed = new Set(off.map((entry) => entry.httpsPort));
	for (const want of input.wants) {
		if (handled.has(want.app)) continue;
		const holder = records.find((entry) => entry.httpsPort === want.httpsPort);
		if (holder) {
			refused.push(recordedPortMessage(want, holder));
			continue;
		}
		if (config.has(want.httpsPort) && !freed.has(want.httpsPort)) {
			refused.push(unrecordedPortMessage(want, hostname));
			continue;
		}
		const entry: TailscaleServeEntry = {
			root,
			app: want.app,
			pid,
			httpsPort: want.httpsPort,
			target: want.target,
			hostname,
		};
		register.push(entry);
		records.push(entry);
	}

	return { records, register, off, serving, refused };
}

function unrecordedPortMessage(want: ServeWant, hostname: string): string {
	const url = tailscaleServeUrl({ hostname, httpsPort: want.httpsPort });
	return `${want.app} is not served at ${url}: Tailscale Serve already has an entry on port ${want.httpsPort} that buncargo did not add. If it is stale, remove it with \`tailscale serve --https=${want.httpsPort} off\` and restart the run.`;
}

function recordedPortMessage(
	want: ServeWant,
	holder: TailscaleServeEntry,
): string {
	const url = tailscaleServeUrl(holder);
	return `${want.app} is not served on port ${want.httpsPort}: ${url} serves ${holder.app} of ${holder.root} for run pid ${holder.pid}. Stop that run (\`buncargo stop --all\` in ${holder.root}) and restart this one.`;
}

// ═══════════════════════════════════════════════════════════════════════════
// Running the commands
// ═══════════════════════════════════════════════════════════════════════════

/** Where a probe connects: the machine's Tailscale address, asking for the name. */
export interface ServeProbeTarget {
	hostname: string;
	address: string;
	httpsPort: number;
}

/** What touches the world, injected so tests never run the real `tailscale`. */
export interface TailscaleServeDeps {
	cli: TailscaleCli;
	/**
	 * Undefined once a TLS handshake for the entry's name succeeds on its
	 * port, the reason otherwise. Only Tailscale holds that name's
	 * certificate, so the handshake proves Tailscale is listening there.
	 */
	probe: (target: ServeProbeTarget) => Promise<string | undefined>;
	isAlive: (pid: number) => boolean;
}

/** Until the listener is up, connections are refused: retry them this long. */
const PROBE_REFUSED_MS = 3000;
/** A first handshake can wait on Tailscale fetching the certificate. */
const PROBE_HANDSHAKE_MS = 15_000;
const PROBE_RETRY_MS = 100;

/**
 * One TLS handshake to the Tailscale address with the MagicDNS name as SNI.
 * By address rather than by name: a server started with
 * `--accept-dns=false` cannot resolve its own MagicDNS name, while the other
 * machines of the tailnet can.
 */
function handshake(target: ServeProbeTarget): Promise<string | undefined> {
	return new Promise((resolve) => {
		const socket = connect({
			host: target.address,
			port: target.httpsPort,
			servername: target.hostname,
		});
		const timer = setTimeout(() => {
			socket.destroy();
			resolve("no TLS handshake within 15s");
		}, PROBE_HANDSHAKE_MS);
		socket.once("secureConnect", () => {
			clearTimeout(timer);
			socket.destroy();
			resolve(undefined);
		});
		socket.once("error", (error: NodeJS.ErrnoException) => {
			clearTimeout(timer);
			resolve(error.code ?? error.message);
		});
	});
}

async function probeTls(target: ServeProbeTarget): Promise<string | undefined> {
	const deadline = performance.now() + PROBE_REFUSED_MS;
	for (;;) {
		const reason = await handshake(target);
		const refused = reason === "ECONNREFUSED";
		if (!refused || performance.now() > deadline) return reason;
		await promiseTimeout(PROBE_RETRY_MS);
	}
}

/** The real seams: the `tailscale` CLI, TLS handshakes and `kill(pid, 0)`. */
export function tailscaleServeDeps(): TailscaleServeDeps {
	return { cli: tailscaleCli, probe: probeTls, isAlive: isProcessAlive };
}

/** Undefined once the entry is gone, the reason it is still there otherwise. */
async function takeOut(
	cli: TailscaleCli,
	entry: TailscaleServeEntry,
): Promise<string | undefined> {
	const result = await runServeChange(cli, [
		"serve",
		`--https=${entry.httpsPort}`,
		"off",
	]);
	if (result.exitCode === 0) return undefined;
	if (/does not exist|not found/i.test(`${result.stderr}\n${result.stdout}`))
		return undefined;
	return `Could not remove ${tailscaleServeUrl(entry)} (${entry.app}, ${entry.root}) from Tailscale Serve: ${failureLine(result)}. Remove it with \`tailscale serve --https=${entry.httpsPort} off\`.`;
}

/** Take `entries` out, one at a time; those that could not be stay recorded. */
async function takeOutAll(
	cli: TailscaleCli,
	entries: readonly TailscaleServeEntry[],
): Promise<{ kept: TailscaleServeEntry[]; failures: string[] }> {
	const kept: TailscaleServeEntry[] = [];
	const failures: string[] = [];
	for (const entry of entries) {
		const failure = await takeOut(cli, entry);
		if (!failure) continue;
		kept.push(entry);
		failures.push(failure);
	}
	return { kept, failures };
}

/**
 * Add `entries`, one at a time. A refusal on permission stops the rest: each
 * would be refused the same way, and one message names them all.
 */
async function registerAll(
	cli: TailscaleCli,
	entries: readonly TailscaleServeEntry[],
): Promise<{ added: TailscaleServeEntry[]; refused: string[] }> {
	const added: TailscaleServeEntry[] = [];
	const refused: string[] = [];
	for (const [index, entry] of entries.entries()) {
		const result = await runServeChange(cli, [
			"serve",
			"--bg",
			`--https=${entry.httpsPort}`,
			entry.target,
		]);
		if (result.exitCode === 0) {
			added.push(entry);
			continue;
		}
		if (isPermissionDenied(result)) {
			const apps = entries
				.slice(index)
				.map((item) => item.app)
				.join(", ");
			refused.push(
				`Tailscale did not let this user serve ${apps} (${failureLine(result)}). Allow it once with \`sudo tailscale set --operator=$USER\`.`,
			);
			break;
		}
		refused.push(
			`Tailscale did not serve ${entry.app} on port ${entry.httpsPort}: ${failureLine(result)}. \`buncargo doctor\` checks what Tailscale Serve needs.`,
		);
	}
	return { added, refused };
}

// ═══════════════════════════════════════════════════════════════════════════
// Activation, release and the sweep
// ═══════════════════════════════════════════════════════════════════════════

export interface TailscaleServeApp {
	name: string;
	port: number;
}

export interface TailscaleActivation {
	/** Each app Tailscale answered for, by name: `https://<machine>:<port>`. */
	urls: Record<string, string>;
	/** Why an app, or every app, keeps its plain URL. */
	fallbacks: string[];
	/** Worth saying, but nothing fell back (a stale entry that would not come out). */
	notes: string[];
}

/**
 * Serve this run's apps through Tailscale and say which ones answered.
 *
 * Every Tailscale problem (no `tailscale`, not logged in, no permission, no
 * HTTPS certificates) is a fallback, never a throw: the app keeps its current
 * URL. Changes run one at a time under the record's lock, with the Serve
 * config read under it too; `tailscale status` runs beside the lock wait, and
 * the probes run together after it.
 */
export async function activateTailscaleServe(
	input: {
		root: string;
		pid: number;
		apps: readonly TailscaleServeApp[];
		/** Every port of the block: an HTTPS port landing on one is skipped. */
		blockPorts: readonly number[];
		takeover: ReadonlySet<string>;
	},
	deps: TailscaleServeDeps,
): Promise<TailscaleActivation> {
	const fallbacks: string[] = [];
	const notes: string[] = [];
	const blockPorts = new Set(input.blockPorts);
	const wants: ServeWant[] = [];
	for (const app of input.apps) {
		const httpsPort = tailscaleHttpsPort(app.port);
		if (httpsPort === undefined || blockPorts.has(httpsPort)) {
			const why =
				httpsPort === undefined
					? `${app.port} + ${TAILSCALE_HTTPS_PORT_SHIFT} is above 65535`
					: `port ${httpsPort} is another port of this checkout`;
			fallbacks.push(
				`${app.name} is not served through Tailscale: its HTTPS port would be its port plus ${TAILSCALE_HTTPS_PORT_SHIFT}, and ${why}. Give it a lower port in dev.config.ts.`,
			);
			continue;
		}
		wants.push({ app: app.name, httpsPort, target: serveTarget(app.port) });
	}
	if (wants.length === 0) return { urls: {}, fallbacks, notes };

	const selfRead = readTailscaleSelf(deps.cli);
	type Applied =
		| { unavailable: string }
		| { address: string; serving: TailscaleServeEntry[] };
	const applied = await withServeLock(async (): Promise<Applied> => {
		const [self, read] = await Promise.all([
			selfRead,
			readServeConfig(deps.cli),
		]);
		if (!self.ok) return { unavailable: self.reason };
		if ("reason" in read) return { unavailable: `${read.reason}.` };

		const path = getTailscaleServePath();
		const plan = planServeChanges({
			entries: await registry.read(path),
			config: read.config,
			root: input.root,
			pid: input.pid,
			hostname: self.hostname,
			wants,
			takeover: input.takeover,
			isAlive: deps.isAlive,
		});
		fallbacks.push(...plan.refused);
		// Recorded before any command runs: a crash from here on leaves a
		// record the sweep can act on, never an entry nobody knows about.
		await registry.write(path, [...plan.records, ...plan.off]);
		const removal = await takeOutAll(deps.cli, plan.off);
		notes.push(...removal.failures);
		const registration = await registerAll(deps.cli, plan.register);
		fallbacks.push(...registration.refused);
		// A refused change stays recorded: one that timed out may still have
		// applied, and removal checks the live config before it touches it.
		await registry.write(path, [...plan.records, ...removal.kept]);
		return {
			address: self.address,
			serving: [...plan.serving, ...registration.added],
		};
	});
	if ("unavailable" in applied)
		return { urls: {}, fallbacks: [...fallbacks, applied.unavailable], notes };

	const answered: TailscaleServeEntry[] = [];
	await Promise.all(
		applied.serving.map(async (entry) => {
			const reason = await deps.probe({
				hostname: entry.hostname,
				address: applied.address,
				httpsPort: entry.httpsPort,
			});
			if (reason === undefined) {
				answered.push(entry);
				return;
			}
			fallbacks.push(
				`${entry.app} is registered with Tailscale at ${tailscaleServeUrl(entry)}, but no TLS handshake succeeded there (${reason}). Check that nothing else listens on port ${entry.httpsPort} (\`buncargo doctor\`), then restart the run.`,
			);
		}),
	);
	await markServed(answered);

	const urls: Record<string, string> = {};
	for (const entry of answered) urls[entry.app] = tailscaleServeUrl(entry);
	return { urls, fallbacks, notes };
}

/** Stamp `servedAt` on the entries Tailscale answered for, so readers advertise them. */
async function markServed(
	answered: readonly TailscaleServeEntry[],
): Promise<void> {
	if (answered.length === 0) return;
	const now = new Date().toISOString();
	const path = getTailscaleServePath();
	await withServeLock(async () => {
		const entries = await registry.read(path);
		const stamp = (entry: TailscaleServeEntry) =>
			!entry.servedAt && answered.some((item) => sameEntry(item, entry));
		await registry.write(
			path,
			entries.map((entry) =>
				stamp(entry) ? { ...entry, servedAt: now } : entry,
			),
		);
	});
}

/**
 * Take out the entries `match` selects, and forget those Tailscale no longer
 * has as recorded. A first read without the lock answers the usual case,
 * nothing to do, with one file read and no lock.
 */
async function removeMatching(
	match: (entry: TailscaleServeEntry) => boolean,
	cli: TailscaleCli,
): Promise<{ removed: TailscaleServeEntry[]; failures: string[] }> {
	if (!(await loadTailscaleServeEntries()).some(match))
		return { removed: [], failures: [] };
	const path = getTailscaleServePath();
	return withServeLock(async () => {
		const entries = await registry.read(path);
		const doomed = entries.filter(match);
		if (doomed.length === 0) return { removed: [], failures: [] };
		const read = await readServeConfig(cli);
		if ("reason" in read)
			return {
				removed: [],
				failures: [
					`Tailscale Serve entries of ${describeOwners(doomed)} are still there: ${read.reason}; \`buncargo hosts prune\` tries again.`,
				],
			};
		const off = doomed.filter(
			(entry) => decideRemoval(entry, read.config) === "off",
		);
		const removal = await takeOutAll(cli, off);
		const stays = new Set(removal.kept);
		await registry.write(
			path,
			entries.filter((entry) => !doomed.includes(entry) || stays.has(entry)),
		);
		return {
			removed: doomed.filter((entry) => !stays.has(entry)),
			failures: removal.failures,
		};
	});
}

function describeOwners(entries: readonly TailscaleServeEntry[]): string {
	return [...new Set(entries.map((entry) => entry.root))].join(", ");
}

/** Take out the entries this run owns in `root`, as it ends. Warnings, never a throw. */
export async function releaseTailscaleServe(
	input: { root: string; pid: number },
	deps: Pick<TailscaleServeDeps, "cli">,
): Promise<string[]> {
	try {
		const result = await removeMatching(
			(entry) => entry.root === input.root && entry.pid === input.pid,
			deps.cli,
		);
		return result.failures;
	} catch (error) {
		return [
			`Could not release this run's Tailscale Serve entries (${getErrorMessage(error)}); \`buncargo hosts prune\` removes them once the run has ended.`,
		];
	}
}

export interface TailscaleServeSweep {
	removed: string[];
	failures: string[];
}

/**
 * Take out the entries whose run has ended (`--bg` entries otherwise outlive
 * it, a reboot included). The watchdog runs this every pass, `ls`, `doctor`
 * and `hosts prune` once; nothing to remove costs one file read.
 */
export async function sweepTailscaleServe(
	deps: Pick<TailscaleServeDeps, "cli" | "isAlive">,
): Promise<TailscaleServeSweep> {
	try {
		const result = await removeMatching(
			(entry) => !deps.isAlive(entry.pid),
			deps.cli,
		);
		return {
			removed: result.removed.map(
				(entry) =>
					`Removed ${tailscaleServeUrl(entry)} (${entry.app}, ${entry.root}) from Tailscale Serve: its run (pid ${entry.pid}) has ended`,
			),
			failures: result.failures,
		};
	} catch (error) {
		return {
			removed: [],
			failures: [
				`Could not sweep Tailscale Serve entries (${getErrorMessage(error)}); \`buncargo hosts prune\` tries again.`,
			],
		};
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// Diagnosis
// ═══════════════════════════════════════════════════════════════════════════

export interface TailscaleDiagnosis {
	notes: string[];
	issues: string[];
}

/**
 * What `doctor` says in tailscale mode: Tailscale up, HTTPS available, Serve
 * permitted, and every live entry buncargo recorded still in the config and
 * answering.
 */
export async function diagnoseTailscaleHosts(
	deps: TailscaleServeDeps,
	user: { name: string; uid: number; platform: NodeJS.Platform },
): Promise<TailscaleDiagnosis> {
	const notes: string[] = [
		"Named hosts are served through Tailscale (BUNCARGO_HOSTS=tailscale)",
	];
	const issues: string[] = [];

	const self = await readTailscaleSelf(deps.cli);
	if (!self.ok) {
		issues.push(`Tailscale: ${self.reason}`);
		return { notes, issues };
	}
	notes.push(`Tailscale is up as ${self.hostname}, with an HTTPS certificate`);

	const prefs =
		user.platform === "linux"
			? await runCli(deps.cli, ["debug", "prefs"])
			: undefined;
	const permission = describeServePermission(prefs, user);
	if (permission) (permission.ok ? notes : issues).push(permission.message);

	const read = await readServeConfig(deps.cli);
	if ("reason" in read) {
		issues.push(`Tailscale: ${read.reason}`);
		return { notes, issues };
	}
	const live = (await loadTailscaleServeEntries()).filter((entry) =>
		deps.isAlive(entry.pid),
	);
	const count = live.length === 1 ? "1 entry" : `${live.length} entries`;
	notes.push(`Tailscale Serve: ${count} recorded by buncargo`);
	for (const entry of live) {
		const url = tailscaleServeUrl(entry);
		if (!matchesConfig(entry, read.config.get(entry.httpsPort))) {
			issues.push(
				`Tailscale is not serving ${url} (${entry.app}, ${entry.root}), which run pid ${entry.pid} added. Restart that run.`,
			);
			continue;
		}
		const reason = await deps.probe({
			hostname: entry.hostname,
			address: self.address,
			httpsPort: entry.httpsPort,
		});
		if (reason)
			issues.push(
				`${url} (${entry.app}, ${entry.root}) is in the Tailscale Serve config but no TLS handshake succeeds there (${reason}). Check what else listens on port ${entry.httpsPort}: \`lsof -nP -iTCP:${entry.httpsPort}\`.`,
			);
	}
	return { notes, issues };
}

/** Each recorded entry with whether Tailscale still serves it, for `hosts status`. */
export async function describeTailscaleServeEntries(
	deps: Pick<TailscaleServeDeps, "cli" | "isAlive">,
): Promise<string[]> {
	const entries = await loadTailscaleServeEntries();
	if (entries.length === 0) return [];
	const read = await readServeConfig(deps.cli);
	const missing = (entry: TailscaleServeEntry) =>
		!("reason" in read) &&
		!matchesConfig(entry, read.config.get(entry.httpsPort));
	return entries.map((entry) => {
		const ended = deps.isAlive(entry.pid) ? "" : ", ended";
		const state = missing(entry) ? "  ← not in the Tailscale Serve config" : "";
		return `${tailscaleServeUrl(entry)} → ${entry.target}  (app:${entry.app}, ${entry.root}, pid ${entry.pid}${ended})${state}`;
	});
}
