// In this repository we import local source for accurate in-progress types.
// In external projects, use: import { defineDevConfig, service } from "buncargo";
import { defineDevConfig, service } from "../src";

export default defineDevConfig({
	projectPrefix: "myapp",

	services: {
		postgres: service.postgres({ database: "myapp", expose: true }),
	},
});
