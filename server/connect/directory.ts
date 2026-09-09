import { newCredential } from "../../src/core/connect/credentials";
import {
	type Assignment,
	LEASE_MS,
	type PublicationLease,
	parseRun,
	type Relay,
	type RemoteRun,
	type RunInput,
	ready,
	type VisitorLease,
} from "../../src/core/connect/protocol";
import { hash, identifier, type Store } from "./store";

interface ReceiverRecord {
	id: string;
	ownerHash: string;
	tokenHash: string;
}

interface Publication {
	id: string;
	credential: string;
	credentialHash: string;
	run: RunInput;
	expires: number;
	confirmed: string[];
	recipients: string[];
	revoked: string[];
	assignments: Assignment[];
	rejectedRecipients: number;
}

interface Visitor {
	credentialHash: string;
	publication: string;
	receiver: string;
	assignment: string;
	expires: number;
}

export class DirectoryError extends Error {
	constructor(
		message: string,
		readonly status = 400,
	) {
		super(message);
	}
}

function requireValue<T>(
	value: T | undefined | null | false,
	message = "Not authorized",
): T {
	if (!value) {
		throw new DirectoryError(message, 403);
	}
	return value;
}

/** The synchronous transaction boundary prevents concurrent grants/heartbeats from undoing revocation. */
export class ConnectionDirectory {
	constructor(
		readonly store: Store,
		readonly origin: string,
		readonly relay: Relay,
		readonly now = Date.now,
	) {}

	createReceiver() {
		if (this.store.list("receivers").length >= 1000) {
			throw new DirectoryError("Receiver quota reached", 429);
		}

		const id = identifier();
		const owner = newCredential("owner");
		const token = newCredential("share");

		this.store.set("receivers", id, {
			id,
			ownerHash: hash(owner),
			tokenHash: hash(token),
		} satisfies ReceiverRecord);
		return { id, owner, token, origin: this.origin };
	}

	private receiver(owner: string) {
		const ownerHash = hash(owner);
		return requireValue(
			this.store
				.list<ReceiverRecord>("receivers")
				.find((receiver) => receiver.ownerHash === ownerHash),
		);
	}

	deleteReceiver(owner: string) {
		const receiver = this.receiver(owner);
		for (const publication of this.store.list<Publication>("publications")) {
			if (publication.recipients.includes(receiver.id)) {
				publication.revoked.push(receiver.id);
				this.reconcile(publication);
				this.store.set("publications", publication.id, publication);
			}
		}
		this.store.delete("receivers", receiver.id);
	}

	rotate(owner: string) {
		const receiver = this.receiver(owner);
		const token = newCredential("share");
		receiver.tokenHash = hash(token);
		this.store.set("receivers", receiver.id, receiver);
		return { token };
	}

	register(tokens: string[], input: unknown, credential: string) {
		const run = parseRun(input);
		if (!/^bc_pub_[a-f0-9]{64}$/.test(credential)) {
			throw new DirectoryError("Invalid publication credential");
		}
		const existing = this.store
			.list<Publication>("publications")
			.find((publication) => publication.credentialHash === hash(credential));
		if (existing) {
			if (existing.run.sessionId !== run.sessionId) {
				throw new DirectoryError("Publication conflict", 409);
			}
			return this.update(existing.id, credential, run);
		}
		if (!tokens.length || tokens.length > 16) {
			throw new DirectoryError("Provide 1–16 recipient tokens");
		}
		const receivers = this.store.list<ReceiverRecord>("receivers");
		const recipients = [
			...new Set(
				tokens
					.map(
						(token) =>
							receivers.find((receiver) => receiver.tokenHash === hash(token))
								?.id,
					)
					.filter((id): id is string => !!id),
			),
		];
		requireValue(recipients.length, "No recipient tokens were accepted");
		const publications = this.store.list<Publication>("publications");
		if (
			publications.length >= 1000 ||
			recipients.some(
				(id) =>
					publications.filter((publication) =>
						publication.recipients.includes(id),
					).length >= 100,
			)
		) {
			throw new DirectoryError("Publication quota reached", 429);
		}
		const publication: Publication = {
			id: identifier(),
			credential,
			credentialHash: hash(credential),
			run,
			recipients,
			revoked: [],
			confirmed: [],
			expires: this.now() + LEASE_MS,
			assignments: [],
			rejectedRecipients: tokens.length - recipients.length,
		};

		this.reconcile(publication);
		this.store.set("publications", publication.id, publication);

		return this.lease(publication);
	}

