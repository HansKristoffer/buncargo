import { createHash, createHmac } from "node:crypto";
import { getErrorMessage, typedSwitch } from "hanzio";
import { abortableSleep } from "../core/deadline";
import type {
	MinioBucketPolicy,
	ResolvedMinioBucket,
	ResolvedService,
} from "../types";

const DEFAULT_REGION = "us-east-1";
const SERVICE_NAME = "s3";
const REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_READY_TIMEOUT_MS = 10_000;
const INITIAL_RETRY_MS = 50;
const MAX_RETRY_MS = 500;

function sha256Hex(data: string): string {
	return createHash("sha256").update(data).digest("hex");
}

function hmac(key: Buffer | string, data: string): Buffer {
	return createHmac("sha256", key).update(data).digest();
}

function amzDate(now: Date): { amzDate: string; dateStamp: string } {
	const iso = now
		.toISOString()
		.replace(/[-:]/g, "")
		.replace(/\.\d{3}Z$/, "Z");
	return { amzDate: iso, dateStamp: iso.slice(0, 8) };
}

function compareCodePoint(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * AWS Signature Version 4 headers for a single S3 request to MinIO.
 * Pure, dependency-free, and tested directly against a local HTTP server.
 */
export function signS3Request(input: {
	method: "PUT" | "DELETE";
	url: URL;
	body?: string;
	accessKey: string;
	secretKey: string;
	now?: Date;
}): Record<string, string> {
	const body = input.body ?? "";
	const payloadHash = sha256Hex(body);
	const { amzDate: timestamp, dateStamp } = amzDate(input.now ?? new Date());
	const host = input.url.host;

	// AWS SigV4 sorts canonical query entries by UTF-8 code point (key, then value)
	// and preserves `=` even for valueless keys like `?policy`.
	const canonicalQuery = [...input.url.searchParams.entries()]
		.map(
			([key, value]) =>
				[encodeURIComponent(key), encodeURIComponent(value)] as const,
		)
		.sort(
			([keyA, valA], [keyB, valB]) =>
				compareCodePoint(keyA, keyB) || compareCodePoint(valA, valB),
		)
		.map(([key, value]) => `${key}=${value}`)
		.join("&");

	const headers: Record<string, string> = {
		host,
		"x-amz-content-sha256": payloadHash,
		"x-amz-date": timestamp,
	};
	const signedNames = Object.keys(headers).sort(compareCodePoint);
	const canonicalHeaders = signedNames
		.map((name) => `${name}:${headers[name]}\n`)
		.join("");
	const signedHeaders = signedNames.join(";");

	const canonicalRequest = [
		input.method,
		input.url.pathname,
		canonicalQuery,
		canonicalHeaders,
		signedHeaders,
		payloadHash,
	].join("\n");

	const scope = `${dateStamp}/${DEFAULT_REGION}/${SERVICE_NAME}/aws4_request`;
	const stringToSign = [
		"AWS4-HMAC-SHA256",
		timestamp,
		scope,
		sha256Hex(canonicalRequest),
	].join("\n");

	const kDate = hmac(`AWS4${input.secretKey}`, dateStamp);
	const kRegion = hmac(kDate, DEFAULT_REGION);
	const kService = hmac(kRegion, SERVICE_NAME);
	const kSigning = hmac(kService, "aws4_request");
	const signature = createHmac("sha256", kSigning)
		.update(stringToSign)
		.digest("hex");

	return {
		"x-amz-content-sha256": payloadHash,
		"x-amz-date": timestamp,
		authorization: `AWS4-HMAC-SHA256 Credential=${input.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
	};
}

/** S3 bucket policy JSON matching MinIO's `mc anonymous set <policy>`. */
export function minioBucketPolicyJson(
	bucket: string,
	policy: Exclude<MinioBucketPolicy, "none">,
): string {
	const objectArn = `arn:aws:s3:::${bucket}/*`;
	const bucketArn = `arn:aws:s3:::${bucket}`;
	const statements = typedSwitch(policy, {
		download: () => [
			{
				Effect: "Allow",
				Principal: { AWS: ["*"] },
				Action: ["s3:GetObject"],
				Resource: [objectArn],
			},
		],
		upload: () => [
			{
				Effect: "Allow",
				Principal: { AWS: ["*"] },
				Action: ["s3:PutObject"],
				Resource: [objectArn],
			},
		],
		public: () => [
			{
				Effect: "Allow",
				Principal: { AWS: ["*"] },
				Action: ["s3:GetBucketLocation", "s3:ListBucket"],
				Resource: [bucketArn],
			},
			{
				Effect: "Allow",
				Principal: { AWS: ["*"] },
				Action: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
				Resource: [objectArn],
			},
		],
	});

	return JSON.stringify({ Version: "2012-10-17", Statement: statements });
}

function formatS3Error(input: {
	action: string;
	bucket: string;
	endpoint: string;
	status: number;
	detail: string;
}): string {
	const suffix = input.detail ? ` (${input.detail.slice(0, 200)})` : "";
	return `Failed to ${input.action} on MinIO bucket "${input.bucket}" at ${input.endpoint}: HTTP ${input.status}${suffix}. Check user/password on service.minio() and S3 bucket naming rules.`;
}

async function readErrorDetail(response: Response): Promise<string> {
	return (await response.text().catch(() => "")).trim();
}

/**
 * Send one signed S3 request, retrying transient boot errors (connection resets
 * right after TCP port bind or HTTP 503 while MinIO finishes initializing) up
 * to `readyTimeoutMs`.
 */
async function s3Call(input: {
	method: "PUT" | "DELETE";
	url: URL;
	body?: string;
	accessKey: string;
	secretKey: string;
	readyTimeoutMs: number;
	signal?: AbortSignal;
}): Promise<Response> {
	const deadline = Date.now() + input.readyTimeoutMs;
	let delayMs = INITIAL_RETRY_MS;
	let lastError: unknown;

	for (;;) {
		input.signal?.throwIfAborted();
		const headers = signS3Request(input);
		if (input.body !== undefined) headers["content-type"] = "application/json";

		const remaining = Math.max(1, deadline - Date.now());
		const timeout = AbortSignal.timeout(
			Math.min(REQUEST_TIMEOUT_MS, remaining),
		);
		const signal = input.signal
			? AbortSignal.any([input.signal, timeout])
			: timeout;

		try {
			const response = await fetch(input.url, {
				method: input.method,
				headers,
				body: input.body,
				signal,
			});
			if (response.status !== 503 || Date.now() >= deadline) {
				return response;
			}
			// Drain body before retrying so the keep-alive socket can be reused.
			await response.text().catch(() => {});
		} catch (error) {
			input.signal?.throwIfAborted();
			lastError = error;
			if (Date.now() >= deadline) {
				const reason = getErrorMessage(lastError);
				const message = `Could not reach MinIO at ${input.url.origin} to configure buckets: ${reason}. Verify the minio container is running and reachable.`;
				throw new Error(message);
			}
		}

		const waitMs = Math.min(delayMs, Math.max(1, deadline - Date.now()));
		await abortableSleep(waitMs, input.signal);
		delayMs = Math.min(MAX_RETRY_MS, delayMs * 2);
	}
}

/**
 * Create every configured bucket on a running MinIO instance and apply its
 * anonymous access policy when requested. Idempotent across warm restarts.
 */
export async function ensureMinioBuckets(input: {
	endpoint: string;
	accessKey: string;
	secretKey: string;
	buckets: readonly ResolvedMinioBucket[];
	readyTimeoutMs?: number;
	signal?: AbortSignal;
}): Promise<void> {
	const base = input.endpoint.replace(/\/+$/, "");
	const readyTimeoutMs = input.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;

	await Promise.all(
		input.buckets.map(async (bucket) => {
			const encoded = encodeURIComponent(bucket.name);
			const bucketUrl = new URL(`${base}/${encoded}`);

			const created = await s3Call({
				method: "PUT",
				url: bucketUrl,
				accessKey: input.accessKey,
				secretKey: input.secretKey,
				readyTimeoutMs,
				signal: input.signal,
			});
			// 200/204: created; 409: BucketAlreadyOwnedByYou / BucketAlreadyExists.
			if (!created.ok && created.status !== 409) {
				const message = formatS3Error({
					action: "create bucket",
					bucket: bucket.name,
					endpoint: base,
					status: created.status,
					detail: await readErrorDetail(created),
				});
				throw new Error(message);
			}

			if (!bucket.policy) return;
			const policyUrl = new URL(`${base}/${encoded}?policy`);
			if (bucket.policy === "none") {
				const cleared = await s3Call({
					method: "DELETE",
					url: policyUrl,
					accessKey: input.accessKey,
					secretKey: input.secretKey,
					readyTimeoutMs,
					signal: input.signal,
				});
				if (!cleared.ok && cleared.status !== 404) {
					const message = formatS3Error({
						action: "clear anonymous policy",
						bucket: bucket.name,
						endpoint: base,
						status: cleared.status,
						detail: await readErrorDetail(cleared),
					});
					throw new Error(message);
				}
				return;
			}

			const applied = await s3Call({
				method: "PUT",
				url: policyUrl,
				body: minioBucketPolicyJson(bucket.name, bucket.policy),
				accessKey: input.accessKey,
				secretKey: input.secretKey,
				readyTimeoutMs,
				signal: input.signal,
			});
			if (!applied.ok) {
				const message = formatS3Error({
					action: `set "${bucket.policy}" policy`,
					bucket: bucket.name,
					endpoint: base,
					status: applied.status,
					detail: await readErrorDetail(applied),
				});
				throw new Error(message);
			}
		}),
	);
}

/** Run built-in post-readiness initializers for services that declare them. */
export async function initializeReadyServices(
	services: Record<string, ResolvedService>,
	ports: Readonly<Record<string, number>>,
	options: { signal?: AbortSignal } = {},
): Promise<void> {
	const tasks: Promise<void>[] = [];

	for (const [serviceKey, config] of Object.entries(services)) {
		if (config.preset !== "minio" || !config.buckets?.length) continue;
		const port = ports[serviceKey];
		if (port === undefined) continue;

		const accessKey = String(config.staticEnv?.MINIO_ROOT_USER ?? "minioadmin");
		const secretKey = String(
			config.staticEnv?.MINIO_ROOT_PASSWORD ?? "minioadmin",
		);
		tasks.push(
			ensureMinioBuckets({
				endpoint: `http://127.0.0.1:${port}`,
				accessKey,
				secretKey,
				buckets: config.buckets,
				readyTimeoutMs: config.healthTimeout ?? DEFAULT_READY_TIMEOUT_MS,
				signal: options.signal,
			}),
		);
	}

	if (tasks.length > 0) await Promise.all(tasks);
}
