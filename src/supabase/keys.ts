import { createHmac } from "node:crypto";

/**
 * The local stack's API keys, without asking the CLI.
 *
 * The anon and service-role keys are HS256 JWTs over fixed demo claims, signed
 * with `auth.jwt_secret`; the publishable and secret keys are constants the
 * CLI hands every local stack. Synchronous, because the env builder is.
 */

export const SUPABASE_DEFAULT_JWT_SECRET =
	"super-secret-jwt-token-with-at-least-32-characters-long";

/** The CLI's local defaults for the new-style keys. */
export const SUPABASE_PUBLISHABLE_KEY =
	"sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH";
export const SUPABASE_SECRET_KEY = "sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz";

/** The CLI's demo claims; `exp` is fixed so the keys never change. */
const DEMO_EXPIRY = 1983812996;

function base64url(value: string | Buffer): string {
	return Buffer.from(value).toString("base64url");
}

export function signSupabaseKey(
	role: "anon" | "service_role",
	secret = SUPABASE_DEFAULT_JWT_SECRET,
): string {
	const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
	const payload = base64url(
		JSON.stringify({ iss: "supabase-demo", role, exp: DEMO_EXPIRY }),
	);
	const signature = createHmac("sha256", secret)
		.update(`${header}.${payload}`)
		.digest();
	return `${header}.${payload}.${base64url(signature)}`;
}

export interface SupabaseKeys {
	anonKey: string;
	serviceRoleKey: string;
	publishableKey: string;
	secretKey: string;
}

export function supabaseKeys(jwtSecret?: string): SupabaseKeys {
	return {
		anonKey: signSupabaseKey("anon", jwtSecret),
		serviceRoleKey: signSupabaseKey("service_role", jwtSecret),
		publishableKey: SUPABASE_PUBLISHABLE_KEY,
		secretKey: SUPABASE_SECRET_KEY,
	};
}
