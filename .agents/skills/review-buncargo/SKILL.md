---
name: review-buncargo
description: Review a buncargo diff against CODING_STANDARDS.md and the surfaces it must hit. Use before handing back a branch, and before merging commits another agent made.
---

# Review a buncargo diff

A review reads the diff, not the history that produced it, so it runs best in a fresh subagent
given the base commit. It reports findings; the author fixes them.

## Steps

1. **Settle the base.** The commit the work started from: the branch point for a branch
   (`git merge-base HEAD main`), or the commit an agent's slice was built on. Done when
   `git log --oneline <base>..HEAD` lists exactly the commits under review.
2. **Run the checks.** `bun scripts/check-commits.ts <base>`, about a minute per commit; it links
   this checkout's `node_modules`, so a dependency change is checked against what is installed
   here. A failing commit is the first finding. `bun test src/architecture.test.ts` is quick and
   touches nothing; the full `bun test` belongs to the author. Done when every commit is `ok` or
   reported.
3. **Load the rules.** Read `CODING_STANDARDS.md`, the "Hit every surface" list in `AGENTS.md`,
   and the `docs/internals/` note for each subsystem the diff touches (`AGENTS.md`, "Before you
   change a subsystem", maps them).
4. **Read the diff.** `git diff <base>..HEAD`, file by file, with each changed hunk held against
   every rule. A new function or module gets a search for an existing owner of its concern. A
   removed or narrowed export gets a search for its callers. A new value import into a module
   every run loads (`src/core/watchdog.ts`, the CLI's startup path, the `vite`/`client`/`runtime`
   entries) gets its import graph compared before and after: startup cost hides there. Done when
   every hunk has been checked against every rule.
5. **Walk the surfaces.** For each entry of "Hit every surface", say whether the change applies
   to it and whether the diff covers it there: the other entry point, the other runtime, the other
   output mode, the run-registry readers, `--json` and exit codes, the way back out, the docs.
6. **Report.** Re-run `git log --oneline <base>..HEAD` and `git status` first, and say what landed
   while you read; uncommitted changes are out of scope. Findings most severe first, one per
   entry: `path:line`, the rule, what is wrong, and the concrete fix. Issues the diff only touched
   go in a separate "pre-existing" list. Then the surfaces walked, each as applied and covered,
   applied and missing, or not applicable. A review that finds nothing says which rules and
   surfaces it checked.
