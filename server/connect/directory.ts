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
import { capability, hash, identifier, type Store } from "./store";

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
	if (!value) throw new DirectoryError(message, 403);
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
		if (this.store.list("receivers").length >= 1000)
			throw new DirectoryError("Receiver quota reached", 429);
		const id = identifier(),
			owner = capability("owner"),
			token = capability("share");
		this.store.set("receivers", id, {
			id,
			ownerHash: hash(owner),
			tokenHash: hash(token),
		} satisfies ReceiverRecord);
		return { id, owner, token, origin: this.origin };
	}
	private receiver(owner: string) {
		return requireValue(
			this.store
				.list<ReceiverRecord>("receivers")
				.find((r) => r.ownerHash === hash(owner)),
		);
	}
	deleteReceiver(owner: string) {
		const r = this.receiver(owner);
		for (const p of this.store.list<Publication>("publications")) {
			if (p.recipients.includes(r.id)) {
				p.revoked.push(r.id);
				this.reconcile(p);
				this.store.set("publications", p.id, p);
			}
		}
		this.store.delete("receivers", r.id);
	}

	rotate(owner: string) {
		const r = this.receiver(owner),
			token = capability("share");
		r.tokenHash = hash(token);
		this.store.set("receivers", r.id, r);
		return { token };
	}
	register(tokens: string[], input: unknown, credential: string) {
		const run = parseRun(input);
		if (!/^bc_pub_[a-f0-9]{64}$/.test(credential))
			throw new DirectoryError("Invalid publication credential");
		const existing = this.store
			.list<Publication>("publications")
			.find((p) => p.credentialHash === hash(credential));
		if (existing) {
			if (existing.run.sessionId !== run.sessionId)
				throw new DirectoryError("Publication conflict", 409);
			return this.update(existing.id, credential, run);
		}
		if (!tokens.length || tokens.length > 16)
			throw new DirectoryError("Provide 1–16 recipient tokens");
		const receivers = this.store.list<ReceiverRecord>("receivers");
		const recipients = [
			...new Set(
				tokens
					.map((t) => receivers.find((r) => r.tokenHash === hash(t))?.id)
					.filter((id): id is string => !!id),
			),
		];
		requireValue(recipients.length, "No recipient tokens were accepted");
		const publications = this.store.list<Publication>("publications");
		if (
			publications.length >= 1000 ||
			recipients.some(
				(id) =>
					publications.filter((p) => p.recipients.includes(id)).length >= 100,
			)
		)
			throw new DirectoryError("Publication quota reached", 429);
		const p: Publication = {
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
		this.reconcile(p);
		this.store.set("publications", p.id, p);
		return this.lease(p);
	}
	private publication(id: string, credential: string) {
		const p = this.store.get<Publication>("publications", id);
		return requireValue(p && p.credentialHash === hash(credential) && p);
	}
	update(
		id: string,
		credential: string,
		input: unknown,
		confirmed: string[] = [],
	) {
		const p = this.publication(id, credential),
			run = parseRun(input);
		if (p.run.sessionId !== run.sessionId)
			throw new DirectoryError("Publication identity changed", 409);
		p.run = run;
		p.confirmed = confirmed;
		p.expires = this.now() + LEASE_MS;
		this.reconcile(p);
		this.store.set("publications", p.id, p);
		return this.lease(p);
	}
	retire(id: string, credential: string) {
		this.publication(id, credential);
		this.store.delete("publications", id);
	}
	revoke(owner: string, id: string) {
		const r = this.receiver(owner),
			p = requireValue(this.store.get<Publication>("publications", id));
		requireValue(p.recipients.includes(r.id));
		if (!p.revoked.includes(r.id)) p.revoked.push(r.id);
		this.reconcile(p);
		this.store.set("publications", id, p);
		return { pending: true, cutoffMs: LEASE_MS };
	}
	private reconcile(p: Publication) {
		const assignments: Assignment[] = [];
		for (const t of p.run.targets.filter((t) => ready(t.status))) {
			for (const receiverId of t.protocol === "tcp"
				? p.recipients.filter((id) => !p.revoked.includes(id))
				: p.recipients.some((id) => !p.revoked.includes(id))
					? [undefined]
					: []) {
				const old = p.assignments.find(
					(a) =>
						a.targetId === t.id &&
						a.receiverId === receiverId &&
						a.protocol === t.protocol,
				);
				const id = old?.id ?? identifier();
				assignments.push(
					old ?? {
						id,
						targetId: t.id,
						protocol: t.protocol,
						receiverId,
						...(t.protocol === "http"
							? { subdomain: id }
							: { secretKey: capability("tcp") }),
					},
				);
			}
		}
		p.assignments = assignments;
	}
	private lease(p: Publication): PublicationLease {
		return {
			id: p.id,
			credential: p.credential,
			user: p.id,
			relay: this.relay,
			remainingMs: Math.max(0, p.expires - this.now()),
			assignments: p.assignments,
			rejectedRecipients: p.rejectedRecipients,
		};
	}
	private remoteRun(p: Publication): RemoteRun {
		return {
			...p.run,
			sessionId: p.id,
			targets: p.run.targets
				.map((t) => {
					const a = p.assignments.find((a) => a.targetId === t.id);
					const base = new URL(this.origin);
					if (a?.subdomain) base.hostname = `${a.subdomain}.${base.hostname}`;
					// Connection credentials are returned only by the authenticated visitor endpoint.
					return {
						...t,
						id: `${p.id}.${t.id}`,
						tablePlusUrl: undefined,
						status: a
							? p.confirmed.includes(`${p.id}.${a.id}`)
								? t.status
								: "starting"
							: "stopped",
						url: t.protocol === "http" && a ? `${base.origin}/` : "",
					};
				})
				.filter((t) => t.protocol !== "http" || t.url !== ""),
		};
	}
	list(owner: string) {
		const r = this.receiver(owner);
		return {
			version: 1,
			configured: true,
			origin: this.origin,
			generatedAt: this.now(),
			runs: this.store
				.list<Publication>("publications")
				.filter(
					(p) =>
						p.expires > this.now() &&
						p.recipients.includes(r.id) &&
						!p.revoked.includes(r.id),
				)
				.map((p) => this.remoteRun(p)),
		};
	}
	visitor(owner: string, targetId: string): VisitorLease {
		const r = this.receiver(owner),
			dot = targetId.indexOf("."),
			p = requireValue(
				this.store.get<Publication>("publications", targetId.slice(0, dot)),
			);
		requireValue(
			p.expires > this.now() &&
				p.recipients.includes(r.id) &&
				!p.revoked.includes(r.id),
		);
		const a = requireValue(
			p.assignments.find(
				(a) => a.targetId === targetId.slice(dot + 1) && a.receiverId === r.id,
			),
		);
		const t = requireValue(
			p.run.targets.find(
				(t) => t.id === a.targetId && t.protocol === "tcp" && ready(t.status),
			),
		);
		const credential = capability("visit"),
			key = hash(credential);
		// One active visitor identity per receiver/target avoids unbounded credential retention.
		for (const old of this.store.list<Visitor>("visitors"))
			if (old.receiver === r.id && old.assignment === a.id)
				this.store.delete("visitors", old.credentialHash);
		this.store.set("visitors", key, {
			credentialHash: key,
			publication: p.id,
			receiver: r.id,
			assignment: a.id,
			expires: this.now() + LEASE_MS,
		} satisfies Visitor);
		return {
			credential,
			user: p.id,
			relay: this.relay,
			proxyName: a.id,
			secretKey: requireValue(a.secretKey),
			remainingMs: LEASE_MS,
			target: { ...t, id: targetId, url: "" },
		};
	}
	renewVisitor(credential: string) {
		const v = requireValue(
				this.store.get<Visitor>("visitors", hash(credential)),
			),
			p = this.activeVisitor(v);
		v.expires = this.now() + LEASE_MS;
		this.store.set("visitors", v.credentialHash, v);
		return { remainingMs: Math.min(LEASE_MS, p.expires - this.now()) };
	}
	private activeVisitor(v: Visitor) {
		const p = requireValue(
			this.store.get<Publication>("publications", v.publication),
		);
		requireValue(
			p.expires > this.now() &&
				v.expires > this.now() &&
				!p.revoked.includes(v.receiver) &&
				p.assignments.some((a) => a.id === v.assignment),
		);
		return p;
	}
	/** Return the authenticated role; client-provided user/metas never define authorization. */
	session(credential: string) {
		const p = this.store
			.list<Publication>("publications")
			.find((p) => p.credentialHash === hash(credential));
		if (p && p.expires > this.now())
			return { role: "publisher" as const, publication: p };
		const v = requireValue(
			this.store.get<Visitor>("visitors", hash(credential)),
		);
		return { role: "visitor" as const, publication: this.activeVisitor(v) };
	}
	collect() {
		for (const p of this.store.list<Publication>("publications"))
			if (p.expires < this.now() - 86_400_000)
				this.store.delete("publications", p.id);
		for (const v of this.store.list<Visitor>("visitors"))
			if (v.expires < this.now())
				this.store.delete("visitors", v.credentialHash);
	}
	invalidateLeases() {
		for (const p of this.store.list<Publication>("publications")) {
			p.expires = 0;
			this.store.set("publications", p.id, p);
		}
		for (const v of this.store.list<Visitor>("visitors"))
			this.store.delete("visitors", v.credentialHash);
	}
}
