import { afterEach, describe, expect, it } from "bun:test";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { withFileLock } from "../file-lock";
import {
	certificateFingerprint,
	describeCertificateGap,
	hostnamesForCertificate,
	readCertificatePair,
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
	it("waits for a mint another run is already doing", async () => {
		const { mkcertPath } = sandbox();

		let released = false;
		const otherRun = withFileLock(getCertPath(), async () => {
			await Bun.sleep(300);
			released = true;
		});

		await Bun.sleep(20);
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

		const { cert, key } = await readCertificatePair();
		expect(cert).toBe(key);
		expect(cert).toContain("b.demo.localhost");
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
		const minting = withFileLock(certPath, async () => {
			await Bun.sleep(300);
			released = true;
		});

		await Bun.sleep(20);
		const pair = await readCertificatePair();
		expect(released).toBe(true);
		expect(pair.cert).toBe("cert");
		expect(pair.key).toBe("key");
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
	// so an uncovered hostname is reported rather than fixed in place.
	it("reports a certificate that does not cover the hostname", () => {
		const dir = tempDir();
		try {
			const certPath = join(dir, "hosts.pem");
			writeFileSync(certPath, "not a certificate");
			const message = describeCertificateGap(["app.localhost"], certPath);
			expect(message).toContain("app.localhost");
			expect(message).toContain("buncargo hosts install");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
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
