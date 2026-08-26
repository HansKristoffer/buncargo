const port = Number(process.env.API_PORT) || 3000;

// The web app is served from its own hostname, so every call it makes here is
// cross-origin. WEB_URL comes from the shared env overlay in dev.config.ts.
const corsHeaders: Record<string, string> = {
	"access-control-allow-origin": process.env.WEB_URL ?? "*",
};

Bun.serve({
	port,
	fetch(req) {
		const url = new URL(req.url);

		if (req.method === "OPTIONS") {
			return new Response(null, {
				status: 204,
				headers: {
					...corsHeaders,
					"access-control-allow-methods": "GET, POST, OPTIONS",
					"access-control-allow-headers": "content-type",
				},
			});
		}

		if (url.pathname === "/health") {
			return Response.json({ ok: true }, { headers: corsHeaders });
		}

		if (url.pathname === "/api/hello") {
			return Response.json(
				{
					message: "hello from playground api",
					databaseUrlConfigured: Boolean(process.env.DATABASE_URL),
				},
				{ headers: corsHeaders },
			);
		}

		return new Response("Not found", { status: 404, headers: corsHeaders });
	},
});

console.log(`api listening on http://localhost:${port}`);
