import { afterEach, describe, expect, it } from "bun:test";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { withFileLock } from "../file-lock";
import {
	certificateFingerprint,
	certificateServes,
	describeCertificateGap,
	describeCertificateShortfall,
	hostnamesForCertificate,
	readCertificatePair,
	resolveMkcertForMint,
	syncCertificateForRoutes,
} from "./certificates";
import { getCertPath, getKeyPath } from "./paths";

function tempDir(): string {
	return mkdtempSync(join(tmpdir(), "buncargo-certs-test-"));
}

/**
 * A stand-in for mkcert that stamps the requested hostnames into both files, so
 * a mint is observable without downloading a real binary.
 */
function fakeMkcert(dir: string): string {
	const path = join(dir, "fake-mkcert");
	writeFileSync(
		path,
		`#!/bin/sh
cert=""
key=""
hosts=""
while [ $# -gt 0 ]; do
  case "$1" in
    -cert-file) cert="$2"; shift 2 ;;
    -key-file) key="$2"; shift 2 ;;
    *) hosts="$hosts $1"; shift ;;
  esac
done
printf 'gen:%s' "$hosts" > "$cert"
printf 'gen:%s' "$hosts" > "$key"
`,
	);
	chmodSync(path, 0o755);
	return path;
}

describe("syncCertificateForRoutes", () => {
	const originalHome = process.env.HOME;
	const dirs: string[] = [];

	afterEach(() => {
		process.env.HOME = originalHome;
		for (const dir of dirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	function sandbox(): { home: string; mkcertPath: string } {
		const home = tempDir();
		dirs.push(home);
		process.env.HOME = home;
		return { home, mkcertPath: fakeMkcert(home) };
	}

	// Another run minting at the same moment has mkcert writing the same two
	// files while the root daemon polls them, so this has to queue behind it.
	// Asserted through the lock rather than two in-process calls, which
	// `execFileSync` would serialize on its own and prove nothing.
	it("leaves the certificate lock available while downloading mkcert", async () => {
		const { mkcertPath } = sandbox();
		let started!: () => void;
		const downloading = new Promise<void>((resolve) => {
			started = resolve;
		});
		let release!: () => void;
		const downloaded = new Promise<void>((resolve) => {
			release = resolve;
		});
		const syncing = syncCertificateForRoutes(
			{ include: ["a.demo.localhost"] },
			{
				resolveMkcert: async () => {
					started();
					await downloaded;
					return mkcertPath;
				},
			},
		);
		await downloading;
		try {
			expect(
				await withFileLock(getCertPath(), async () => "available", {
					timeoutMs: 100,
				}),
			).toBe("available");
		} finally {
			release();
			await syncing;
		}
	});

	it("waits for a mint another run is already doing", async () => {
		const { mkcertPath } = sandbox();

		let released = false;
		const { promise: held, resolve: markHeld } = Promise.withResolvers<void>();
		const otherRun = withFileLock(getCertPath(), async () => {
			markHeld();
			// Long enough that a sync ignoring the lock would finish first.
			await Bun.sleep(300);
			released = true;
		});

		await held;
		await syncCertificateForRoutes({
			mkcertPath,
			include: ["a.demo.localhost"],
		});
		expect(released).toBe(true);
		await otherRun;
	});

	it("mints for the registry plus the hostnames this run is about to add", async () => {
		const { mkcertPath } = sandbox();

		await syncCertificateForRoutes({
			mkcertPath,
			include: ["web.demo.localhost", "api.demo.localhost"],
		});

		const contents = readFileSync(getCertPath(), "utf-8");
		expect(contents).toContain("api.demo.localhost");
		expect(contents).toContain("web.demo.localhost");
	});

	it("leaves the pair matching, never a new certificate with the old key", async () => {
		const { mkcertPath } = sandbox();
		await syncCertificateForRoutes({
			mkcertPath,
			include: ["a.demo.localhost"],
		});

		await syncCertificateForRoutes({
			mkcertPath,
			include: ["a.demo.localhost", "b.demo.localhost"],
		});

		const pair = await readCertificatePair();
		expect(pair?.cert).toBe(pair?.key);
		expect(pair?.cert).toContain("b.demo.localhost");
	});
});

describe("resolveMkcertForMint", () => {
	const originalHome = process.env.HOME;
	const dirs: string[] = [];

	afterEach(() => {
		process.env.HOME = originalHome;
		for (const dir of dirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	function sandboxHome(): string {
		const home = tempDir();
		dirs.push(home);
		process.env.HOME = home;
		return home;
	}

	it("uses an installed mkcert without downloading anything", async () => {
		sandboxHome();
		let downloads = 0;
		const path = await resolveMkcertForMint(getCertPath(), ["a.localhost"], {
			resolve: () => "/usr/local/bin/mkcert",
			download: async () => {
				downloads += 1;
				return "/downloaded";
			},
		});
		expect(path).toBe("/usr/local/bin/mkcert");
		expect(downloads).toBe(0);
	});

	// The cache lives in the user's home now, but a home can still be wiped.
	// Dead-ending here is what downgraded a whole worktree to localhost:port.
	it("downloads mkcert when a mint is due and none is installed", async () => {
		sandboxHome();
		const path = await resolveMkcertForMint(getCertPath(), ["a.localhost"], {
			resolve: () => undefined,
			download: async () => "/downloaded/mkcert",
		});
		expect(path).toBe("/downloaded/mkcert");
	});

	// Most runs need no mint at all: paying for a download there would put a
	// network call on the path of every `buncargo dev`.
	it("does not download when the certificate already covers everything", async () => {
		sandboxHome();
		let downloads = 0;
		const path = await resolveMkcertForMint(getCertPath(), ["a.localhost"], {
			resolve: () => undefined,
			needsRenewal: () => false,
			download: async () => {
				downloads += 1;
				return "/downloaded";
			},
		});
		expect(path).toBeUndefined();
		expect(downloads).toBe(0);
	});

	it("keeps the install hint when the download itself fails", async () => {
		sandboxHome();
		await expect(
			resolveMkcertForMint(getCertPath(), ["a.localhost"], {
				resolve: () => undefined,
				download: async () => {
					throw new Error("offline");
				},
			}),
		).rejects.toThrow("buncargo hosts install");
	});
});

describe("readCertificatePair", () => {
	const originalHome = process.env.HOME;
	const dirs: string[] = [];

	afterEach(() => {
		process.env.HOME = originalHome;
		for (const dir of dirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	// Landing a new pair is two renames. A reader that ignores the lock can
	// fall between them and bind a certificate against the previous key.
	it("waits for an in-flight mint instead of reading mid-rename", async () => {
		const home = tempDir();
		dirs.push(home);
		process.env.HOME = home;

		const certPath = getCertPath();
		mkdirSync(dirname(certPath), { recursive: true });
		writeFileSync(certPath, "cert");
		writeFileSync(getKeyPath(), "key");

		let released = false;
		const { promise: held, resolve: markHeld } = Promise.withResolvers<void>();
		const minting = withFileLock(certPath, async () => {
			markHeld();
			// Long enough that a read ignoring the lock would finish first.
			await Bun.sleep(300);
			released = true;
		});

		await held;
		const pair = await readCertificatePair();
		expect(released).toBe(true);
		expect(pair).toEqual({ cert: "cert", key: "key" });
		await minting;
	});
});

describe("hostnamesForCertificate", () => {
	it("keeps registered hostnames", () => {
		expect(hostnamesForCertificate(["api.app.localhost"])).toEqual([
			"api.app.localhost",
			"localhost",
		]);
	});

	it("covers localhost so the health endpoint can bind before any routes exist", () => {
		expect(hostnamesForCertificate([])).toEqual(["localhost"]);
	});

	// The daemon asks for coverage of the live route set, so a leaf minted
	// while projects were running has to still satisfy it once they all stop.
	// Otherwise every poll reports a gap and the backoff widens to 30s.
	it("keeps a leaf minted for running projects valid after they all stop", () => {
		const whileRunning = hostnamesForCertificate([
			"web.app.localhost",
			"api.app.localhost",
		]);
		const whenIdle = hostnamesForCertificate([]);
		for (const hostname of whenIdle) {
			expect(whileRunning).toContain(hostname);
		}
	});

	it("does not duplicate localhost when it is already registered", () => {
		expect(hostnamesForCertificate(["localhost"])).toEqual(["localhost"]);
	});
});

describe("describeCertificateGap", () => {
	it("names the missing file and the command that creates it", () => {
		const dir = tempDir();
		try {
			const certPath = join(dir, "hosts.pem");
			const message = describeCertificateGap(["app.localhost"], certPath);
			expect(message).toContain(certPath);
			expect(message).toContain("buncargo hosts install");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	// The daemon runs as root under launchd and must not shell out to mkcert,
	// so a bad certificate is reported rather than fixed in place.
	it("reports a certificate it cannot read", () => {
		const dir = tempDir();
		try {
			const certPath = join(dir, "hosts.pem");
			writeFileSync(certPath, "not a certificate");
			const message = describeCertificateGap(["app.localhost"], certPath);
			expect(message).toContain("could not be read");
			expect(message).toContain("buncargo hosts install");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("describeCertificateShortfall", () => {
	const now = Date.parse("2026-10-17T00:00:00Z");

	it("names only the hostnames the certificate lacks", () => {
		expect(
			describeCertificateShortfall(
				{ kind: "uncovered", hostnames: ["new.app.localhost"] },
				now,
			),
		).toBe(
			"Named-hosts certificate does not cover new.app.localhost. Run `buncargo hosts install`.",
		);
	});

	// An expiring certificate covers every name; calling that "does not cover"
	// sent people looking for a hostname problem.
	it("says a certificate is expiring rather than uncovered", () => {
		const message = describeCertificateShortfall(
			{ kind: "expiring", validTo: Date.parse("2026-11-01T00:00:00Z") },
			now,
		);
		expect(message).toContain("expires on 2026-11-01");
		expect(message).not.toContain("does not cover");
	});

	it("says a certificate has already expired", () => {
		expect(
			describeCertificateShortfall(
				{ kind: "expiring", validTo: Date.parse("2026-10-01T00:00:00Z") },
				now,
			),
		).toContain("expired on 2026-10-01");
	});
});

describe("certificateFingerprint", () => {
	it("changes when the certificate is reminted, so the daemon rebinds", () => {
		const dir = tempDir();
		try {
			const certPath = join(dir, "hosts.pem");
			const keyPath = join(dir, "hosts-key.pem");
			writeFileSync(certPath, "cert");
			writeFileSync(keyPath, "key");

			const before = certificateFingerprint(certPath, keyPath);
			writeFileSync(certPath, "a wider cert");
			const later = new Date(Date.now() + 5_000);
			utimesSync(certPath, later, later);

			expect(certificateFingerprint(certPath, keyPath)).not.toBe(before);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	// A mint lands by rename. Two of one size inside the mtime granularity
	// looked identical, and the daemon kept the previous leaf.
	it("changes when a same-size certificate is renamed in at the same mtime", () => {
		const dir = tempDir();
		try {
			const certPath = join(dir, "hosts.pem");
			const keyPath = join(dir, "hosts-key.pem");
			writeFileSync(certPath, "cert-a");
			writeFileSync(keyPath, "key");
			const stamp = new Date(1_700_000_000_000);
			utimesSync(certPath, stamp, stamp);
			const before = certificateFingerprint(certPath, keyPath);

			const pending = join(dir, "hosts.pem.tmp");
			writeFileSync(pending, "cert-b");
			utimesSync(pending, stamp, stamp);
			renameSync(pending, certPath);

			expect(certificateFingerprint(certPath, keyPath)).not.toBe(before);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("is stable while nothing changes", () => {
		const dir = tempDir();
		try {
			const certPath = join(dir, "hosts.pem");
			const keyPath = join(dir, "hosts-key.pem");
			writeFileSync(certPath, "cert");
			writeFileSync(keyPath, "key");

			expect(certificateFingerprint(certPath, keyPath)).toBe(
				certificateFingerprint(certPath, keyPath),
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("reports missing files instead of throwing", () => {
		const dir = tempDir();
		try {
			expect(
				certificateFingerprint(
					join(dir, "none.pem"),
					join(dir, "none-key.pem"),
				),
			).toBe("missing|missing");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("readCertificatePair", () => {
	const originalHome = process.env.HOME;
	afterEach(() => {
		process.env.HOME = originalHome;
	});

	// The daemon reads while a CLI mints under the lock: that is a mint in
	// progress to retry, not a failed reload.
	it("reads as undefined while a mint holds the certificate lock", async () => {
		const home = tempDir();
		process.env.HOME = home;
		try {
			mkdirSync(dirname(getCertPath()), { recursive: true });
			writeFileSync(getCertPath(), "cert");
			writeFileSync(getKeyPath(), "key");
			let release!: () => void;
			let held!: () => void;
			const locked = new Promise<void>((resolve) => {
				held = resolve;
			});
			const holder = withFileLock(getCertPath(), async () => {
				held();
				await new Promise<void>((resolve) => {
					release = resolve;
				});
			});
			await locked;

			expect(await readCertificatePair()).toBeUndefined();
			release();
			await holder;
			expect(await readCertificatePair()).toEqual({
				cert: "cert",
				key: "key",
			});
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});
});

describe("certificateServes", () => {
	// A real leaf for demo.localhost, web.demo.localhost and *.demo.localhost,
	// minted once with openssl; expiring Oct 13 18:34:34 2126 GMT.
	const leaf = readFileSync(
		join(import.meta.dir, "fixtures", "leaf.pem"),
		"utf8",
	);
	const validTo = Date.parse("2126-10-13T18:34:34Z");
	const serves = certificateServes(leaf);

	it("serves the names the leaf carries, and one label under its wildcard", () => {
		const now = validTo - 1;
		expect(serves?.("demo.localhost", now)).toBe(true);
		expect(serves?.("web.demo.localhost", now)).toBe(true);
		expect(serves?.("fix-ui.demo.localhost", now)).toBe(true);
		expect(serves?.("a.b.demo.localhost", now)).toBe(false);
		expect(serves?.("other.localhost", now)).toBe(false);
	});

	it("serves nothing once the leaf has expired", () => {
		expect(serves?.("web.demo.localhost", validTo)).toBe(false);
	});

	// Reading nothing from a certificate `Bun.serve` accepted is not "serves
	// nothing": that sent every run on the machine to localhost:port.
	it("cannot say for a certificate it cannot read", () => {
		expect(certificateServes("not a certificate")).toBeUndefined();
	});
});
