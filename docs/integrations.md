# Writing an integration

An integration packages what one kind of project needs, so the project's `dev.config.ts` stays short. `buncargo/shopify`, `buncargo/expo`, `buncargo/supabase` and `buncargo/firebase` are the reference implementations ([`src/shopify`](../src/shopify), [`src/expo`](../src/expo), [`src/supabase`](../src/supabase), [`src/firebase`](../src/firebase)).

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
| `config(config, { root })` | before validation, in `integrations` order | Adding apps, services, `env`, `generatedFiles`, `options`. What it adds is validated like the rest. Keep it pure; read files relative to `root` (the checkout, not the working directory), don't start anything |
| `hooks` | beside the config's own hooks, after them | `beforeServers`, `afterServers`, `onCapture`, … |
| `checks` | `dev` (fast ones), `setup`, `doctor` | Preconditions with a fix: a command, or a function (`fixDescription` says what it does) |
| `preflight` | `dev`, with the terminal, before anything starts | Steps that may need the user, such as a login. `apps` limits a step to starts that select one of them; `ctx.interactive` is false in CI and without a terminal; a step that throws stops the start |
| `commands` | `buncargo <name> <command>` | Operations on the running checkout. `ctx.loadEnv()` loads the config; skip it for commands that only read the run registry, as `expo sim` does |
| `describe(ctx)` | `buncargo env`, `url` / `open`, the run registry, BuncargoBar | Labelled values that are not captures, such as a dev store link built from a config file. A captured value labels itself with `label` |
| `appEnv(app)` | building one app's process env | Env for the integration's apps, beneath their own `envVars` (Expo's `RCT_METRO_PORT`) |
| `describeApp(app)` | publishing the run | Fields on an app's registry entry (Expo's `expo`, which BuncargoBar's simulator button reads) |
| `bannerHint(app)` | the startup banner | A dim hint after the app's row |
| `stacks` | a start that selects one of its services; `stop`; the sweep | Containers another CLI runs. `up(ctx)` starts them idempotently beside `compose up`; `down(...)` returns the argv that stops them, which is recorded in the run registry so the sweep can run it after the idle hold without a config. Services name it with `external: { stack }`. The CLI must label its containers `com.docker.compose.project=<externalStackProjectName(projectName)>`, or their ports read as foreign |

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

- `config()` adds the `shopify` app (a non-essential worker, `startAfter` the frontend, backend and every extension, `captures` for `Using URL:`, the preview and GraphiQL URLs and the ready line, `exclusive` on the dev app). It adds the discovered extension watchers with their `prebuild`, the `SHOPIFY_*` env, the generated `.buncargo/shopify/web/shopify.web.toml`, and the frontend as primary app.
- `hooks.onCapture` touches theme extension assets once the CLI is ready, because it often skips the first dev-preview push.
- `checks`: CLI installed and in the tested version range, logged in, linked, `web_directories`, URL settings, API versions and tomls agreeing.
- `preflight`: when the `shopify` app is selected, renews an expired CLI session with the terminal before anything starts.
- The captures label themselves (app URL, preview, GraphiQL) and the app URL sets `SHOPIFY_APP_URL`, so `buncargo url` / `open` reach them.
- `commands`: `login`, `link` (a toml to a dev app, keeping its scopes, webhooks and dev store) and `env`.
- `describe`: the dev store admin link for the app, and the storefront.

## The Expo integration, as a map

- `config()` resolves which apps are Expo apps (named, or those whose `devCommand` runs `expo`).
- `appEnv` gives each one `RCT_METRO_PORT` and `EXPO_PUBLIC_BUNCARGO_WORKSPACE_ID`.
- `describeApp` records the scheme and bundle id, which `sim` and BuncargoBar read without loading the config.
- `commands.sim` opens the app in this checkout's own simulator.

## The Supabase integration, as a map

- `config()` reads `supabase/config.toml` leniently and adds `supabase`, `supabaseDb`, `supabaseStudio` and `supabaseMail` as external services of the `supabase` stack (only the enabled, non-excluded ones). Its env builder sets the `SUPABASE_*` overrides the CLI reads instead of the toml (project id, every port, `auth.site_url`, the redirect list) and the URLs and keys apps read. The keys are derived, not asked for: the anon and service-role JWTs are signed with `auth.jwt_secret`, the publishable and secret keys are the CLI's local constants.
- `stacks.supabase`: `up` runs `supabase start [-x …]`; `down` is `supabase stop --project-id <id>`, with `--no-backup` for a reset. The CLI labels its containers with the Compose project label we pass as the project id, which is what makes their ports this run's.
- A `supabase migration up --local` migration, first in the list; `hooks.afterContainersReady` regenerates types when the migrations changed.
- `checks`: CLI installed, `config.toml` present and readable, Docker rather than Apple's runtime, CLI version in the tested 2.x range.
- `describe`: Studio and the mail UI, for `buncargo open`.

## The Firebase integration, as a map

- `config()` reads `firebase.json` (comments allowed) and `.firebaserc` leniently, picks the emulators to start, and adds the `firebase` app: `firebase emulators:start --config firebase.buncargo.json --project <id> --only <emulators>` with `--import`/`--export-on-exit`, ready by its "All emulators ready" line, with a 60-second `stopGraceMs` so the export finishes. The app's port is the Emulator UI's (the hub's with the UI off); every other emulator port moves by the same offset. Its env builder sets the `*_EMULATOR_HOST` variables the Admin SDK reads, plus `publicEnvPrefix` copies for the web SDK.
- `generatedFiles` writes `firebase.buncargo.json` beside `firebase.json`, with every port written out and listen hosts defaulting to `127.0.0.1`.
- The `firebase` app lists every other emulator port as `extraPorts`, so the allocator claims and probes them with the checkout's block.
- `appEnv` gives the `firebase` app a short temp dir of its own, and `hooks.beforeServers` creates it.
- `checks`: CLI installed, `firebase.json` present and configuring an emulator, Java on `PATH` when a JVM emulator runs, the data directory gitignored, CLI version in the tested 13.x–15.x range.
- `describe`: the Emulator UI.
