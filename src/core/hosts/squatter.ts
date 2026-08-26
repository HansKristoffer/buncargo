import { getPortOwner } from "../process";

export function describePortSquatter(port: number): string | undefined {
	const owner = getPortOwner(port);
	if (!owner) return undefined;

	const command = (owner.command ?? "").toLowerCase();
	const name = owner.container?.name?.toLowerCase() ?? "";
	const haystack = `${command} ${name}`;

	if (haystack.includes("portless")) {
		return `Portless is serving :${port} — run \`portless proxy stop\`, or keep using Portless and set hosts: false.`;
	}
	if (haystack.includes("caddy")) {
		return `Caddy is serving :${port}. Stop it or set hosts: false.`;
	}
	if (haystack.includes("nginx")) {
		return `nginx is serving :${port}. Stop it or set hosts: false.`;
	}
	if (owner.container) {
		return `Docker container ${owner.container.name} is publishing :${port}. Stop it or set hosts: false.`;
	}
	if (owner.command) {
		return `${owner.command} is serving :${port}. Stop it or set hosts: false.`;
	}
	return `Port ${port} is already in use.`;
}
