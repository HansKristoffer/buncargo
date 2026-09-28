// The API: what the app proxy and webhooks reach through the tunnel.
Bun.serve({
	port: Number(process.env.PORT),
	hostname: "127.0.0.1",
	fetch(request) {
		const { pathname } = new URL(request.url);
		if (pathname === "/health") return new Response("ok");
		if (pathname.startsWith("/api/")) {
			return Response.json({
				path: pathname,
				host: request.headers.get("host"),
				apiKey: process.env.SHOPIFY_API_KEY,
			});
		}
		return new Response("not found", { status: 404 });
	},
});