	private publication(id: string, credential: string) {
		const publication = this.store.get<Publication>("publications", id);
		return requireValue(
			publication &&
				publication.credentialHash === hash(credential) &&
				publication,
		);
	}

	update(
		id: string,
		credential: string,
		input: unknown,
		confirmed: string[] = [],
	) {
		const publication = this.publication(id, credential);
		const run = parseRun(input);
		if (publication.run.sessionId !== run.sessionId) {
			throw new DirectoryError("Publication identity changed", 409);
		}

		publication.run = run;
		publication.confirmed = confirmed;
		publication.expires = this.now() + LEASE_MS;

		this.reconcile(publication);
		this.store.set("publications", publication.id, publication);

		return this.lease(publication);
	}

	retire(id: string, credential: string) {
		this.publication(id, credential);
		this.store.delete("publications", id);
	}

	revoke(owner: string, id: string) {
		const receiver = this.receiver(owner);
		const publication = requireValue(
			this.store.get<Publication>("publications", id),
		);
		requireValue(publication.recipients.includes(receiver.id));
		if (!publication.revoked.includes(receiver.id)) {
			publication.revoked.push(receiver.id);
		}

		this.reconcile(publication);
		this.store.set("publications", id, publication);
		return { pending: true, cutoffMs: LEASE_MS };
	}

	private reconcile(publication: Publication) {
		const recipients = publication.recipients.filter(
			(id) => !publication.revoked.includes(id),
		);
		const publicRecipient = recipients.length ? [undefined] : [];
		const assignments: Assignment[] = [];
		for (const target of publication.run.targets.filter((target) =>
			ready(target.status),
		)) {
			// Public HTTP uses one route; private TCP gets a separate secret and gate per recipient.
			const receiverIds =
				target.protocol === "tcp" ? recipients : publicRecipient;
			for (const receiverId of receiverIds) {
				const old = publication.assignments.find(
					(assignment) =>
						assignment.targetId === target.id &&
						assignment.receiverId === receiverId &&
						assignment.protocol === target.protocol,
				);
				const id = old?.id ?? identifier();
				assignments.push(
					old ?? {
						id,
						targetId: target.id,
						protocol: target.protocol,
						receiverId,
						...(target.protocol === "http"
							? { subdomain: id }
							: { secretKey: newCredential("tcp") }),
					},
				);
			}
		}
		publication.assignments = assignments;
	}

	private lease(publication: Publication): PublicationLease {
		return {
			id: publication.id,
			credential: publication.credential,
			user: publication.id,
			relay: this.relay,
			remainingMs: Math.max(0, publication.expires - this.now()),
			assignments: publication.assignments,
			rejectedRecipients: publication.rejectedRecipients,
		};
	}

	private remoteRun(publication: Publication, receiverId: string): RemoteRun {
		const targets: RemoteRun["targets"] = publication.run.targets
			.map((target) => {
				const assignment = publication.assignments.find(
					(assignment) =>
						assignment.targetId === target.id &&
						(assignment.protocol === "http" ||
							assignment.receiverId === receiverId),
				);
				const base = new URL(this.origin);
				if (assignment?.subdomain) {
					base.hostname = `${assignment.subdomain}.${base.hostname}`;
				}
				// Connection credentials are returned only by the authenticated visitor endpoint.
				return {
					...target,
					id: `${publication.id}.${target.id}`,
					tablePlusUrl: undefined,
					status: assignment
						? publication.confirmed.includes(assignment.id)
							? target.status
							: "starting"
						: "stopped",
					url:
						target.protocol === "http" && assignment ? `${base.origin}/` : "",
				};
			})
			.filter((target) => target.protocol !== "http" || target.url !== "");
		return {
			...publication.run,
			sessionId: publication.id,
			targets,
			primaryApp: targets.some(
				(target) =>
					target.kind === "app" && target.name === publication.run.primaryApp,
			)
				? publication.run.primaryApp
				: undefined,
		};
	}

