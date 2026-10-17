# Coding standards

The judgement calls a review applies to every buncargo diff (the `review-buncargo` skill), in
`src/` and `scripts/` alike. Rules a check can enforce live in `src/architecture.test.ts` and Biome
instead. Each rule names what to look for in a diff.

## One owner per concern

A concern that has an owner is reached through it. A diff that reads, places, spells or decides one
of these anywhere else has written a second owner: flag it and name the first.

| Concern | Owner |
| --- | --- |
| `BUNCARGO_*` and CI flags | `src/core/runtime-flags.ts` |
| Where state files live | `src/core/state-paths.ts` |
| A child process's environment | `src/core/child-env.ts` |
| Asking the user | `src/core/prompt.ts` |
| The `docker` binary | `src/docker/binary.ts` |
| buncargo's package root and version | `src/core/version.ts` |
| Whether a checkout is deleted (only `ENOENT` or `ENOTDIR` is) | `src/core/checkout-presence.ts` |
| Who removed a stack or volume | `src/core/removal-log.ts` |
| Exclusive leases as a run takes and explains them | `src/core/app-leases.ts` |
| A run's entry and app rows in `runs.json` | `src/core/run-publish.ts` |
| What the sweep removes | `decideSweep` in `src/container-runtime/sweep.ts` |
| JSON state on disk | `src/core/registry-file.ts` (temp file and rename), `src/core/file-lock.ts` (`withFileLock` around a read-modify-write) |

A new shared concern gets one owner and a row here.

## Production code serves production callers

Tests reach a module through the seams it already takes: a `deps` object, `privileged`, `copy`, an
injected clock. A default, optional parameter or fallback that only a test uses is test code
shipped in production: make the parameter required and have the test pass it.

## Types state what is guaranteed

A member that is always set is required in its type and called directly. A `?.`, `??` or guard on a
value the type guarantees hides the next real optional among the noise. The repo compiles without
`noUncheckedIndexedAccess`, so `list[i]` is typed as the element: a guard on it is a decision
about an empty list, made in plain sight, never a `!`, a cast or a `?? fallback` that a budget
check then reads as a number. Types are inferred unless another module needs the name. A `switch`
over a closed union ends in a `never` default; `any` and a cast that silences the compiler get
fixed at the type's source.

## Pure decisions, I/O at the edges

A decision (`decideSweep`, `run-plan.ts`, `render.ts`) is a pure function that carries most of the
tests; the code around it reads, calls it, and acts. A diff that buries a decision inside I/O
leaves it testable only through a real process.

## One idea per line

- A nested template literal, a ternary inside a template, or a message built inline in a `throw`
  becomes a named value on the line before.
- A condition of three clauses, or one a reader has to decode, becomes a named boolean. Handle
  `NaN` and `undefined` in plain sight (`Number.isNaN`, an explicit check), so a negated comparison
  never carries them.
- Setup, validation, side effects and cleanup sit in blank-line-separated phases.
- Comments carry intent, constraints and phase transitions. Each doc comment sits on the
  declaration it documents.

## Messages say what to do next

An error or warning names the checkout, port, process or file involved and the command that fixes
it.

## Tests pin behaviour

- The test goes red without the fix.
- It awaits the event, polls a condition against a deadline, or injects the clock.
- Whatever it starts ends with it: a library `start()` in a test passes `watchdog: false`, and a
  spawned CLI gets the preload's temporary `HOME` and dead `DOCKER_HOST`
  (`scripts/test-runtime-isolation.ts`), never a `PATH` or environment of its own that drops them.
