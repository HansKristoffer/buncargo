export const TAILNET_SERVICE_LABEL = "dev.buncargo.tailnet";

const LABEL = TAILNET_SERVICE_LABEL;

const xml = (s: string) =>
	s
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;");

const unitQuote = (s: string) =>
	`"${s.replaceAll("%", "%%").replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;

export function tailnetServiceDefinition(input: {
	platform: string;
	bun: string;
	script: string;
	home: string;
	log: string;
	binary: string;
}) {
	if (input.platform === "darwin") {
		return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
	<dict>
		<key>Label</key>
		<string>${LABEL}</string>
		<key>ProgramArguments</key>
		<array>
			<string>${xml(input.bun)}</string>
			<string>${xml(input.script)}</string>
		</array>
		<key>EnvironmentVariables</key>
		<dict>
			<key>HOME</key>
			<string>${xml(input.home)}</string>
			<key>BUNCARGO_TAILSCALE_PATH</key>
			<string>${xml(input.binary)}</string>
		</dict>
		<key>RunAtLoad</key>
		<true/>
		<key>KeepAlive</key>
		<true/>
		<key>StandardOutPath</key>
		<string>${xml(input.log)}</string>
		<key>StandardErrorPath</key>
		<string>${xml(input.log)}</string>
	</dict>
</plist>
`;
	}

	return `[Unit]
Description=Buncargo tailnet directory and cleanup
After=network-online.target

[Service]
ExecStart=${unitQuote(input.bun)} ${unitQuote(input.script)}
Environment=${unitQuote(`HOME=${input.home}`)} ${unitQuote(`BUNCARGO_TAILSCALE_PATH=${input.binary}`)}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;
}
