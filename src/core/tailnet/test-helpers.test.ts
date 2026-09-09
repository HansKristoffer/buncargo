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
	const config: {
		TCP: Record<string, unknown>;
		Web: Record<string, unknown>;
		AllowFunnel: Record<string, boolean>;
	} = { TCP: {}, Web: {}, AllowFunnel: {} };
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
		const flag = args.find((a) => /^--(https|tcp)=/.test(a));
		if (!flag) throw new Error("Unexpected command");
		const port = flag.split("=")[1],
			key = `${self.hostname}:${port}`;
		if (args.at(-1) === "off") {
			delete config.TCP[port];
			delete config.Web[key];
			return "";
		}
		if (flag.startsWith("--https")) {
			config.TCP[port] = { HTTPS: true };
			config.Web[key] = { Handlers: { "/": { Proxy: args.at(-1) } } };
		} else config.TCP[port] = { TCPForward: args.at(-1) };
		return "";
	};
	return { config, calls, command };
}
