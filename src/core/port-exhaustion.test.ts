import { expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OffsetClaim } from "./offset-claims";
import {
	type BlockedOffset,
	chooseReclaim,
	claimStates,
	describePortExhaustion,
	idleClaims,
} from "./port-exhaustion";
import { noteCheckoutCommand } from "./run-activity";

const DAY = 86_400_000;
const now = Date.parse("2026-11-03T12:00:00Z");
const daysAgo = (days: number) => new Date(now - days * DAY).toISOString();

const claim = (offset: number, usedDaysAgo: number): OffsetClaim => ({
	offset,
	projectName: `app-${offset}`,
	updatedAt: daysAgo(usedDaysAgo + 30),
	usedAt: daysAgo(usedDaysAgo),
});

const claims = {
	"/w/recent": claim(100, 1),
	"/w/oldest": claim(200, 40),
	"/w/older": claim(300, 9),
};

const blockedBy = (offset: number, ...claimKeys: string[]): BlockedOffset => ({
	offset,
	problem: `offset ${offset} is claimed`,
	claimKeys,
	unusable: false,
});

it("reclaims the block whose claims were all used least recently", () => {
	const blocked = [
		blockedBy(100, "/w/recent"),
		blockedBy(200, "/w/oldest"),
		blockedBy(300, "/w/older"),
	];
	const allIdle = {
		"/w/recent": "idle",
		"/w/oldest": "idle",
		"/w/older": "idle",
	} as const;

	expect(chooseReclaim(blocked, claims, allIdle, now)).toEqual({
		offset: 200,
		keys: ["/w/oldest"],
	});
	// A block two claims share is as recent as the newer of them.
	expect(
		chooseReclaim(
			[blockedBy(200, "/w/oldest", "/w/recent"), blockedBy(300, "/w/older")],
			claims,
			allIdle,
			now,
		),
	).toEqual({ offset: 300, keys: ["/w/older"] });
});

it("never reclaims a block a running or held checkout claims, or one a process holds", () => {
	const states = {
		"/w/recent": "idle",
		"/w/oldest": "running",
		"/w/older": "held",
	} as const;
	expect(
		chooseReclaim(
			[blockedBy(200, "/w/oldest"), blockedBy(300, "/w/older")],
			claims,
			states,
			now,
		),
	).toBeUndefined();
	expect(
		chooseReclaim(
			[{ ...blockedBy(100, "/w/recent"), unusable: true }],
			claims,
			states,
			now,
		),
	).toBeUndefined();
});

it("never reclaims a claim used in the last hour: a start allocates before it records its run", () => {
	const starting: OffsetClaim = {
		...claim(600, 0),
		usedAt: new Date(now - 10 * 60_000).toISOString(),
	};
	expect(
		chooseReclaim(
			[blockedBy(600, "/w/starting")],
			{ "/w/starting": starting },
			{ "/w/starting": "idle" },
			now,
		),
	).toBeUndefined();
	expect(
		idleClaims({ "/w/starting": starting }, { "/w/starting": "idle" }, 0, now),
	).toEqual({});
});

it("reads a checkout with a live run as running, one with a finished run or a running container as held", () => {
	const suffixed: OffsetClaim = {
		...claim(400, 2),
		root: "/w/recent",
		suffix: "ci",
	};
	expect(
		claimStates(
			{ ...claims, "/w/recent#ci": suffixed },
			{
				liveRoots: new Set(["/w/recent"]),
				heldRoots: new Set(["/w/older"]),
				runningProjects: new Set(["app-200"]),
			},
		),
	).toEqual({
		"/w/recent": "running",
		"/w/recent#ci": "running",
		"/w/oldest": "held",
		"/w/older": "held",
	});
});

it("finds the idle claims not used for longer than a duration, an old claim by its updatedAt", () => {
	const legacy: OffsetClaim = {
		offset: 500,
		projectName: "legacy",
		updatedAt: daysAgo(20),
	};
	const reclaimed: OffsetClaim = { ...claim(700, 50), reclaimedAt: daysAgo(1) };
	const all = { ...claims, "/w/legacy": legacy, "/w/reclaimed": reclaimed };
	const states = {
		"/w/recent": "idle",
		"/w/oldest": "held",
		"/w/older": "idle",
		"/w/legacy": "idle",
		"/w/reclaimed": "idle",
	} as const;
	expect(Object.keys(idleClaims(all, states, 7 * DAY, now))).toEqual([
		"/w/older",
		"/w/legacy",
	]);
});

it("lists every holder in the way with its state and age, and the commands that free one", () => {
	const message = describePortExhaustion(
		{
			root: "/w/new",
			range: { min: 100, max: 300, hashed: 200 },
			blocked: [
				blockedBy(200, "/w/oldest"),
				blockedBy(300, "/w/older"),
				blockedBy(100, "/w/recent"),
			],
			claims,
			pinnable: 400,
		},
		{
			reclaim: "none-idle",
			states: {
				"/w/recent": "running",
				"/w/oldest": "held",
				"/w/older": "idle",
			},
		},
		now,
	);
	expect(message).toStartWith(
		"Could not allocate a free port block for /w/new: every offset from 100 to 300 (starting at 200) is taken. No block could be reclaimed",
	);
	expect(message).toContain(
		[
			"Claims in the way, least recently used first:",
			"    200  /w/oldest (containers held, last used 40d ago)",
			"    300  /w/older (idle, last used 9d ago)",
			"    100  /w/recent (running, last used 24h ago)",
		].join("\n"),
	);
	expect(message).toContain("`buncargo ports release --idle=7d`");
	expect(message).toContain("`buncargo ports pin 400`");
});

it("counts a buncargo command in the checkout as use, not only the run's start", () => {
	const root = mkdtempSync(join(tmpdir(), "buncargo-reclaim-"));
	try {
		// Started 40 days ago, but a command ran there two days ago.
		mkdirSync(join(root, ".buncargo"));
		noteCheckoutCommand(root);
		const twoDaysAgo = new Date(now - 2 * DAY);
		utimesSync(join(root, ".buncargo", "last-command"), twoDaysAgo, twoDaysAgo);

		const withCommand = { [root]: claim(200, 40), "/w/older": claim(300, 9) };
		expect(
			chooseReclaim(
				[blockedBy(200, root), blockedBy(300, "/w/older")],
				withCommand,
				{ [root]: "idle", "/w/older": "idle" },
				now,
			),
		).toEqual({ offset: 300, keys: ["/w/older"] });
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
