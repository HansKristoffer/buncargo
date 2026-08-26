import { describe, expect, it } from "bun:test";
import {
	buildLaunchdPlist,
	buildSystemdUnit,
	HOSTS_SERVICE_LOG,
	hostsServiceLogHint,
	LAUNCHD_LABEL,
	privilegedDaemonEnv,
} from "./service-files";

const user = {
	user: "kristoffer",
	uid: 501,
	gid: 20,
	home: "/Users/kristoffer",
};

function envMap(
	entries: Array<[string, string]>,
): Record<string, string | undefined> {
	return Object.fromEntries(entries);
}

describe("privilegedDaemonEnv", () => {
	it("points the root daemon at the installing user's home", () => {
		const env = envMap(privilegedDaemonEnv(user));
		expect(env.HOME).toBe("/Users/kristoffer");
		expect(env.SUDO_USER).toBe("kristoffer");
		expect(env.SUDO_UID).toBe("501");
		expect(env.SUDO_GID).toBe("20");
	});

	// Certificates are minted by the CLI, so the daemon has no reason to find
	// mkcert and no reason to be handed a PATH that could reach it.
	it("says nothing about mkcert", () => {
		const env = envMap(privilegedDaemonEnv(user));
		expect(env.BUNCARGO_MKCERT_PATH).toBeUndefined();
		expect(env.PATH).not.toContain("/opt/homebrew/bin");
	});
});

describe("buildLaunchdPlist", () => {
	const plist = buildLaunchdPlist({
		program: "/opt/homebrew/bin/bun",
		args: ["/usr/local/libexec/buncargo/hostsd-1.2.3.js"],
		user,
	});

	it("installs a KeepAlive system daemon", () => {
		expect(plist).toContain(`<string>${LAUNCHD_LABEL}</string>`);
		expect(plist).toContain("<key>RunAtLoad</key>");
		expect(plist).toContain("<key>KeepAlive</key>");
		expect(plist).toContain("<string>/opt/homebrew/bin/bun</string>");
	});

	// launchd cannot read a root daemon's entrypoint out of ~/Documents, so the
	// plist has to point at the copy in the root-owned directory.
	it("runs the bundle from the root-owned directory", () => {
		expect(plist).toContain(
			"<string>/usr/local/libexec/buncargo/hostsd-1.2.3.js</string>",
		);
	});

	it("injects the installing user", () => {
		expect(plist).toContain("<key>HOME</key>");
		expect(plist).toContain("<string>/Users/kristoffer</string>");
		expect(plist).toContain("<key>PATH</key>");
	});

	it("escapes XML in program paths", () => {
		const withAmp = buildLaunchdPlist({
			program: "/tmp/bun&runtime",
			args: ["hosts"],
			user,
		});
		expect(withAmp).toContain("<string>/tmp/bun&amp;runtime</string>");
		expect(withAmp).not.toContain("<string>/tmp/bun&runtime</string>");
	});
});

describe("buildSystemdUnit", () => {
	it("starts the daemon with the installing user's home", () => {
		const unit = buildSystemdUnit({
			program: "/usr/bin/bun",
			args: ["/usr/local/libexec/buncargo/hostsd-1.2.3.js"],
			user,
		});
		expect(unit).toContain(
			"ExecStart=/usr/bin/bun /usr/local/libexec/buncargo/hostsd-1.2.3.js",
		);
		expect(unit).toContain("Environment=HOME=/Users/kristoffer");
		expect(unit).toContain("Restart=on-failure");
	});

	// Without these the daemon's only output is journald, while every error
	// message sends the user to the log file.
	it("writes the same log file launchd does", () => {
		const unit = buildSystemdUnit({
			program: "/usr/bin/bun",
			args: ["/usr/local/libexec/buncargo/hostsd-1.2.3.js"],
			user,
		});
		expect(unit).toContain(`StandardOutput=append:${HOSTS_SERVICE_LOG}`);
		expect(unit).toContain(`StandardError=append:${HOSTS_SERVICE_LOG}`);
	});

	it("quotes values the systemd way, not the shell way", () => {
		const unit = buildSystemdUnit({
			program: "/usr/bin/bun",
			args: ["/opt/my apps/bin.ts", "hosts"],
			user: { ...user, home: "/home/my user" },
		});
		expect(unit).toContain('"/opt/my apps/bin.ts"');
		expect(unit).toContain('Environment="HOME=/home/my user"');
		// The shell `'\''` idiom is taken literally by systemd.
		expect(unit).not.toContain("'\\''");
	});
});

describe("hostsServiceLogHint", () => {
	it("points macOS at the file launchd writes", () => {
		expect(hostsServiceLogHint("darwin")).toBe(HOSTS_SERVICE_LOG);
	});

	// A unit installed before the append directives has journald as its only
	// copy, so naming the file alone would send the user to nothing.
	it("offers journalctl on Linux, where the file may not exist", () => {
		const hint = hostsServiceLogHint("linux");
		expect(hint).toContain(HOSTS_SERVICE_LOG);
		expect(hint).toContain("journalctl -u buncargo-hosts.service");
	});
});
