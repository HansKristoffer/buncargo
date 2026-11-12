// The Supabase recipe from the readme. `requiredServices: ["supabase"]`
// compiles because the integration in this config's tuple adds that service.
// In external projects, import from "buncargo" and "buncargo/supabase".
import { defineDevConfig } from "../src";
import { supabase } from "../src/supabase";

export default defineDevConfig({
	projectPrefix: "myapp",
	services: {},
	apps: {
		web: {
			port: 5173,
			devCommand: "bun run dev",
			requiredServices: ["supabase"],
		},
	},
	integrations: [
		supabase({
			publicEnvPrefix: "VITE_",
			types: { output: "src/database.types.ts" },
		}),
	],
});
