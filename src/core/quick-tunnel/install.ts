/**
 * Download cloudflared from GitHub releases.
 * Derived from unjs/untun (MIT), originally forked from node-cloudflared.
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import https from "node:https";
import path from "node:path";
import {
	CLOUDFLARED_VERSION,
	cloudflaredBinPath,
	RELEASE_BASE,
} from "./constants";

const LINUX_URL: Partial<Record<NodeJS.Architecture, string>> = {
	arm64: "cloudflared-linux-arm64",
	arm: "cloudflared-linux-arm",
	x64: "cloudflared-linux-amd64",
	ia32: "cloudflared-linux-386",
};

const MACOS_URL: Partial<Record<NodeJS.Architecture, string>> = {
	arm64: "cloudflared-darwin-amd64.tgz",
	x64: "cloudflared-darwin-amd64.tgz",
};

const WINDOWS_URL: Partial<Record<NodeJS.Architecture, string>> = {
	x64: "cloudflared-windows-amd64.exe",
	ia32: "cloudflared-windows-386.exe",
};

function resolveBase(version: string): string {
	if (version === "latest") {
		return `${RELEASE_BASE}latest/download/`;
	}
	return `${RELEASE_BASE}download/${version}/`;
}

export function installCloudflared(
	to: string = cloudflaredBinPath,
	version = CLOUDFLARED_VERSION,
): Promise<string> {
	switch (process.platform) {
		case "linux": {
			return installLinux(to, version);
		}
		case "darwin": {
			return installMacos(to, version);
		}
		case "win32": {
			return installWindows(to, version);
		}
		default: {
			throw new Error(`Unsupported platform: ${process.platform}`);
		}
	}
}

async function installLinux(
	to: string,
	version = CLOUDFLARED_VERSION,
): Promise<string> {
	const file = LINUX_URL[process.arch];

	if (file === undefined) {
		throw new Error(`Unsupported architecture: ${process.arch}`);
	}

	await download(resolveBase(version) + file, to);
	fs.chmodSync(to, 0o755);
	return to;
}

async function installMacos(
	to: string,
	version = CLOUDFLARED_VERSION,
): Promise<string> {
	const file = MACOS_URL[process.arch];

	if (file === undefined) {
		throw new Error(`Unsupported architecture: ${process.arch}`);
	}

	await download(resolveBase(version) + file, `${to}.tgz`);
	if (process.env.DEBUG) {
		console.log(`Extracting to ${to}`);
	}
	execSync(`tar -xzf ${path.basename(`${to}.tgz`)}`, {
		cwd: path.dirname(to),
	});
	fs.unlinkSync(`${to}.tgz`);
	fs.renameSync(`${path.dirname(to)}/cloudflared`, to);
	return to;
}

async function installWindows(
	to: string,
	version = CLOUDFLARED_VERSION,
): Promise<string> {
	const file = WINDOWS_URL[process.arch];

	if (file === undefined) {
		throw new Error(`Unsupported architecture: ${process.arch}`);
	}

	await download(resolveBase(version) + file, to);
	return to;
}

function download(url: string, to: string, redirect = 0): Promise<string> {
	if (redirect === 0) {
		if (process.env.DEBUG) {
			console.log(`Downloading ${url} to ${to}`);
		}
	} else if (process.env.DEBUG) {
		console.log(`Redirecting to ${url}`);
	}

	return new Promise((resolve, reject) => {
		if (!fs.existsSync(path.dirname(to))) {
			fs.mkdirSync(path.dirname(to), { recursive: true });
		}

		let done = true;
		const file = fs.createWriteStream(to);
		const request = https.get(url, (res) => {
			if (res.statusCode === 302 && res.headers.location !== undefined) {
				const redirection = res.headers.location;
				done = false;
				file.close(() => {
					void download(redirection, to, redirect + 1).then(resolve, reject);
				});
				return;
			}
			res.pipe(file);
		});

		file.on("finish", () => {
			if (done) {
				file.close(() => {
					resolve(to);
				});
			}
		});

		request.on("error", (err) => {
			fs.unlink(to, () => {
				reject(err);
			});
		});

		file.on("error", (err) => {
			fs.unlink(to, () => {
				reject(err);
			});
		});

		request.end();
	});
}
