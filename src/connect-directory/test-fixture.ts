import { DirectoryClient } from "../core/connect/client";
import {
	makeSecret,
	type RemoteTarget,
	relayEndpoint,
} from "../core/connect/protocol";
import { startRelayPublisher } from "../core/connect/transport/publisher";
import { startLocalDirectory } from "./local";
export async function relayFixture(
	port: number,
	protocol: "http" | "tcp" = "tcp",
) {
	const directory = await startLocalDirectory();
	const client = new DirectoryClient(directory.url);
	const recipient = "device",
		owner = makeSecret(),
		token = makeSecret(),
		secret = makeSecret(),
		session = "test-session";
	await client.create(recipient, owner, token);
	const endpoint = relayEndpoint(client.origin, recipient, session);
	const target: RemoteTarget = {
		id: "target",
		name: "target",
		kind: "app",
		protocol,
		status: "ready",
	};
	const snapshot = {
		version: 1 as const,
		sessionId: session,
		project: "test",
		branch: "feature/relay",
		primaryApp: "target",
		endpoint,
		revision: 0,
		targets: [target],
	};
	await client.publish(recipient, token, secret, snapshot);
	const upstream = { id: "target", port, status: "ready" as const };
	const publisher = startRelayPublisher({
		endpoint,
		recipient,
		session,
		secret,
		origin: client.origin,
		key: directory.publicKey,
		targets: [upstream],
		signal: new AbortController().signal,
	});
	await publisher.ready;
	return {
		directory,
		client,
		recipient,
		owner,
		token,
		secret,
		session,
		endpoint,
		target,
		snapshot,
		publisher,
		upstream,
		access: () => client.access(recipient, owner, session, target.id),
		stop: async () => {
			publisher.close();
			await directory.stop();
		},
	};
}
