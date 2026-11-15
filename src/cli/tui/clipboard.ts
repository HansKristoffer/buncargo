const COPY_TIMEOUT_MS = 2000;

/**
 * Put text on the system clipboard: the platform's own tool when there is
 * one, else OSC 52, which asks the terminal to do it (and is what reaches the
 * local clipboard over SSH, where `pbcopy` would copy on the remote).
 */
export function copyToClipboard(
	text: string,
	writeToTerminal: (sequence: string) => void,
): "clipboard" | "terminal" {
	// Looked up on the current PATH: `Bun.which` and spawn by bare name both
	// use the PATH this process started with.
	const which = (name: string) => Bun.which(name, { PATH: process.env.PATH });

	let command: string[];
	if (process.platform === "darwin") {
		command = ["pbcopy"];
	} else if (which("wl-copy")) {
		command = ["wl-copy"];
	} else {
		command = ["xclip", "-selection", "clipboard"];
	}

	const [name, ...args] = command;
	const tool = which(name);

	if (tool && !process.env.SSH_CONNECTION) {
		try {
			// Bounded: this runs inside the dev process, and a hung tool would
			// freeze the screen and the supervision of every app with it.
			const result = Bun.spawnSync([tool, ...args], {
				stdin: new TextEncoder().encode(text),
				stdout: "ignore",
				stderr: "ignore",
				timeout: COPY_TIMEOUT_MS,
			});
			if (result.success) return "clipboard";
		} catch {
			// Fall through to the terminal.
		}
	}

	// OSC 52: ESC ] 52 ; c ; <base64 text> BEL.
	const encoded = Buffer.from(text, "utf8").toString("base64");
	writeToTerminal(`\u001b]52;c;${encoded}\u0007`);
	return "terminal";
}
