# Writing an integration

An integration packages what one kind of project needs, so the project's `dev.config.ts` stays short. `buncargo/shopify` and `buncargo/expo` are the reference implementations ([`src/shopify`](../src/shopify), [`src/expo`](../src/expo)).

An integration is a plain object. A function that returns one is how options get in:

```ts
import type { BuncargoIntegration } from "buncargo";

export function stripe(options: { app: string }): BuncargoIntegration {
	return {
		name: "stripe",
		config: (config) => ({
			...config,
			apps: {
				...config.apps,
				stripeListen: {
					kind: "worker",
					devCommand: `stripe listen --forward-to "$${options.app.toUpperCase()}_LOOPBACK_URL/api/webhooks/stripe"`,
					startAfter: [options.app],
					captures: {
						webhookSecret: {
							pattern: /webhook signing secret is (whsec_\w+)/,
							as: "value",
							env: "STRIPE_WEBHOOK_SECRET",
						},
					},
					exclusive: "stripe-listen",
				},
			},
		}),
		checks: [
			{
				name: "Stripe CLI is logged in",
				fast: false,
				check: () => Bun.spawnSync(["stripe", "config", "--list"]).exitCode === 0,
				fix: "stripe login",
			},
		],
	};
}
```

## What each part does

| Member | When | Use it for |
| --- | --- | --- |
| `name` | always | Identity, and the CLI namespace: `buncargo <name> <command>` |
| `config(config)` | before validation, in `integrations` order | Adding apps, services, `env`, `generatedFiles`, `options`. What it adds is validated like the rest. Keep it pure; read files, don't start anything |
| `hooks` | beside the config's own hooks, after them | `beforeServers`, `afterServers`, `onCapture`, … |
| `checks` | `dev` (fast ones), `setup`, `doctor` | Preconditions with a fix: a command, or a function (`fixDescription` says what it does) |
| `commands` | `buncargo <name> <command>` | Operations on the running checkout. `ctx.loadEnv()` loads the config; skip it for commands that only read the run registry, as `expo sim` does |
| `describe(ctx)` | `buncargo env`, `url` / `open`, the run registry, BuncargoBar | Labelled values that are not captures, such as a dev store link built from a config file. A captured value labels itself with `label` |
| `appEnv(app)` | building one app's process env | Env for the integration's apps, beneath their own `envVars` (Expo's `RCT_METRO_PORT`) |
| `describeApp(app)` | publishing the run | Fields on an app's registry entry (Expo's `expo`, which BuncargoBar's simulator button reads) |
| `bannerHint(app)` | the startup banner | A dim hint after the app's row |

## Guidelines

- **Merge, don't replace.** `mergeConfigs(config, { apps, env })` composes `env` builders and merges groups; spreading `config.apps` keeps the user's apps. An app the user defines should win over one you add under the same name.
- **Use the primitives.** Ordering is `startAfter`, values from output are `captures` (with `label` to show them and `env` to export them), files other tools read are `generatedFiles`, one-at-a-time resources are `exclusive`, one-off builds are `prebuild`, workspaces are `discoverApps`. The Shopify integration is almost entirely these.
- **Be lenient in `config()`.** A missing file (a toml in CI, a fresh clone) should leave a working config and a failing check, not a config error that breaks every command.
- **Keep checks honest about cost.** Anything that spawns a process or calls a network is `fast: false`; `dev` runs the fast ones on every start in every worktree.
- **Name apps for profiles.** An app your integration adds can be named in `profiles` by augmenting `IntegrationAppNames`:

  ```ts
  declare module "buncargo" {
  	interface IntegrationAppNames { stripeListen: true }
  }
  ```

## The Shopify integration, as a map

- `config()` adds the `shopify` app (interactive worker, `startAfter` the frontend, backend and every extension, `captures` for `Using URL:`, the preview and GraphiQL URLs and the ready line, `exclusive` on the dev app). It adds the discovered extension watchers with their `prebuild`, the `SHOPIFY_*` env, the generated `.buncargo/shopify/web/shopify.web.toml`, and the frontend as primary app.
- `hooks.onCapture` touches theme extension assets once the CLI is ready, because it often skips the first dev-preview push.
- `checks`: CLI installed and in the tested version range, logged in, linked, `web_directories`, URL settings, API versions and tomls agreeing.
- The captures label themselves (app URL, preview, GraphiQL) and the app URL sets `SHOPIFY_APP_URL`, so `buncargo url` / `open` reach them.
- `commands`: `env`.
- `describe`: the dev store admin link for the app, and the storefront.

## The Expo integration, as a map

- `config()` resolves which apps are Expo apps (named, or those whose `devCommand` runs `expo`).
- `appEnv` gives each one `RCT_METRO_PORT` and `EXPO_PUBLIC_BUNCARGO_WORKSPACE_ID`.
- `describeApp` records the scheme and bundle id, which `sim` and BuncargoBar read without loading the config.
- `commands.sim` opens the app in this checkout's own simulator.
