/**
 * Loopback URLs in a checkout's environment that point at another
 * checkout's ports.
 *
 * A `.env.local` shared through `buncargo files` carries whichever worktree's
 * ports saved it. When the project lets that file win over buncargo's own
 * value, every other worktree connects to a port nothing serves, with no
 * warning: an app fails later, on a refused connection.
 */

import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parseEnv } from "node:util";
import { PORT_OFFSET_STEP } from "./port-allocation";

const LOOPBACK_URL =
	/^[a-z][a-z0-9+.-]*:\/\/(?:[^@/\s]*@)?(?:localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0):(\d{1,5})(?=[/?#]|$)/i;

/** The explicit port of a loopback URL, or undefined for anything else. */
export function loopbackUrlPort(value: string): number | undefined {
	const match = LOOPBACK_URL.exec(value.trim());
	return match ? Number(match[1]) : undefined;
}

export interface StrayLoopbackUrl {
	key: string;
	/** Where the value came from: a file path, `buncargo env set`, or the injected environment. */
	source: string;
	url: string;
	port: number;
	/** Something answers there: another checkout's service, by the port's shape. */
	listening: boolean;
	/** The port of this checkout's block it most likely meant: same base port, other offset. */
	meant?: { name: string; port: number; url: string };
}

/**
 * Loopback URLs whose port is outside this checkout's block: nothing
 * listening there, or another checkout's port of the same service, which
 * this checkout would silently share. A source earlier in the list owns a
 * key, whatever its value: list overrides, then files, then the
 * environment they feed.
 */
export function findStrayLoopbackUrls(input: {
	sources: readonly {
		source: string;
		values: Readonly<Record<string, string>>;
	}[];
	ports: Readonly<Record<string, number>>;
	isListening: (port: number) => boolean;
}): StrayLoopbackUrl[] {
	const block = new Set(Object.values(input.ports));
	const seen = new Set<string>();
	const stray: StrayLoopbackUrl[] = [];
	for (const { source, values } of input.sources)
		for (const [key, url] of Object.entries(values)) {
			if (seen.has(key)) continue;
			seen.add(key);
			const port = loopbackUrlPort(url);
			if (port === undefined || block.has(port)) continue;
			const meant = Object.entries(input.ports).find(
				([, own]) => (port - own) % PORT_OFFSET_STEP === 0,
			);
			const listening = input.isListening(port);
			// A listener on an unrelated port is a service on purpose.
			if (listening && !meant) continue;
			const fixed = meant && {
				name: meant[0],
				port: meant[1],
				url: url.replace(`:${port}`, `:${meant[1]}`),
			};
			stray.push({
				key,
				source,
				url,
				port,
				listening,
				...(fixed ? { meant: fixed } : {}),
			});
		}
	return stray;
}

export function describeStrayLoopbackUrl(stray: StrayLoopbackUrl): string {
	const where = `${stray.key} (${stray.source}) is ${stray.url}`;
	if (!stray.meant)
		return `${where}, but nothing listens on ${stray.port} and it is not one of this checkout's ports. Point it at this checkout, or override it here: \`buncargo env set ${stray.key}=<url>\`.`;
	const { name, port, url } = stray.meant;
	const why = stray.listening
		? `${stray.port} is another checkout's ${name}, which this checkout would share`
		: `nothing listens on ${stray.port}, another checkout's ${name} port`;
	return `${where}, but ${why}; this checkout's ${name} is ${port}. Fix the file, or override it for this checkout: \`buncargo env set ${stray.key}=${url}\`.`;
}

/** Checkout files that hold dotenv lines: `.env`, `.env.local`, `apps/api/.env.development`. */
export function isDotenvPath(path: string): boolean {
	return basename(path).startsWith(".env");
}

/** A dotenv checkout file's values, or none when it is missing or unreadable. */
export function readDotenvFile(
	root: string,
	path: string,
): Record<string, string> {
	try {
		return parseEnv(readFileSync(join(root, path), "utf8")) as Record<
			string,
			string
		>;
	} catch {
		return {};
	}
}
