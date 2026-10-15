/**
 * This machine's Tailscale address. Imports nothing but `node:os`: the Vite
 * plugin, loaded by users' `vite.config.ts`, reads it too.
 */

import { networkInterfaces } from "node:os";

type Interfaces = ReturnType<typeof networkInterfaces>;

/**
 * This machine's Tailscale IPv4, or undefined while it is not on a tailnet.
 *
 * The interface name matters as much as the range: some mobile hotspots hand
 * out 100.64.0.0/10 addresses too, and binding there would serve the hotspot.
 * Tailscale's interface is `tailscale0` on Linux and a `utun` on macOS.
 */
export function tailscaleAddress(
	interfaces: Interfaces = networkInterfaces(),
): string | undefined {
	for (const [name, addresses] of Object.entries(interfaces)) {
		if (!/^(tailscale|utun)/.test(name)) continue;
		for (const address of addresses ?? []) {
			const [a, b] = address.address.split(".").map(Number);
			if (address.family === "IPv4" && a === 100 && b >= 64 && b < 128)
				return address.address;
		}
	}
	return undefined;
}
