if (process.argv[2] === "connect") {
	const [{ runCommand }, { connectCommand }] = await Promise.all([
		import("./command-spec"),
		import("./commands/connect"),
	]);
	process.exitCode = await runCommand(connectCommand, process.argv.slice(3));
} else {
	const { runConnectDaemon } = await import("../core/connect/daemon");
	await runConnectDaemon();
}
