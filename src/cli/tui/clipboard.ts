/**
 * Put text on the system clipboard: the platform's own tool when there is
 * one, else OSC 52, which asks the terminal to do it (and is what reaches the
 * local clipboard over SSH, where `pbcopy` would copy on the remote).
 */
export function copyToClipboard(
	text: string,
	writeToTerminal: (sequence: string) => void,
): "clipboard" | "terminal" {
	const tool =
		process.platform === "darwin"
			? ["pbcopy"]
			: Bun.which("wl-copy")
				? ["wl-copy"]
				: Bun.which("xclip")
					? ["xclip", "-selection", "clipboard"]
					: undefined;
	if (tool && !process.env.SSH_CONNECTION && Bun.which(tool[0] ?? "")) {
		try {
			const result = Bun.spawnSync(tool, {
				stdin: new TextEncoder().encode(text),
				stdout: "ignore",
				stderr: "ignore",
			});
			if (result.exitCode === 0) return "clipboard";
		} catch {
			// Fall through to the terminal.
		}
	}
	writeToTerminal(
		`\u001b]52;c;${Buffer.from(text, "utf8").toString("base64")}\u0007`,
	);
	return "terminal";
}
