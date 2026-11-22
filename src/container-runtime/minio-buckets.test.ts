import { describe, expect, it } from "bun:test";
import { resolveServices } from "../config/resolve";
import { freePorts } from "../core/test-env.testing";
import { service } from "../docker-compose/services";
import {
	ensureMinioBuckets,
	initializeReadyServices,
	minioBucketPolicyJson,
	signS3Request,
} from "./minio-buckets";

describe("signS3Request", () => {
	it("produces deterministic AWS4-HMAC-SHA256 headers", () => {
		const headers = signS3Request({
			method: "PUT",
			url: new URL("http://127.0.0.1:9000/brain?policy"),
			body: '{"Version":"2012-10-17"}',
			accessKey: "minioadmin",
			secretKey: "minioadmin",
			now: new Date("2026-11-22T12:00:00.000Z"),
		});
		expect(headers["x-amz-date"]).toBe("20261122T120000Z");
		expect(headers["x-amz-content-sha256"]).toHaveLength(64);
		expect(headers.authorization).toMatch(
			/^AWS4-HMAC-SHA256 Credential=minioadmin\/20261122\/us-east-1\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/,
		);
	});
});

describe("minioBucketPolicyJson", () => {
	it("builds download, upload and public S3 bucket policies", () => {
		const download = JSON.parse(minioBucketPolicyJson("assets", "download"));
		expect(download.Statement[0].Action).toEqual(["s3:GetObject"]);
		expect(download.Statement[0].Resource).toEqual(["arn:aws:s3:::assets/*"]);

		const upload = JSON.parse(minioBucketPolicyJson("inbox", "upload"));
		expect(upload.Statement[0].Action).toEqual(["s3:PutObject"]);

		const pub = JSON.parse(minioBucketPolicyJson("open", "public"));
		expect(pub.Statement).toHaveLength(2);
	});
});

describe("ensureMinioBuckets & initializeReadyServices", () => {
	it("creates buckets idempotently and applies or clears anonymous policies", async () => {
		const [port] = freePorts(1);
		if (!port) throw new Error("expected free port");

		const buckets = new Set<string>(["existing"]);
		const policies = new Map<string, string>();
		const requests: { method: string; path: string; auth: string | null }[] =
			[];

		const server = Bun.serve({
			hostname: "127.0.0.1",
			port,
			async fetch(req) {
				const url = new URL(req.url);
				const name = decodeURIComponent(url.pathname.slice(1));
				requests.push({
					method: req.method,
					path: `${url.pathname}${url.search}`,
					auth: req.headers.get("authorization"),
				});

				if (url.searchParams.has("policy")) {
					if (req.method === "DELETE") {
						const existed = policies.delete(name);
						return new Response(null, { status: existed ? 204 : 404 });
					}
					if (req.method === "PUT") {
						policies.set(name, await req.text());
						return new Response(null, { status: 204 });
					}
				}

				if (req.method === "PUT") {
					if (buckets.has(name)) {
						return new Response("BucketAlreadyOwnedByYou", { status: 409 });
					}
					buckets.add(name);
					return new Response(null, { status: 200 });
				}

				return new Response("Not Found", { status: 404 });
			},
		});

		try {
			const resolved = resolveServices({
				minio: service.minio({
					port,
					user: "appuser",
					password: "apppassword",
					buckets: [
						"existing",
						{ name: "private", policy: "none" },
						{ name: "uploads", policy: "download" },
					],
				}),
			});

			await initializeReadyServices(resolved, { minio: port });

			expect([...buckets].sort()).toEqual(["existing", "private", "uploads"]);
			expect(policies.has("private")).toBe(false);
			expect(JSON.parse(policies.get("uploads") ?? "{}")).toMatchObject({
				Statement: [{ Action: ["s3:GetObject"] }],
			});
			expect(
				requests.every((r) => r.auth?.includes("Credential=appuser/")),
			).toBe(true);
		} finally {
			server.stop(true);
		}
	});

	it("retries transient HTTP 503 boot responses until MinIO accepts S3 calls", async () => {
		const [port] = freePorts(1);
		if (!port) throw new Error("expected free port");

		let attempts = 0;
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port,
			fetch: () => {
				attempts++;
				if (attempts < 3) {
					return new Response("XMinioServerNotInitialized", { status: 503 });
				}
				return new Response(null, { status: 200 });
			},
		});

		try {
			await ensureMinioBuckets({
				endpoint: `http://127.0.0.1:${port}`,
				accessKey: "minioadmin",
				secretKey: "minioadmin",
				buckets: [{ name: "warm" }],
				readyTimeoutMs: 5_000,
			});
			expect(attempts).toBe(3);
		} finally {
			server.stop(true);
		}
	});

	it("surfaces an HTTP failure with the bucket name and remediation", async () => {
		const [port] = freePorts(1);
		if (!port) throw new Error("expected free port");

		const server = Bun.serve({
			hostname: "127.0.0.1",
			port,
			fetch: () => new Response("AccessDenied", { status: 403 }),
		});

		try {
			await expect(
				ensureMinioBuckets({
					endpoint: `http://127.0.0.1:${port}`,
					accessKey: "bad",
					secretKey: "creds",
					buckets: [{ name: "brain" }],
				}),
			).rejects.toThrow(
				/Failed to create bucket on MinIO bucket "brain".*HTTP 403.*AccessDenied.*service\.minio\(\)/,
			);
		} finally {
			server.stop(true);
		}
	});
});
