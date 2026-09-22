import { generateKeyPairSync, randomBytes } from "node:crypto";
import { withFileLock } from "../file-lock";
import { readJsonDocument, writeJsonDocument } from "../registry-file";
import { stateFilePath } from "../state-paths";
import { encodeToken, isEndpointId, record } from "./protocol";

/**
 * An iroh endpoint ID is an ed25519 public key.
 *
 * Minting the pair with node's crypto rather than iroh's is what keeps the
 * native addon out of every `buncargo connect token` and out of CLI startup;
 * only the coordinator ever loads it.
 */
export function newKeyPair(): { endpointId: string; secretKey: string } {
	const { privateKey, publicKey } = generateKeyPairSync("ed25519");
	const secret = privateKey.export({ format: "jwk" }).d;
	const id = publicKey.export({ format: "jwk" }).x;
	if (!secret || !id) {
		throw new Error("Could not create a connection identity");
	}
	return {
		endpointId: Buffer.from(id, "base64url").toString("hex"),
		secretKey: Buffer.from(secret, "base64url").toString("hex"),
	};
}

export interface ReceiverIdentity {
	endpointId: string;
	secretKey: string;
	/** Proves a publisher was given this receiver's token. */
	secret: string;
	/** Publisher endpoint IDs this receiver refuses, until it is edited by hand. */
	denied: string[];
}

export interface PublisherIdentity {
	endpointId: string;
	secretKey: string;
}

export const receiverPath = () => stateFilePath("connect-receiver.json");
export const publisherPath = () => stateFilePath("connect-publisher.json");

function parseIdentity(value: unknown): ReceiverIdentity | undefined {
	const identity = record(value);
	return isEndpointId(identity.endpointId) &&
		isEndpointId(identity.secretKey) &&
		isEndpointId(identity.secret) &&
		Array.isArray(identity.denied) &&
		identity.denied.every(isEndpointId)
		? (identity as unknown as ReceiverIdentity)
		: undefined;
}

export function readReceiver(): Promise<ReceiverIdentity | undefined> {
	return readJsonDocument(receiverPath(), parseIdentity);
}

export async function requireReceiver(): Promise<ReceiverIdentity> {
	const receiver = await readReceiver();
	if (!receiver) {
		throw new Error("Run buncargo connect token first");
	}
	return receiver;
}

export function receiverToken(receiver: ReceiverIdentity): string {
	return encodeToken({
		endpointId: receiver.endpointId,
		secret: receiver.secret,
	});
}

/** Serialize creation and rotation so concurrent bar and CLI actions keep one identity. */
export function ensureReceiver(rotate = false): Promise<ReceiverIdentity> {
	return withFileLock(receiverPath(), async () => {
		const existing = await readReceiver();
		const receiver: ReceiverIdentity = existing
			? {
					...existing,
					secret: rotate ? randomBytes(32).toString("hex") : existing.secret,
				}
			: {
					...newKeyPair(),
					secret: randomBytes(32).toString("hex"),
					denied: [],
				};
		if (!existing || rotate) {
			await writeJsonDocument(receiverPath(), receiver);
		}
		return receiver;
	});
}

/**
 * Refuse a publisher for good.
 *
 * Revocation has to outlive the connection it closes: the sandbox still holds
 * a valid token and would reconnect on its next heartbeat otherwise.
 */
export function denyPublisher(endpointId: string): Promise<ReceiverIdentity> {
	return withFileLock(receiverPath(), async () => {
		const receiver = await readReceiver();
		if (!receiver) {
			throw new Error("Run buncargo connect token first");
		}
		if (!isEndpointId(endpointId)) {
			throw new Error("Unknown remote environment");
		}
		const denied = [...new Set([...receiver.denied, endpointId])].slice(-1000);
		const updated = { ...receiver, denied };
		await writeJsonDocument(receiverPath(), updated);
		return updated;
	});
}

/** One stable publisher key per home, so a reconnect and a revocation name the same computer. */
export function ensurePublisher(): Promise<PublisherIdentity> {
	return withFileLock(publisherPath(), async () => {
		const existing = await readJsonDocument(publisherPath(), (value) => {
			const identity = record(value);
			return isEndpointId(identity.endpointId) &&
				isEndpointId(identity.secretKey)
				? (identity as unknown as PublisherIdentity)
				: undefined;
		});
		if (existing) {
			return existing;
		}
		const identity = newKeyPair();
		await writeJsonDocument(publisherPath(), identity);
		return identity;
	});
}
