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

/**
 * A session token whose claims name an organization; the signature is fake.
 * `session` tells apart the tokens of successive logins.
 */
export function sessionToken(organizationId: string, session = 0): string {
	const encode = (value: object) =>
		Buffer.from(JSON.stringify(value)).toString("base64url");
	const claims = session ? { organizationId, session } : { organizationId };
	return `${encode({ alg: "none" })}.${encode(claims)}.sig`;
}

/** The login a token, or an organization token exchanged from it, belongs to. */
function sessionOf(auth: string): number {
	try {
		const claims = JSON.parse(
			Buffer.from(auth.split(".")[1] ?? "", "base64url").toString(),
		) as { session?: unknown };
		return typeof claims.session === "number" ? claims.session : 0;
	} catch {
		return 0;
	}
}

export interface FakeInfisical {
	siteUrl: string;
	/** `METHOD /path` of every HTTP request. */
	requests: string[];
	/** Argument lists of every CLI run. */
	cliCalls(): string[];
	/** Let held list requests and CLI runs answer. */
	release(): void;
	/**
	 * Revoke the CLI's session token, as an expiry or a logout elsewhere does:
	 * requests with it get 401, and the CLI hands out a new one.
	 */
	rotateSession(): void;
	/** Revoke the CLI's session token while the CLI keeps handing it out. */
	revokeSession(): void;
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
		/**
		 * An expired session: the CLI announces its login flow and waits on
		 * it (`prompt`), or waits without a word (`hang`).
		 */
		cliLogin?: "prompt" | "hang";
		/** CLI runs wait for {@link FakeInfisical.release} before answering. */
		holdCli?: boolean;
		/** List requests wait for {@link FakeInfisical.release} before answering. */
		holdRequests?: boolean;
		/** Simulated network latency for the startup benchmark; tests hold instead. */
		requestDelayMs?: number;
		mfaOrganizations?: string[];
		/** Projects whose secrets every session is refused (HTTP 403). */
		forbiddenProjects?: string[];
	} = {},
): FakeInfisical & { cliPath: string; home: string } {
	const dir = mkdtempSync(join(tmpdir(), "buncargo-fake-infisical-"));
	const log = join(dir, "cli.log");
	const releaseFile = join(dir, "released");
	const tokenFile = join(dir, "session");
	const cliPath = join(dir, "infisical");
	const organization = options.cliOrganization ?? "org-a";
	let session = 0;
	const revoked = new Set<string>();
	writeFileSync(tokenFile, sessionToken(organization));
	const loginFlow =
		options.cliLogin === "prompt"
			? 'echo "No valid login session found, triggering login flow" >&2\n'
			: "";
	writeFileSync(
		cliPath,
		options.cliLogin
			? `#!/bin/sh\necho "$@" >> ${JSON.stringify(log)}\n${loginFlow}exec sleep 30\n`
			: options.cliFails
				? `#!/bin/sh\necho "$@" >> ${JSON.stringify(log)}\necho "secret-looking stderr" >&2\nexit 1\n`
				: `#!/bin/sh\necho "$@" >> ${JSON.stringify(log)}\n${options.holdCli ? `while [ ! -e ${JSON.stringify(releaseFile)} ]; do sleep 0.01; done\n` : ""}cat ${JSON.stringify(tokenFile)}\n`,
	);
	chmodSync(cliPath, 0o755);

	const gate = Promise.withResolvers<void>();
	const release = () => {
		writeFileSync(releaseFile, "");
		gate.resolve();
	};

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
			if (revoked.has(auth.replace(/^Bearer /, "")))
				return new Response("{}", { status: 401 });

			if (url.pathname === "/api/v3/auth/select-organization") {
				const organizationId = (body as { organizationId: string })
					.organizationId;
				if (options.mfaOrganizations?.includes(organizationId)) {
					return Response.json({ token: "x", isMfaEnabled: true });
				}
				return Response.json({
					token: sessionToken(organizationId, sessionOf(auth)),
				});
			}
			if (url.pathname === "/api/v1/auth/universal-auth/login") {
				const { clientSecret } = body as { clientSecret: string };
				return clientSecret === "right"
					? Response.json({ accessToken: "machine-token" })
					: new Response("{}", { status: 401 });
			}
			if (url.pathname === "/api/v4/secrets") {
				if (options.holdRequests) await gate.promise;
				if (options.requestDelayMs) await Bun.sleep(options.requestDelayMs);
				if (!auth.startsWith("Bearer "))
					return new Response("{}", { status: 401 });
				const projectId = url.searchParams.get("projectId") ?? "";
				if (options.forbiddenProjects?.includes(projectId))
					return new Response("{}", { status: 403 });
				const project = projects[projectId];
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
		release,
		rotateSession: () => {
			revoked.add(sessionToken(organization, session));
			session++;
			writeFileSync(tokenFile, sessionToken(organization, session));
		},
		revokeSession: () => {
			revoked.add(sessionToken(organization, session));
		},
		cliCalls: () => {
			try {
				return readFileSync(log, "utf8").trim().split("\n").filter(Boolean);
			} catch {
				return [];
			}
		},
		stop: () => {
			release();
			server.stop(true);
			rmSync(dir, { recursive: true, force: true });
		},
	};
}
