import { describe, expect, it } from "bun:test";
import { invokingUserIdentity, resolveUserHome } from "./paths";

describe("resolveUserHome", () => {
	it("uses HOME when not running as root via sudo", () => {
		expect(
			resolveUserHome({
				HOME: "/Users/kristoffer",
				USER: "kristoffer",
			}),
		).toBe("/Users/kristoffer");
	});

	// The launchd/systemd service puts the invoking user's home in HOME on
	// purpose. Looking the user up anyway would fork on every path getter,
	// several times per second in the daemon's reload loop.
	it("trusts an already-resolved HOME when elevated", () => {
		expect(
			resolveUserHome(
				{
					HOME: "/Users/kristoffer",
					SUDO_USER: "kristoffer",
				},
				0,
			),
		).toBe("/Users/kristoffer");
	});

	it("does not accept root's own home as the invoking user's", () => {
		// Falls back to a lookup, which on this machine cannot resolve a user
		// that does not exist, so it lands back on HOME.
		expect(
			resolveUserHome(
				{
					HOME: "/var/root",
					USER: "root",
					SUDO_USER: "definitely-not-a-real-user",
				},
				0,
			),
		).toBe("/var/root");
	});
});

describe("invokingUserIdentity", () => {
	it("uses the current user when not elevated", () => {
		expect(
			invokingUserIdentity(
				{
					HOME: "/Users/kristoffer",
					USER: "kristoffer",
				},
				{ uid: 501, gid: 20 },
			),
		).toEqual({
			user: "kristoffer",
			uid: 501,
			gid: 20,
			home: "/Users/kristoffer",
		});
	});

	it("prefers SUDO_USER when the process is root", () => {
		expect(
			invokingUserIdentity(
				{
					HOME: "/var/root",
					USER: "root",
					SUDO_USER: "kristoffer",
					SUDO_UID: "501",
					SUDO_GID: "20",
				},
				{ uid: 0, gid: 0 },
			),
		).toMatchObject({
			user: "kristoffer",
			uid: 501,
			gid: 20,
		});
	});
});
