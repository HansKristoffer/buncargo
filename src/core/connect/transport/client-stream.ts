import { Channel } from "./channel";
/** Opens one authenticated, renewable stream. Broken streams are never replayed. */
export async function openStream(
	endpoint: string,
	target: string,
	access: () => Promise<string>,
): Promise<Channel> {
	const capability = await access();
	const url = new URL(`${endpoint}/stream/${encodeURIComponent(target)}`);
	url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
	return new Promise((resolve, reject) => {
		const ClientSocket = WebSocket as unknown as {
			new (url: URL, options: Bun.WebSocketOptions): WebSocket;
		};
		const ws = new ClientSocket(url, {
			headers: { authorization: `Bearer ${capability}` },
		});
		ws.binaryType = "arraybuffer";
		let channel: Channel | undefined;
		let refreshing = false;
		let renew: ReturnType<typeof setInterval> | undefined;
		const timeout = setTimeout(() => {
			ws.close();
			reject(new Error("Remote connection timed out"));
		}, 10000);
		const ready = () => {
			clearTimeout(timeout);
			channel = new Channel({
				send: (data) => {
					if (ws.readyState === WebSocket.OPEN) ws.send(data);
				},
				close: () => ws.close(),
				buffered: () => ws.bufferedAmount,
			});
			renew = setInterval(() => {
				if (refreshing) return;
				refreshing = true;
				void access()
					.then((token) => {
						if (ws.readyState === WebSocket.OPEN) ws.send(token);
					})
					.catch(() => ws.close())
					.finally(() => {
						refreshing = false;
					});
			}, 20_000);
			resolve(channel);
		};
		ws.onmessage = (event) => {
			if (!channel && event.data === '{"type":"ready"}') {
				ready();
				return;
			}
			if (!(event.data instanceof ArrayBuffer)) {
				ws.close();
				return;
			}
			channel?.receive(new Uint8Array(event.data));
		};
		ws.onerror = () => {
			clearTimeout(timeout);
			reject(new Error("Remote connection failed"));
			channel?.destroy(new Error("Remote connection failed"));
		};
		ws.onclose = () => {
			clearTimeout(timeout);
			if (renew) clearInterval(renew);
			reject(new Error("Remote connection closed"));
			channel?.destroy();
		};
	});
}
