import { once } from "node:events";
import type { AddressInfo, Server } from "node:net";

/** Allocate a loopback listener without exposing it to the LAN. */
export async function listenLoopback(server: Server) {
	const listening = once(server, "listening");
	server.listen(0, "127.0.0.1");
	await listening;
	return (server.address() as AddressInfo).port;
}
