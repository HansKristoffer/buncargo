import { expect, test } from "bun:test";
import { discoverTailnet } from "./discovery";
import { type Directory, parseDirectory, readDirectory } from "./protocol";
import { self } from "./test-helpers.test";

const fixture = (): Directory => ({
	version: 1,
	machineId: self.id,
	hostname: self.hostname,
	generatedAt: Date.now(),
	runs: [
		{
			sessionId: "machine:run",
			machineId: self.id,
			hostname: self.hostname,
			project: "project",
			branch: "feature/cloud",
			worktree: "cloud",
			primaryApp: "web",
			targets: [
				{
					id: "app-web",
					name: "web",
					kind: "app",
					protocol: "http",
					status: "ready",
					port: 21000,
					url: `https://${self.hostname}:21000/`,
				},
			],
		},
	],
});
test("directory validation binds every target to the authenticated peer", () => {
	expect(parseDirectory(fixture(), self).runs[0].branch).toBe("feature/cloud");
	for (const url of [
		"https://attacker.example:21000/",
		`https://user:secret@${self.hostname}:21000/`,
		`http://${self.hostname}:21000/`,
		`https://${self.hostname}:21000/other`,
		`https://${self.hostname}:21001/`,
	]) {
		const d = fixture();
		d.runs[0].targets[0].url = url;
		expect(() => parseDirectory(d, self)).toThrow();
	}
	const stale = fixture();
	stale.generatedAt -= 31000;
	expect(() => parseDirectory(stale, self)).toThrow();
	const wrong = fixture();
	wrong.machineId = "another";
	expect(() => parseDirectory(wrong, self)).toThrow();
});
test("discovery probes only online peers, ignores non-directories and rejects redirects", async () => {
	const requested: string[] = [];
	const local = {
		ID: "local",
		DNSName: "mac.test-tailnet.ts.net",
		Online: true,
	};
	const peers = {
		a: { ID: self.id, DNSName: self.hostname, Online: true },
		b: { ID: "offline", DNSName: "offline.test-tailnet.ts.net", Online: false },
		c: { ID: "other", DNSName: "other.test-tailnet.ts.net", Online: true },
	};
	const result = await discoverTailnet(
		async () =>
			JSON.stringify({ BackendState: "Running", Self: local, Peer: peers }),
		async (url, init) => {
			requested.push(url);
			expect(init.redirect).toBe("error");
			return url.includes("cloud.")
				? Response.json(fixture())
				: new Response("", { status: 404 });
		},
	);
	expect(requested).toHaveLength(2);
	expect(result.runs).toHaveLength(1);
});
test("body reader rejects oversized directories before JSON parsing", async () => {
	await expect(
		readDirectory(new Response(" ".repeat(1024 * 1024 + 1))),
	).rejects.toThrow("too large");
});
