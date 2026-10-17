import { parseEnv } from "node:util";

/**
 * A three-way, key-by-key merge of dotenv files (`buncargo files merge`).
 *
 * A key changed on one side only takes that change; a key changed on both,
 * differently, is a conflict the caller resolves per key. The checkout's copy
 * is the skeleton, so its comments, order and quoting stay as written; a key
 * taken from the store brings the store's line(s) with it. Errors and
 * conflicts name keys, never values.
 */

export type MergeSide = "checkout" | "store";

export class DotenvMergeError extends Error {}

interface Entry {
	/** The raw line(s), with their line endings. */
	text: string;
	key?: string;
}

const ASSIGNMENT = /^\s*(?:export\s+)?([A-Za-z_][\w.-]*)\s*=\s*(.*)$/;
const QUOTES = new Set(['"', "'", "`"]);

/** Lines grouped into assignments (a quoted value may span lines) and the rest. */
function entries(text: string, label: string): Entry[] {
	const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
	const result: Entry[] = [];
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index] ?? "";
		const content = line.replace(/\r?\n$/, "");
		if (/^\s*(#.*)?$/.test(content)) {
			result.push({ text: line });
			continue;
		}
		const match = ASSIGNMENT.exec(content);
		if (!match)
			throw new DotenvMergeError(
				`${label} line ${index + 1} is not KEY=value, a comment or blank, so it cannot be merged key by key.`,
			);
		const key = match[1] ?? "";
		const value = match[2] ?? "";
		let end = index;
		// Like Node's parser: a quote not closed on its line closes on a later one.
		const quote = value[0] ?? "";
		if (QUOTES.has(quote) && !value.slice(1).includes(quote)) {
			const close = lines.findIndex(
				(later, at) => at > index && later.includes(quote),
			);
			if (close !== -1) end = close;
		}
		result.push({ key, text: lines.slice(index, end + 1).join("") });
		index = end;
	}

	const keys = result.flatMap((entry) => (entry.key ? [entry.key] : []));
	const duplicate = keys.find((key, at) => keys.indexOf(key) !== at);
	if (duplicate)
		throw new DotenvMergeError(
			`${label} sets ${duplicate} more than once; remove one and merge again.`,
		);
	const parsed = Object.keys(parseEnv(text)).sort();
	if (parsed.join("\n") !== [...keys].sort().join("\n"))
		throw new DotenvMergeError(
			`${label} could not be read key by key, so it cannot be merged.`,
		);
	return result;
}

function valuesOf(list: readonly Entry[]): Map<string, string | undefined> {
	return new Map(
		list.flatMap((entry) =>
			entry.key ? [[entry.key, parseEnv(entry.text)[entry.key]]] : [],
		),
	);
}

function isComment(entry: Entry | undefined): entry is Entry {
	return entry !== undefined && !entry.key && entry.text.trim().startsWith("#");
}

/**
 * Merge `checkout` and `store` from their common `base` ("" when unknown, so
 * every difference is an addition or a conflict). `take` resolves conflicts.
 *
 * Returns the merged text, or the conflicting keys `take` left open.
 */
export function mergeDotenv(
	base: string,
	checkout: string,
	store: string,
	take: ReadonlyMap<string, MergeSide> = new Map(),
): { text: string; conflicts: [] } | { text?: undefined; conflicts: string[] } {
	const baseValues = valuesOf(entries(base, "The last synced copy"));
	const mineEntries = entries(checkout, "The checkout's copy");
	const theirEntries = entries(store, "The file store's copy");
	const mine = valuesOf(mineEntries);
	const theirs = valuesOf(theirEntries);

	const fromStore = new Set<string>();
	const conflicts: string[] = [];
	for (const key of new Set([...mine.keys(), ...theirs.keys()])) {
		const local = mine.get(key);
		const stored = theirs.get(key);
		const was = baseValues.get(key);
		if (local === stored || stored === was) continue;
		if (local === was) {
			fromStore.add(key);
			continue;
		}
		const side = take.get(key);
		if (side === "store") fromStore.add(key);
		else if (side !== "checkout") conflicts.push(key);
	}
	if (conflicts.length > 0) return { conflicts: conflicts.sort() };

	// The checkout's lines, with the store's for every key taken from it.
	const theirByKey = new Map(
		theirEntries.flatMap((entry) => (entry.key ? [[entry.key, entry]] : [])),
	);
	const output: Entry[] = mineEntries.flatMap((entry) => {
		if (!entry.key || !fromStore.has(entry.key)) return [entry];
		const replacement = theirByKey.get(entry.key);
		return replacement ? [replacement] : [];
	});

	// Keys only the store has go after the key they follow there, with the
	// comment lines right above them.
	const mineText = new Set(mineEntries.map((entry) => entry.text));
	let anchor = output.findIndex((entry) => entry.key);
	if (anchor === -1) anchor = output.length;
	theirEntries.forEach((entry, at) => {
		if (!entry.key) return;
		const existing = output.findIndex((line) => line.key === entry.key);
		if (existing !== -1) {
			anchor = existing + 1;
			return;
		}
		if (!fromStore.has(entry.key)) return;
		let first = at;
		while (isComment(theirEntries[first - 1])) first--;
		const added = [
			...theirEntries
				.slice(first, at)
				.filter((comment) => !mineText.has(comment.text)),
			entry,
		];
		output.splice(anchor, 0, ...added);
		anchor += added.length;
	});

	const text = output
		.map((entry, at) =>
			at < output.length - 1 && !entry.text.endsWith("\n")
				? `${entry.text}\n`
				: entry.text,
		)
		.join("");
	return { text, conflicts: [] };
}
