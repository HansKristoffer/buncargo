const port = Number(process.env.API_PORT) || 3000;

Bun.serve({
	port,
	fetch(req) {
		const url = new URL(req.url);

		if (url.pathname === "/health") {
			return Response.json({ ok: true });
		}

		if (url.pathname === "/api/hello") {
			return Response.json({
				message: "hello from playground api",
				databaseUrlConfigured: Boolean(process.env.DATABASE_URL),
			});
		}

		return new Response("Not found", { status: 404 });
	},
});

console.log(`api listening on http://localhost:${port}`);
