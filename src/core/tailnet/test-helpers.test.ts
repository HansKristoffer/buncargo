import type { RunEntry } from "../run-registry";
import type { Peer, TailscaleCommand } from "./client";
export const self: Peer = {
	id: "machine",
	hostname: "cloud.test-tailnet.ts.net",
	online: true,
};
export function fixtureRun(sessionId = "one", port = 3000): RunEntry {
	return {
		sessionId,
		projectPrefix: "project",
		projectName: "project-worktree",
		root: `/workspace/${sessionId}`,
		worktree: sessionId,
		branch: `feature/${sessionId}`,
		pid: process.pid,
		startedAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		primaryApp: "web",
		hosts: null,
		cli: { program: "/private/command" },
		apps: [
			{
				name: "web",
				port,
				status: "ready",
				url: `http://localhost:${port}`,
				loopbackUrl: `http://localhost:${port}`,
			},
		],
		services: [
			{
				name: "db",
				preset: "postgres",
				port: 5432,
				status: "ready",
				url: "postgresql://user:secret@localhost/db",
				loopbackUrl: "postgresql://user:secret@localhost/db",
			},
		],
	};
}
export function fakeTailscale() {
	type Config = {
		TCP: Record<string, unknown>;
		Web: Record<string, unknown>;
		AllowFunnel: Record<string, boolean>;
		Foreground?: Record<string, Config>;
	};
	const config: Config & { Foreground: Record<string, Config> } = {
		TCP: {},
		Web: {},
		AllowFunnel: {},
		Foreground: {},
	};
	const calls: string[][] = [];
	const command: TailscaleCommand = async (args) => {
		calls.push(args);
		if (args[0] === "status")
			return JSON.stringify({
				BackendState: "Running",
				Self: { ID: self.id, DNSName: self.hostname, Online: true },
				Peer: {},
			});
		if (args[0] === "version") return "1.102.3";
		if (args[1] === "status") return JSON.stringify(config);
		throw new Error("Unexpected command");
	};
	let counter = 0;
	const start = (args: string[]) => {
		calls.push(args);
		const flag = args.find((a) => /^--(https|tcp)=/.test(a));
		if (!flag) throw new Error("Unexpected command");
		const port = flag.split("=")[1],
			key = `${self.hostname}:${port}`;
		const session = String(++counter);
		const entry: Config = { TCP: {}, Web: {}, AllowFunnel: {} };
		if (flag.startsWith("--https")) {
			entry.TCP[port] = { HTTPS: true };
			entry.Web[key] = { Handlers: { "/": { Proxy: args.at(-1) } } };
		} else entry.TCP[port] = { TCPForward: args.at(-1) };
		config.Foreground[session] = entry;
		let alive = true;
		return {
			get alive() {
				return alive;
			},
			async close() {
				alive = false;
				delete config.Foreground[session];
			},
		};
	};
	return { config, calls, command, start };
}
