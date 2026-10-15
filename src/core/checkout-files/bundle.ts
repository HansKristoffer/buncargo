import { checkoutPathError } from "./spec";
import {
	MAX_FILE_BYTES,
	type Manifest,
	readManifest,
	readStoreData,
	sha256,
	withStoreLock,
	writeStoreEntries,
} from "./store";

/**
 * A file store as one JSON document, for moving it between machines without
 * agentgate: `buncargo files export | ssh box 'cd app && buncargo files import'`.
 */

const BUNDLE_KIND = "buncargo-checkout-files";
const BUNDLE_VERSION = 1;

interface BundleFile {
	path: string;
	sha256: string;
	updatedAt: string;
	machine: boolean;
	/** The exact bytes, base64. */
	data: string;
}

export interface Bundle {
	kind: typeof BUNDLE_KIND;
	version: typeof BUNDLE_VERSION;
	repoKey: string;
	files: BundleFile[];
}

function readStore(dir: string): Manifest {
	const read = readManifest(dir);
	if (read.kind === "unusable")
		throw new Error(`Left the file store ${dir} alone: ${read.reason}.`);
	return read.kind === "ok" ? read.manifest : { version: 1, files: {} };
}

/** Every entry of a store; `machine` ones only when asked. */
export async function exportBundle(
	dir: string,
	repoKey: string,
	options: { includeMachine?: boolean } = {},
): Promise<Bundle> {
	return withStoreLock(dir, () => {
		const files: BundleFile[] = [];
		for (const [path, entry] of Object.entries(readStore(dir).files).sort()) {
			if (entry.machine && !options.includeMachine) continue;
			const data = readStoreData(dir, path, entry);
			if (!data) continue;
			files.push({
				path,
				sha256: entry.sha256,
				updatedAt: entry.updatedAt,
				machine: entry.machine,
				data: data.toString("base64"),
			});
		}
		return { kind: BUNDLE_KIND, version: BUNDLE_VERSION, repoKey, files };
	});
}

/** A bundle's text, validated down to each file's hash. Throws naming the problem. */
export function parseBundle(text: string): Bundle {
	let value: Partial<Bundle>;
	try {
		value = JSON.parse(text);
	} catch {
		throw new Error("The input is not a checkout files bundle (not JSON).");
	}
	if (value?.kind !== BUNDLE_KIND)
		throw new Error(
			"The input is not a checkout files bundle. Make one with `buncargo files export`.",
		);
	if (value.version !== BUNDLE_VERSION)
		throw new Error(
			`The bundle has version ${JSON.stringify(value.version)}, this buncargo reads ${BUNDLE_VERSION}. Update buncargo.`,
		);
	if (typeof value.repoKey !== "string" || !Array.isArray(value.files))
		throw new Error("The bundle has no repoKey or files.");
	for (const file of value.files) {
		const pathError =
			typeof file?.path === "string"
				? checkoutPathError(file.path)
				: "is not a path";
		if (pathError)
			throw new Error(
				`Bundle entry ${JSON.stringify(file?.path)} ${pathError}.`,
			);
		if (
			typeof file.data !== "string" ||
			typeof file.updatedAt !== "string" ||
			typeof file.machine !== "boolean"
		)
			throw new Error(`Bundle entry ${file.path} is incomplete.`);
		const data = Buffer.from(file.data, "base64");
		if (data.length > MAX_FILE_BYTES)
			throw new Error(`Bundle entry ${file.path} is larger than 1 MiB.`);
		if (sha256(data) !== file.sha256)
			throw new Error(
				`Bundle entry ${file.path} does not match its sha256; the bundle is damaged.`,
			);
	}
	return value as Bundle;
}

/** Write a bundle's files into a store, keeping their `updatedAt`. */
export async function importBundle(dir: string, bundle: Bundle): Promise<void> {
	await withStoreLock(dir, () => {
		writeStoreEntries(
			dir,
			readStore(dir),
			bundle.files.map((file) => ({
				path: file.path,
				data: Buffer.from(file.data, "base64"),
				machine: file.machine,
				updatedAt: file.updatedAt,
			})),
		);
	});
}