	private canReceive(publication: Publication, receiverId: string): boolean {
		return (
			publication.expires > this.now() &&
			publication.recipients.includes(receiverId) &&
			!publication.revoked.includes(receiverId)
		);
	}

	list(owner: string) {
		const receiver = this.receiver(owner);
		return {
			version: 1,
			configured: true,
			origin: this.origin,
			generatedAt: this.now(),
			runs: this.store
				.list<Publication>("publications")
				.filter((publication) => this.canReceive(publication, receiver.id))
				.map((publication) => this.remoteRun(publication, receiver.id)),
		};
	}

	visitor(owner: string, targetId: string): VisitorLease {
		const receiver = this.receiver(owner);
		const dot = targetId.indexOf(".");
		const publication = requireValue(
			this.store.get<Publication>("publications", targetId.slice(0, dot)),
		);
		requireValue(this.canReceive(publication, receiver.id));
		const assignment = requireValue(
			publication.assignments.find(
				(assignment) =>
					assignment.targetId === targetId.slice(dot + 1) &&
					assignment.receiverId === receiver.id,
			),
		);
		const target = requireValue(
			publication.run.targets.find(
				(target) =>
					target.id === assignment.targetId &&
					target.protocol === "tcp" &&
					ready(target.status),
			),
		);
		const credential = newCredential("visit");
		const key = hash(credential);
		// One active visitor identity per receiver/target avoids unbounded credential retention.
		for (const old of this.store.list<Visitor>("visitors")) {
			if (old.receiver === receiver.id && old.assignment === assignment.id) {
				this.store.delete("visitors", old.credentialHash);
			}
		}
		this.store.set("visitors", key, {
			credentialHash: key,
			publication: publication.id,
			receiver: receiver.id,
			assignment: assignment.id,
			expires: this.now() + LEASE_MS,
		} satisfies Visitor);
		return {
			credential,
			user: publication.id,
			relay: this.relay,
			proxyName: assignment.id,
			secretKey: requireValue(assignment.secretKey),
			remainingMs: LEASE_MS,
			target: { ...target, id: targetId, url: "" },
		};
	}

	renewVisitor(credential: string) {
		const visitor = requireValue(
			this.store.get<Visitor>("visitors", hash(credential)),
		);
		const publication = this.activeVisitor(visitor);
		visitor.expires = this.now() + LEASE_MS;
		this.store.set("visitors", visitor.credentialHash, visitor);
		return {
			remainingMs: Math.min(LEASE_MS, publication.expires - this.now()),
		};
	}

	private activeVisitor(visitor: Visitor) {
		const publication = requireValue(
			this.store.get<Publication>("publications", visitor.publication),
		);
		requireValue(
			publication.expires > this.now() &&
				visitor.expires > this.now() &&
				!publication.revoked.includes(visitor.receiver) &&
				publication.assignments.some(
					(assignment) => assignment.id === visitor.assignment,
				),
		);
		return publication;
	}

	/** Return the authenticated role; client-provided user/metas never define authorization. */
	session(credential: string) {
		const credentialHash = hash(credential);
		const publication = this.store
			.list<Publication>("publications")
			.find((publication) => publication.credentialHash === credentialHash);
		if (publication && publication.expires > this.now()) {
			return { role: "publisher" as const, publication };
		}
		const visitor = requireValue(
			this.store.get<Visitor>("visitors", credentialHash),
		);
		return {
			role: "visitor" as const,
			publication: this.activeVisitor(visitor),
		};
	}

	collect() {
		for (const publication of this.store.list<Publication>("publications")) {
			if (publication.expires < this.now() - 86_400_000) {
				this.store.delete("publications", publication.id);
			}
		}
		for (const visitor of this.store.list<Visitor>("visitors")) {
			if (visitor.expires < this.now()) {
				this.store.delete("visitors", visitor.credentialHash);
			}
		}
	}

	invalidateLeases() {
		for (const publication of this.store.list<Publication>("publications")) {
			publication.expires = 0;
			this.store.set("publications", publication.id, publication);
		}
		for (const visitor of this.store.list<Visitor>("visitors")) {
			this.store.delete("visitors", visitor.credentialHash);
		}
	}
}
