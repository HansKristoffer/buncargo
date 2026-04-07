import { defineConfig } from "vite";

export default defineConfig({
	server: {
		// Bind IPv4 so curl/http clients using 127.0.0.1 (and buncargo health checks) connect reliably.
		host: "127.0.0.1",
		port: Number(process.env.WEB_PORT) || 5199,
		strictPort: true,
	},
});
