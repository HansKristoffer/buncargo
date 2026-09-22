import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import type { Endpoint } from "@number0/iroh";
import { connectRelays, connectRelayToken } from "../runtime-flags";

type IrohModule = typeof import("@number0/iroh");

/** The addon a coordinator bundle carries beside itself, under the bundle's own hash. */
export function addonPathFor(bundle: string): string {
	return bundle.replace(/\.js$/, ".node");
}

let cached: IrohModule | undefined;

/**
 * Load the native addon without letting it reach the CLI.
 *
 * A `.node` file cannot be bundled, and the coordinator runs as a single
 * detached bundle outside any `node_modules`, so the addon is copied next to
 * it and required by path. Inside an ordinary install the package resolves
 * normally. Either way nothing but the coordinator pays for the 13 MB load.
 */
export function loadIroh(): IrohModule {
	if (cached) {
		return cached;
	}
	const request = createRequire(import.meta.url);
	const entry = process.argv[1];
	const sibling = entry ? addonPathFor(entry) : undefined;
	cached = (
		sibling && sibling !== entry && existsSync(sibling)
			? request(sibling)
			: request("@number0/iroh")
	) as IrohModule;
	return cached;
}

function bytes(hex: string): number[] {
	return Array.from(Buffer.from(hex, "hex"));
}

/**
 * Bind an endpoint on this computer's stable key.
 *
 * Without configured relays this is n0's free preset: their public relays and
 * DNS discovery. `BUNCARGO_CONNECT_RELAYS` moves both sides onto relays the
 * customer pays for; both ends must set it, because a dialer reaches a
 * receiver through the relay that receiver calls home.
 */
export async function bindEndpoint(
	secretKey: string,
	alpns: string[] = [],
): Promise<Endpoint> {
	const iroh = loadIroh();
	const builder = iroh.Endpoint.builder();
	iroh.presetN0(builder);
	builder.secretKey(bytes(secretKey));
	if (alpns.length) {
		builder.alpns(alpns.map((alpn) => Array.from(Buffer.from(alpn))));
	}
	const relays = connectRelays();
	if (relays.length) {
		const map = iroh.RelayMap.empty();
		const authToken = connectRelayToken();
		for (const url of relays) {
			map.insert({ url, ...(authToken ? { authToken } : {}) });
		}
		builder.relayMode(iroh.RelayMode.custom(map));
	}
	return builder.bind();
}

/** Address a receiver by its endpoint ID alone and let discovery find its relay. */
export function endpointAddr(endpointId: string) {
	const iroh = loadIroh();
	return new iroh.EndpointAddr(iroh.EndpointId.fromString(endpointId));
}

export function alpnBytes(alpn: string): number[] {
	return Array.from(Buffer.from(alpn));
}
