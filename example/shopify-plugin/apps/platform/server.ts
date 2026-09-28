// Stands in for Vite: serves the admin UI and proxies /api to the API's
// loopback URL, keeping the Host (what `buncargoVite({ proxy })` does).
const api = process.env.API_LOOPBACK_URL;
Bun.serve({
	port: Number(process.env.PORT),
	hostname: "127.0.0.1",
	async fetch(request) {
		const url = new URL(request.url);
		if (url.pathname.startsWith("/api/") && api) {
			return fetch(`${api}${url.pathname}${url.search}`, {
				headers: request.headers,
				method: request.method,
			});
		}
		return new Response("<h1>admin</h1>", {
			headers: { "content-type": "text/html" },
		});
	},
});
