# Changelog

## [4.0.0](https://github.com/HansKristoffer/buncargo/compare/bar-v3.0.0...bar-v4.0.0) (2026-09-28)


### ⚠ BREAKING CHANGES

* **integrations:** Infisical defaults to the EU cloud (set secrets.siteUrl for the US cloud) and needs a CLI with "infisical user get token". A config-level secrets scope now also applies to migrations, the seed, exec and prisma; opt out per call with secrets false. See docs/migration.md.
* **docker:** harden container cleanup and run ownership ([#55](https://github.com/HansKristoffer/buncargo/issues/55))
* **container-runtime:** sweep unowned containers from one run registry ([#54](https://github.com/HansKristoffer/buncargo/issues/54))

### Features

* **bar:** stop services without a confirmation dialog ([#51](https://github.com/HansKristoffer/buncargo/issues/51)) ([ae461be](https://github.com/HansKristoffer/buncargo/commit/ae461be467548d26c3ad65b3e8fc2f9b10ecf707))
* **container-runtime:** sweep unowned containers from one run registry ([#54](https://github.com/HansKristoffer/buncargo/issues/54)) ([e2356c2](https://github.com/HansKristoffer/buncargo/commit/e2356c2e69a146ed4300f770521f52dcc00045f5))
* **docker:** harden container cleanup and run ownership ([#55](https://github.com/HansKristoffer/buncargo/issues/55)) ([6c8ec8e](https://github.com/HansKristoffer/buncargo/commit/6c8ec8e5416b36b783ed39f9bd05ef8a313f1432))
* **integrations:** add buncargo/shopify and the integration API ([#56](https://github.com/HansKristoffer/buncargo/issues/56)) ([a9134b9](https://github.com/HansKristoffer/buncargo/commit/a9134b9b74ec23e5837d9dc593371f3371271b5d))

## [3.0.0](https://github.com/HansKristoffer/buncargo/compare/bar-v2.2.0...bar-v3.0.0) (2026-09-10)


### ⚠ BREAKING CHANGES

* remove `buncargo tailnet` and TS_AUTHKEY-based remote discovery. Remote sharing now uses recipient tokens and frp. Release-please owns the CLI and bar version bumps.

### Features

* replace remote sharing with frp ([#40](https://github.com/HansKristoffer/buncargo/issues/40)) ([bd1fcb9](https://github.com/HansKristoffer/buncargo/commit/bd1fcb92c83ec8c9bc50d89128b6ae92b26aca42))

## [2.2.0](https://github.com/HansKristoffer/buncargo/compare/bar-v2.1.1...bar-v2.2.0) (2026-09-09)


### Features

* replace cloud connect with Tailscale sharing ([6a83fe7](https://github.com/HansKristoffer/buncargo/commit/6a83fe7fcb6eeeac714b54c2b051c74cf9a69ffb))

## [2.1.1](https://github.com/HansKristoffer/buncargo/compare/bar-v2.1.0...bar-v2.1.1) (2026-09-08)


### Bug Fixes

* use the Buncargo relay and unify remote service rows ([#25](https://github.com/HansKristoffer/buncargo/issues/25)) ([6e55792](https://github.com/HansKristoffer/buncargo/commit/6e557926ded6c702dc4c2beb50afa9dbc6544f4f))

## [2.1.0](https://github.com/HansKristoffer/buncargo/compare/bar-v2.0.0...bar-v2.1.0) (2026-09-08)


### Features

* share remote worktree services with Tailcat ([#24](https://github.com/HansKristoffer/buncargo/issues/24)) ([aff9bae](https://github.com/HansKristoffer/buncargo/commit/aff9baeb79d61045cc57a9dcd6b1c73534f414d4))


### Bug Fixes

* **bar:** shrink the menu window when its content shrinks ([#22](https://github.com/HansKristoffer/buncargo/issues/22)) ([d4f5ea0](https://github.com/HansKristoffer/buncargo/commit/d4f5ea038695b70601b9f7b60f1564bae649e677))

## [2.0.0](https://github.com/HansKristoffer/buncargo/compare/bar-v1.1.0...bar-v2.0.0) (2026-09-08)


### ⚠ BREAKING CHANGES

* removes the unused Tailscale CLI, configuration and exported integration. Private sharing now uses `BUNCARGO_CONNECT_TOKENS` and `expose: true`.

### Features

* replace Tailscale with token-based remote connections ([#19](https://github.com/HansKristoffer/buncargo/issues/19)) ([cf29f05](https://github.com/HansKristoffer/buncargo/commit/cf29f05300557246be1e877ae32892be1a4404e2))

## [1.1.0](https://github.com/HansKristoffer/buncargo/compare/bar-v1.0.6...bar-v1.1.0) (2026-09-08)


### Features

* release on merge ([2b891ee](https://github.com/HansKristoffer/buncargo/commit/2b891ee1c064540b71dc52c48e4cc914cc05a9c9))
