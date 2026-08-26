import { execFileSync, execSync } from "node:child_process";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const LAUNCHD_LABEL = "dev.buncargo.hosts";
export const LAUNCHD_PLIST = `/Library/LaunchDaemons/${LAUNCHD_LABEL}.plist`;
export const SYSTEMD_UNIT = "buncargo-hosts.service";
export const SYSTEMD_PATH = `/etc/systemd/system/${SYSTEMD_UNIT}`;

export function resolveHostsDaemonCommand(): {
	program: string;
	args: string[];
} {
	const execPath = process.execPath;
	const bin = resolveCliBin();
	return { program: execPath, args: [bin, "hosts", "daemon", "--service"] };
}

function resolveCliBin(): string {
	const fromArgv = process.argv[1];
	if (fromArgv) {
		return resolve(fromArgv);
	}
	return resolve(fileURLToPath(new URL("../../cli/bin.ts", import.meta.url)));
}

export function isHostsServiceInstalled(): boolean {
	if (process.platform === "darwin") {
		return existsSync(LAUNCHD_PLIST);
	}
	if (process.platform === "linux") {
		return existsSync(SYSTEMD_PATH);
	}
	return false;
}

export function installHostsService(): void {
	const { program, args } = resolveHostsDaemonCommand();
	if (process.platform === "darwin") {
		const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${program}</string>
    ${args.map((arg) => `<string>${arg}</string>`).join("\n    ")}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/var/log/buncargo-hosts.log</string>
  <key>StandardErrorPath</key>
  <string>/var/log/buncargo-hosts.log</string>
</dict>
</plist>
`;
		mkdirSync(dirname(LAUNCHD_PLIST), { recursive: true });
		writeFileSync(LAUNCHD_PLIST, plist);
		try {
			execFileSync("launchctl", ["bootout", `system/${LAUNCHD_LABEL}`], {
				stdio: "ignore",
			});
		} catch {
			// not loaded
		}
		execFileSync("launchctl", ["bootstrap", "system", LAUNCHD_PLIST], {
			stdio: "inherit",
		});
		return;
	}

	if (process.platform === "linux") {
		const unit = `[Unit]
Description=buncargo named-hosts proxy
After=network.target

[Service]
Type=simple
ExecStart=${program} ${args.map((arg) => quote(arg)).join(" ")}
Restart=on-failure

[Install]
WantedBy=multi-user.target
`;
		writeFileSync(SYSTEMD_PATH, unit);
		execSync(
			"systemctl daemon-reload && systemctl enable --now buncargo-hosts.service",
			{
				stdio: "inherit",
			},
		);
		return;
	}

	throw new Error(
		"Named hosts service install is only supported on macOS and Linux.",
	);
}

export function uninstallHostsService(): void {
	if (process.platform === "darwin") {
		try {
			execFileSync("launchctl", ["bootout", `system/${LAUNCHD_LABEL}`], {
				stdio: "ignore",
			});
		} catch {
			// not loaded
		}
		if (existsSync(LAUNCHD_PLIST)) {
			unlinkSync(LAUNCHD_PLIST);
		}
		return;
	}
	if (process.platform === "linux") {
		try {
			execSync("systemctl disable --now buncargo-hosts.service", {
				stdio: "ignore",
			});
		} catch {
			// not installed
		}
		if (existsSync(SYSTEMD_PATH)) {
			unlinkSync(SYSTEMD_PATH);
			try {
				execSync("systemctl daemon-reload", { stdio: "ignore" });
			} catch {
				// ignore
			}
		}
	}
}

function quote(value: string): string {
	if (/^[a-zA-Z0-9_./:-]+$/.test(value)) return value;
	return `'${value.replace(/'/g, `'\\''`)}'`;
}
