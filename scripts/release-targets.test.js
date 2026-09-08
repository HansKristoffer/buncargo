import { expect, test } from "bun:test";
import { releaseTargets } from "./release-targets.cjs";

function fixture({
	cli = true,
	bar = true,
	sha = "release-commit",
	npm = false,
	assets = [],
} = {}) {
	const calls = [];
	return {
		calls,
		args: {
			versions: { ".": "8.0.0", menubar: "2.0.0" },
			context: {
				repo: { owner: "owner", repo: "repo" },
				sha: "release-commit",
			},
			github: {
				rest: {
					repos: {
						async getReleaseByTag({ tag }) {
							calls.push(tag);
							if (!(tag.startsWith("bar-") ? bar : cli))
								throw Object.assign(new Error("Not found"), { status: 404 });
							return {
								data: {
									draft: false,
									prerelease: false,
									assets,
									target_commitish: "main",
								},
							};
						},
						async getCommit() {
							return { data: { sha } };
						},
					},
				},
			},
			fetch: async () =>
				npm
					? Response.json({ name: "buncargo", version: "8.0.0" })
					: new Response("", { status: 404 }),
		},
	};
}

test("a full retry recovers both existing releases without release_created outputs", async () => {
	expect(await releaseTargets(fixture().args)).toEqual({
		cli_released: true,
		publish_npm: true,
		bar_released: true,
		bar_version: "2.0.0",
	});
});
test("an ordinary push does not republish the versions in its manifest", async () => {
	const f = fixture({ sha: "older-release" });
	f.args.fetch = () => {
		throw new Error("Must not check npm for a non-release commit");
	};
	expect(await releaseTargets(f.args)).toMatchObject({
		cli_released: false,
		publish_npm: false,
		bar_released: false,
	});
});
test("bar-only release does not deploy the Worker or publish npm", async () => {
	expect(await releaseTargets(fixture({ cli: false }).args)).toMatchObject({
		cli_released: false,
		publish_npm: false,
		bar_released: true,
	});
});
test("CLI-only release does not build the bar", async () => {
	expect(await releaseTargets(fixture({ bar: false }).args)).toMatchObject({
		cli_released: true,
		publish_npm: true,
		bar_released: false,
	});
});
test("retry skips npm and completed bar assets that already shipped", async () => {
	const f = fixture({
		npm: true,
		assets: [
			{ name: "BuncargoBar-2.0.0.zip", state: "uploaded" },
			{ name: "BuncargoBar-2.0.0.zip.sha256", state: "uploaded" },
		],
	});
	expect(await releaseTargets(f.args)).toMatchObject({
		cli_released: true,
		publish_npm: false,
		bar_released: false,
	});
});
test("a partial bar upload is retried", async () => {
	const f = fixture({
		assets: [{ name: "BuncargoBar-2.0.0.zip", state: "uploaded" }],
	});
	expect((await releaseTargets(f.args)).bar_released).toBe(true);
});
test("GitHub and npm failures fail closed instead of guessing publication state", async () => {
	const f = fixture();
	f.args.github.rest.repos.getReleaseByTag = async () => {
		throw Object.assign(new Error("GitHub unavailable"), { status: 503 });
	};
	await expect(releaseTargets(f.args)).rejects.toThrow("GitHub unavailable");
	const g = fixture();
	g.args.fetch = async () => new Response("", { status: 503 });
	await expect(releaseTargets(g.args)).rejects.toThrow("HTTP 503");
});
test("no release and invalid manifest versions cannot trigger publication", async () => {
	expect(
		await releaseTargets(fixture({ cli: false, bar: false }).args),
	).toMatchObject({
		cli_released: false,
		publish_npm: false,
		bar_released: false,
	});
	const f = fixture();
	f.args.versions["."] = "../other";
	await expect(releaseTargets(f.args)).rejects.toThrow(
		"Invalid release version",
	);
});
