import { DirectoryClient } from "../core/connect/client";
import { makeSecret } from "../core/connect/protocol";
import { startTailcatPublisher } from "../core/connect/tailcat/publisher";
import type { SharedTarget } from "../core/connect/targets";
import { startLocalDirectory } from "./local";
export async function tailcatFixture(
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
	let publisher: Awaited<ReturnType<typeof startTailcatPublisher>> | undefined;
	try {
		await client.create(recipient, owner, token);
		const upstream: SharedTarget = {
			id: "target",
			name: "target",
			kind: "app",
			protocol,
			status: "ready",
			port,
		};
		publisher = await startTailcatPublisher({
			targets: [upstream],
			signal: new AbortController().signal,
		});
		const snapshot = {
			version: 1 as const,
			sessionId: session,
			project: "test",
			branch: "feature/tailcat",
			primaryApp: "target",
			endpoint: publisher.endpoint,
			transport: "ready" as const,
			revision: 0,
			targets: publisher.targets,
		};
		await client.publish(recipient, token, secret, snapshot);
		return {
			directory,
			client,
			recipient,
			owner,
			token,
			secret,
			session,
			endpoint: publisher.endpoint,
			target: publisher.targets[0],
			snapshot,
			publisher,
			upstream,
			stop: async () => {
				await publisher?.close();
				await directory.stop();
			},
		};
	} catch (error) {
		await publisher?.close();
		await directory.stop();
		throw error;
	}
}
