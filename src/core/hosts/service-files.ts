import type { InvokingUser } from "./paths";

/**
 * The launchd plist and systemd unit that run the named-hosts proxy as root.
 *
 * Pure string building: everything here is a function of the resolved daemon
 * command and the installing user, so the generated files can be asserted in
 * tests without touching `/Library/LaunchDaemons` or `/etc/systemd`.
 */

export const LAUNCHD_LABEL = "dev.buncargo.hosts";
export const LAUNCHD_PLIST = `/Library/LaunchDaemons/${LAUNCHD_LABEL}.plist`;
export const SYSTEMD_UNIT = "buncargo-hosts.service";
export const SYSTEMD_PATH = `/etc/systemd/system/${SYSTEMD_UNIT}`;
export const HOSTS_SERVICE_LOG = "/var/log/buncargo-hosts.log";

/**
 * The daemon spawns nothing, so this only has to cover the interpreter and the
 * handful of system tools Bun itself may reach for.
 */
const DAEMON_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

export interface DaemonServiceInput {
	program: string;
	args: string[];
	user: InvokingUser;
}

/**
 * Identity for a root daemon so it reads the installing user's `~/.buncargo`
 * and chowns what it writes back to them. launchd and systemd set none of this
 * on their own.
 *
 * Notably absent is anything about `mkcert`: certificates are minted by the
 * CLI, in the user's context, before the daemon ever needs them.
 */
export function privilegedDaemonEnv(
	user: InvokingUser,
): Array<[string, string]> {
	return [
		["HOME", user.home],
		["PATH", DAEMON_PATH],
		["SUDO_USER", user.user],
		["SUDO_UID", String(user.uid)],
		["SUDO_GID", String(user.gid)],
	];
}

function escapeXml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;");
}

function xmlString(value: string): string {
	return `<string>${escapeXml(value)}</string>`;
}

export function buildLaunchdPlist(input: DaemonServiceInput): string {
	const envEntries = privilegedDaemonEnv(input.user)
		.map(
			([key, value]) =>
				`    <key>${escapeXml(key)}</key>\n    ${xmlString(value)}`,
		)
		.join("\n");
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    ${xmlString(input.program)}
    ${input.args.map((arg) => xmlString(arg)).join("\n    ")}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${envEntries}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${HOSTS_SERVICE_LOG}</string>
  <key>StandardErrorPath</key>
  <string>${HOSTS_SERVICE_LOG}</string>
</dict>
</plist>
`;
}

/**
 * Where to look for the daemon's output.
 *
 * systemd only writes {@link HOSTS_SERVICE_LOG} for units installed with the
 * append directives above, so an older unit leaves journald as the only copy.
 * Pointing every Linux user at a file that may not exist wastes the one hint
 * they get when named hosts are down.
 */
export function hostsServiceLogHint(
	platform: NodeJS.Platform = process.platform,
): string {
	return platform === "linux"
		? `${HOSTS_SERVICE_LOG} (or \`journalctl -u ${SYSTEMD_UNIT}\`)`
		: HOSTS_SERVICE_LOG;
}

/**
 * systemd quoting, which is not shell quoting: it understands double quotes
 * with backslash escapes, and the shell `'\''` idiom would be taken literally.
 */
function systemdQuote(value: string): string {
	if (/^[a-zA-Z0-9_./:@%+=,-]+$/.test(value)) return value;
	return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

export function buildSystemdUnit(input: DaemonServiceInput): string {
	const envLines = privilegedDaemonEnv(input.user)
		.map(([key, value]) => `Environment=${systemdQuote(`${key}=${value}`)}`)
		.join("\n");
	const exec = [input.program, ...input.args].map(systemdQuote).join(" ");
	return `[Unit]
Description=buncargo named-hosts proxy
After=network.target

[Service]
Type=simple
ExecStart=${exec}
${envLines}
Restart=on-failure
StandardOutput=append:${HOSTS_SERVICE_LOG}
StandardError=append:${HOSTS_SERVICE_LOG}

[Install]
WantedBy=multi-user.target
`;
}
