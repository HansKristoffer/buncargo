# Changelog

## [9.1.0](https://github.com/HansKristoffer/buncargo/compare/v9.0.0...v9.1.0) (2026-09-11)


### Features

* **hosts:** serve HTTP/2 on the local proxy ([#42](https://github.com/HansKristoffer/buncargo/issues/42)) ([9ba8d76](https://github.com/HansKristoffer/buncargo/commit/9ba8d761331671fa1d258210c38ef518f01c5df6))

## [9.0.0](https://github.com/HansKristoffer/buncargo/compare/v8.2.4...v9.0.0) (2026-09-10)


### ⚠ BREAKING CHANGES

* remove `buncargo tailnet` and TS_AUTHKEY-based remote discovery. Remote sharing now uses recipient tokens and frp. Release-please owns the CLI and bar version bumps.

### Features

* replace remote sharing with frp ([#40](https://github.com/HansKristoffer/buncargo/issues/40)) ([bd1fcb9](https://github.com/HansKristoffer/buncargo/commit/bd1fcb92c83ec8c9bc50d89128b6ae92b26aca42))

## [8.2.4](https://github.com/HansKristoffer/buncargo/compare/v8.2.3...v8.2.4) (2026-09-09)


### Bug Fixes

* **tailnet:** provide certificate storage for userspace nodes ([#38](https://github.com/HansKristoffer/buncargo/issues/38)) ([8e9c692](https://github.com/HansKristoffer/buncargo/commit/8e9c6920c27001e0ea17f27b5b693a4a39a37eb8))

## [8.2.3](https://github.com/HansKristoffer/buncargo/compare/v8.2.2...v8.2.3) (2026-09-09)


### Bug Fixes

* **tailnet:** allow sharing from unprivileged Linux sandboxes ([#36](https://github.com/HansKristoffer/buncargo/issues/36)) ([499d828](https://github.com/HansKristoffer/buncargo/commit/499d82838922fa2b541d3e55b097cbcd9d2d7ad4))

## [8.2.2](https://github.com/HansKristoffer/buncargo/compare/v8.2.1...v8.2.2) (2026-09-09)


### Bug Fixes

* **release:** recognize CLI-only combined release PRs ([#32](https://github.com/HansKristoffer/buncargo/issues/32)) ([369f999](https://github.com/HansKristoffer/buncargo/commit/369f99947b6a2af58255ed78287c5aa46b2586bd))
* **vite:** configure Tailscale hosts before Vite 8 validation ([#33](https://github.com/HansKristoffer/buncargo/issues/33)) ([534c367](https://github.com/HansKristoffer/buncargo/commit/534c367f0a6607aff798bf2d61349499f8c1eaf1))

## [8.2.1](https://github.com/HansKristoffer/buncargo/compare/v8.2.0...v8.2.1) (2026-09-09)


### Bug Fixes

* **vite:** allow the local Tailscale hostname automatically ([#30](https://github.com/HansKristoffer/buncargo/issues/30)) ([b0f6813](https://github.com/HansKristoffer/buncargo/commit/b0f6813b5c76d244433782f5034ddc05ab236391))

## [8.2.0](https://github.com/HansKristoffer/buncargo/compare/v8.1.1...v8.2.0) (2026-09-09)


### Features

* replace cloud connect with Tailscale sharing ([6a83fe7](https://github.com/HansKristoffer/buncargo/commit/6a83fe7fcb6eeeac714b54c2b051c74cf9a69ffb))


### Bug Fixes

* pass through gzip bodies on the named-hosts proxy ([#28](https://github.com/HansKristoffer/buncargo/issues/28)) ([857b9a4](https://github.com/HansKristoffer/buncargo/commit/857b9a42e06e9c53a543b400e5db5779dd23dd81))

## [8.1.1](https://github.com/HansKristoffer/buncargo/compare/v8.1.0...v8.1.1) (2026-09-08)


### Bug Fixes

* use the Buncargo relay and unify remote service rows ([#25](https://github.com/HansKristoffer/buncargo/issues/25)) ([6e55792](https://github.com/HansKristoffer/buncargo/commit/6e557926ded6c702dc4c2beb50afa9dbc6544f4f))

## [8.1.0](https://github.com/HansKristoffer/buncargo/compare/v8.0.0...v8.1.0) (2026-09-08)


### Features

* share remote worktree services with Tailcat ([#24](https://github.com/HansKristoffer/buncargo/issues/24)) ([aff9bae](https://github.com/HansKristoffer/buncargo/commit/aff9baeb79d61045cc57a9dcd6b1c73534f414d4))


### Bug Fixes

* **bar:** shrink the menu window when its content shrinks ([#22](https://github.com/HansKristoffer/buncargo/issues/22)) ([d4f5ea0](https://github.com/HansKristoffer/buncargo/commit/d4f5ea038695b70601b9f7b60f1564bae649e677))
* recover release publication on full workflow reruns ([#21](https://github.com/HansKristoffer/buncargo/issues/21)) ([3c029d9](https://github.com/HansKristoffer/buncargo/commit/3c029d9d8c2c030b6d4b4e3b9b60c791611876c9))

## [8.0.0](https://github.com/HansKristoffer/buncargo/compare/v7.10.0...v8.0.0) (2026-09-08)


### ⚠ BREAKING CHANGES

* removes the unused Tailscale CLI, configuration and exported integration. Private sharing now uses `BUNCARGO_CONNECT_TOKENS` and `expose: true`.

### Features

* replace Tailscale with token-based remote connections ([#19](https://github.com/HansKristoffer/buncargo/issues/19)) ([cf29f05](https://github.com/HansKristoffer/buncargo/commit/cf29f05300557246be1e877ae32892be1a4404e2))

## [7.10.0](https://github.com/HansKristoffer/buncargo/compare/v7.9.0...v7.10.0) (2026-09-08)


### Features

* release on merge ([2b891ee](https://github.com/HansKristoffer/buncargo/commit/2b891ee1c064540b71dc52c48e4cc914cc05a9c9))
