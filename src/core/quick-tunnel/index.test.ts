import { describe, expect, it } from "bun:test";
import { isRetryableQuickTunnelError } from "./index";

describe("isRetryableQuickTunnelError", () => {
	it("matches plain-text API body (invalid character 'e')", () => {
		expect(
			isRetryableQuickTunnelError(
				"failed to unmarshal quick Tunnel: invalid character 'e' looking for beginning of value",
			),
		).toBe(true);
	});

	it("matches HTTP 429 in cloudflared error text", () => {
		expect(
			isRetryableQuickTunnelError('cloudflared exited … status_code="429" …'),
		).toBe(true);
	});

	it("matches HTML error body (invalid character '<')", () => {
		expect(
			isRetryableQuickTunnelError(
				"failed to unmarshal quick Tunnel: invalid character '<' looking for beginning of value",
			),
		).toBe(true);
	});

	it("matches URL resolution timeout", () => {
		expect(
			isRetryableQuickTunnelError(
				"quick tunnel URL timed out after 30000ms (no public URL from cloudflared)",
			),
		).toBe(true);
	});

	it("does not match unrelated errors", () => {
		expect(isRetryableQuickTunnelError("connection refused")).toBe(false);
	});
});
