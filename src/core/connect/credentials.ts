import { randomBytes } from "node:crypto";

/** Purpose prefixes prevent confusing publish, owner, and transport credentials. */
export function newCredential(kind: string): string {
	return `bc_${kind}_${randomBytes(32).toString("hex")}`;
}
