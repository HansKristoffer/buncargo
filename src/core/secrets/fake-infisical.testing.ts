import {
	chmodSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A stand-in Infisical for tests: an HTTP server with the three endpoints
 * buncargo calls, and a CLI that prints a session token for one organization.
 * Records every request and CLI run, so "one fetch" and "no CLI" are
 * observable.
 */

/** A session token whose claims name an organization; the signature is fake. */
export function sessionToken(organizationId: string): string {
	const encode = (value: object) =>
		Buffer.from(JSON.stringify(value)).toString("base64url");
	return `${encode({ alg: "none" })}.${encode({ organizationId })}.sig`;
}

export interface FakeInfisical {
	siteUrl: string;
	/** `METHOD /path` of every HTTP request. */
	requests: string[];
	/** Argument lists of every CLI run. */
	cliCalls(): string[];
	/** Secrets per project; `imports` are listed as imported folders. */
	projects: Record<
		string,
		{ secrets: Record<string, string>; imports?: Record<string, string> }
	>;
	stop(): void;
}

export function startFakeInfisical(
	options: {
		cliOrganization?: string;
		cliFails?: boolean;
		mfaOrganizations?: string[];
	} = {},
): FakeInfisical & { cliPath: string; home: string } {
	const dir = mkdtempSync(join(tmpdir(), "buncargo-fake-infisical-"));
	const log = join(dir, "cli.log");
	const cliPath = join(dir, "infisical");
	writeFileSync(
		cliPath,
		options.cliFails
			? `#!/bin/sh\necho "$@" >> ${JSON.stringify(log)}\necho "secret-looking stderr" >&2\nexit 1\n`
			: `#!/bin/sh\necho "$@" >> ${JSON.stringify(log)}\necho ${JSON.stringify(sessionToken(options.cliOrganization ?? "org-a"))}\n`,
	);
	chmodSync(cliPath, 0o755);

	const requests: string[] = [];
	const projects: FakeInfisical["projects"] = {};
	const listed = (entries: Record<string, string> = {}) =>
		Object.entries(entries).map(([secretKey, secretValue]) => ({
			secretKey,
			secretValue,
		}));

	const server = Bun.serve({
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			requests.push(`${request.method} ${url.pathname}`);
			const body = request.method === "POST" ? await request.json() : undefined;
			const auth = request.headers.get("authorization") ?? "";

			if (url.pathname === "/api/v3/auth/select-organization") {
				const organizationId = (body as { organizationId: string })
					.organizationId;
				if (options.mfaOrganizations?.includes(organizationId)) {
					return Response.json({ token: "x", isMfaEnabled: true });
				}
				return Response.json({ token: sessionToken(organizationId) });
			}
			if (url.pathname === "/api/v1/auth/universal-auth/login") {
				const { clientSecret } = body as { clientSecret: string };
				return clientSecret === "right"
					? Response.json({ accessToken: "machine-token" })
					: new Response("{}", { status: 401 });
			}
			if (url.pathname === "/api/v4/secrets") {
				if (!auth.startsWith("Bearer "))
					return new Response("{}", { status: 401 });
				const project = projects[url.searchParams.get("projectId") ?? ""];
				if (!project) return new Response("{}", { status: 404 });
				return Response.json({
					secrets: listed(project.secrets),
					imports: project.imports
						? [{ secrets: listed(project.imports) }]
						: [],
				});
			}
			return new Response("{}", { status: 404 });
		},
	});

	return {
		siteUrl: `http://localhost:${server.port}`,
		requests,
		projects,
		cliPath,
		home: dir,
		cliCalls: () => {
			try {
				return readFileSync(log, "utf8").trim().split("\n").filter(Boolean);
			} catch {
				return [];
			}
		},
		stop: () => {
			server.stop(true);
			rmSync(dir, { recursive: true, force: true });
		},
	};
}
