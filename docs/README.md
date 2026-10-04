# Buncargo docs

## Using buncargo

- [Readme](../readme.md): setup, configuration and the common workflows
- [Reference](./reference.md): every command, option and environment variable
- [Writing an integration](./integrations.md)
- [Migrating between major versions](./migration.md)
- [Remote environments](./frp.md)
- [Container and run maintenance](./runtime-maintenance.md)
- [BuncargoBar](../menubar/README.md) and [its updates](./bar-updates.md)

## Working on buncargo

Start with [AGENTS.md](../AGENTS.md). Internal notes record architectural decisions, constraints
that span modules, and traps the source alone does not explain. Most changes do not need one;
follow the [documentation rules](../AGENTS.md#documentation) before adding to them.

- [Architecture overview](./internals/overview.md) and [glossary](./internals/glossary.md)
- [CLI](./internals/cli.md)
- [Environment and preparation](./internals/environment.md)
- [Process supervision](./internals/process-supervision.md)
- [TUI and app output](./internals/tui.md)
- [Run registry, sweep and BuncargoBar](./internals/run-registry-and-sweep.md)
- [Container runtimes](./internals/container-runtimes.md)
- [Ports](./internals/ports.md)
- [Named hosts](./internals/named-hosts.md)
- [Secrets](./internals/secrets.md)
- [Integrations and stacks](./internals/integrations.md)
- [Shared core](./internals/core.md)
- [Connect](./internals/connect.md)

### Runbooks

- [Testing](./testing.md)
- [Releasing](./releasing.md)
- [frp relay acceptance](./frp-acceptance.md)
