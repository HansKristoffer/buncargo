// In this repository we import local source for accurate in-progress types.
// In external projects, use: import { defineDevConfig, service } from "buncargo";
import { defineDevConfig, service } from "../src";

export default defineDevConfig({
	projectPrefix: "custom",

	services: {
		postgres: service.postgres({
			database: "customdb",
			docker: {
				image: "postgres:16-alpine",
			},
		}),
		rabbitmq: service.custom({
			port: 5672,
			expose: true,
			healthCheck: false,
			env: {
				RABBITMQ_URL: "url",
			},
			docker: {
				image: "rabbitmq:3-management-alpine",
				ports: ["$" + "{RABBITMQ_PORT:-5672}:5672", "15672:15672"],
				environment: {
					RABBITMQ_DEFAULT_USER: "guest",
					RABBITMQ_DEFAULT_PASS: "guest",
				},
			},
		}),
		nats: service.custom({
			port: 4222,
			env: {
				NATS_URL: "url",
			},
			docker: {
				image: "nats:2-alpine",
				ports: ["$" + "{NATS_PORT:-4222}:4222"],
			},
		}),
	},

	docker: { volumes: { shared_cache: {} } },
});
