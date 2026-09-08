import { importJWK, type JWK, jwtVerify, SignJWT } from "jose";
import { ACCESS_SECONDS, identifier } from "./protocol";
export async function signCapability(
	key: JWK,
	issuer: string,
	recipient: string,
	session: string,
	target: string,
): Promise<string> {
	return new SignJWT({ target })
		.setProtectedHeader({ alg: "EdDSA", typ: "JWT" })
		.setIssuer(issuer)
		.setAudience(session)
		.setSubject(recipient)
		.setIssuedAt()
		.setExpirationTime(`${ACCESS_SECONDS}s`)
		.sign(await importJWK(key, "EdDSA"));
}
export async function verifyCapability(
	token: string,
	key: JWK,
	issuer: string,
	session: string,
	target: string,
): Promise<{ recipient: string; expiresAt: number }> {
	const { d: _, ...publicKey } = key;
	const { payload } = await jwtVerify(
		token,
		await importJWK(publicKey, "EdDSA"),
		{
			algorithms: ["EdDSA"],
			typ: "JWT",
			issuer,
			audience: session,
			maxTokenAge: `${ACCESS_SECONDS}s`,
			requiredClaims: ["iat", "exp", "sub"],
		},
	);
	if (
		payload.target !== target ||
		!identifier(payload.sub) ||
		!payload.exp ||
		!payload.iat ||
		payload.exp - payload.iat > ACCESS_SECONDS
	)
		throw new Error("Invalid connection capability");
	return { recipient: payload.sub, expiresAt: payload.exp * 1000 };
}
