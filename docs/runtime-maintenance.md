# Container and run maintenance

`~/.buncargo/runs.json` is the lifecycle authority for both CLI and library runs. Each session records its process birth identity, checkout, runtime, pinned binary and idle hold before starting containers. Release records the first release time; an explicit stop retires the entry after teardown.

The watchdog and the machine-wide `ls`/`doctor` commands sweep orphaned stacks under each project's lifecycle lock and recheck claims before teardown. An unreadable registry stops cleanup. An unavailable runtime is not evidence that its containers disappeared. A missing checkout or expired idle hold can remove containers; volumes require the separately confirmed `buncargo prune` command.

Liveness treats an unreadable process identity as alive; signaling requires a strict identity match. Never test the sweep against an isolated registry and a real container runtime: stub adapters or set `DOCKER_HOST` to an unreachable endpoint as well as isolating HOME.

Docker integration is exercised in CI using disposable fixtures. The live Apple container path and privileged named-host installation still require their opt-in integration checks on a suitable Mac. See the repository's AGENTS.md for the implementation invariants and the CLI reference for status, stop and prune usage.
