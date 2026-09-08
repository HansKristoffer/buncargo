// Release Please's release_created outputs describe this invocation, not whether
// this commit is a release. Resolve existing releases too so a full rerun works.
async function releaseTargets({
	github,
	context,
	versions,
	fetch: request = fetch,
}) {
	const repo = context.repo;
	async function atCommit(tag) {
		let release;
		try {
			({ data: release } = await github.rest.repos.getReleaseByTag({
				...repo,
				tag,
			}));
		} catch (error) {
			if (error.status === 404) return undefined;
			throw error;
		}
		if (release.draft || release.prerelease) return undefined;
		// getCommit peels annotated tags too. target_commitish can simply be 'main'.
		const { data: commit } = await github.rest.repos.getCommit({
			...repo,
			ref: tag,
		});
		return commit.sha === context.sha ? release : undefined;
	}
	for (const path of [".", "menubar"]) {
		if (!/^\d+\.\d+\.\d+$/.test(versions[path] ?? "")) {
			throw new Error(`Invalid release version for ${path}`);
		}
	}
	const cliVersion = versions["."];
	const barVersion = versions.menubar;
	const [cli, bar] = await Promise.all([
		atCommit(`v${cliVersion}`),
		atCommit(`bar-v${barVersion}`),
	]);
	let publishNpm = false;
	if (cli) {
		const response = await request(
			`https://registry.npmjs.org/buncargo/${cliVersion}`,
			{
				signal: AbortSignal.timeout(10000),
			},
		);
		if (response.status === 404) publishNpm = true;
		else if (response.ok) {
			const metadata = await response.json();
			if (metadata.name !== "buncargo" || metadata.version !== cliVersion) {
				throw new Error("npm returned unexpected release metadata");
			}
		} else
			throw new Error(
				`Could not check npm publication: HTTP ${response.status}`,
			);
	}
	const barComplete =
		bar &&
		[
			`BuncargoBar-${barVersion}.zip`,
			`BuncargoBar-${barVersion}.zip.sha256`,
		].every((name) =>
			bar.assets.some(
				(asset) => asset.name === name && asset.state === "uploaded",
			),
		);
	return {
		cli_released: Boolean(cli),
		publish_npm: publishNpm,
		bar_released: Boolean(bar && !barComplete),
		bar_version: barVersion,
	};
}
module.exports = { releaseTargets };
