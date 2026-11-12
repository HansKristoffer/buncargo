// The Next.js and Firebase recipe from the readme. `startAfter: ["firebase"]`
// compiles because the integration in this config's tuple adds that app.
// In external projects, import from "buncargo" and "buncargo/firebase".
import { defineDevConfig } from "../src";
import { firebase } from "../src/firebase";

export default defineDevConfig({
	projectPrefix: "myapp",
	services: {},
	apps: {
		web: {
			port: 3000,
			cwd: "apps/web",
			devCommand: "next dev",
			readyWhen: /Ready in/,
			startAfter: ["firebase"],
		},
	},
	integrations: [firebase({ publicEnvPrefix: "NEXT_PUBLIC_" })],
});
