# Bug hunt — deepseek-harness — 26.10.2026

_Created: 26-10-2026 · Run: interactive day-mode `/bughunt` (rotation slot 7/173) · Base: `origin/master` @ `22ddee3792` · Model: DeepSeek Flash (`deepseek-flash`) · Elapsed: ~65 min._

This is a **targeted** hunt, not a read of 19,188 tracked files: five static generator/verification gates, one package suite (`packages/schedule`, 859 tests), and two differential oracles written against the shipped store rules. Nothing was changed; the working branch `feat/goal-subgoals` (10 commits ahead of `master`) was inspected read-only and left exactly as found.

## Verdict at a glance

| # | Sev | Finding | Status |
|---|---|---|---|
| M1 | MEDIUM | `feat/goal-subgoals` adds three goal-tool actions (`add_subgoal`, `update_subgoal`, `remove_subgoal`) and changes a config field, but **neither generated catalog was regenerated**: `gen-tool-catalog --check` and `gen-config-catalog --check` both failed on the branch while both passed on `master`, so merging as-is would have turned `master` red | **FIXED** 26-10-2026 on `feat/goal-subgoals` (`42688e3`) |
| L1 | LOW | Two of ten static-gate invocations died with a bare `Node.js v26.7.0` tail and `rc=1`, then passed unchanged on rerun — a gate crash is indistinguishable from a gate rejection in the captured output | reported — observability, cause unproven |

No HIGH: no defect was found in shipped code. Severity here: Medium = would land a red gate or a wrong model-facing artifact; Low = latent or diagnostic.

## What verified green

- **`packages/schedule` unit suite** — 20 files, **859 tests, all pass**, 23.1 s (`node_modules/.bin/vitest run packages/schedule`). The package has 20 spec files for 3.3k lines of domain code, including DST gap/overlap, date-line, horizon and downtime cases.
- **Generator and static gates on `master`** — `gen-tool-catalog --check` (15.7 s), `gen-config-catalog --check` (16.5 s), `gen-cli-help --check` (18.7 s), `verify-runtime-closure` (0.8 s), `gen-plugin-packages --check` (10.6 s): **rc=0 on all five**, so the committed catalogs are current on the shipped branch.
- **Wider static gates on `master`** — `gen-session-format-catalog --check`, `verify-md-wrap` (2,252 files), `verify-doc-budgets` (7 budgeted docs), `verify-no-top-level-await` (2,699 source files, 2 excluded executables): **rc=0**.
- **Daily recurrence across DST, against an independent oracle** — 56 resolutions over 7 zones (`Europe/Berlin`, `America/New_York`, `Australia/Lord_Howe` with its 30-minute shift, `Pacific/Chatham` at +12:45, `America/Santiago`, `Asia/Kathmandu`, `Pacific/Apia`) × 4 local times (`02:30`, `00:00`, `23:59`, `12:00`) × decisions on both sides of each 2026 transition. Every resolved `nextScheduledAt` equalled the first instant found by a minute-by-minute scan of the zone that matches the rule's wall clock on a strictly later local date, and every `occurrenceAt` equalled the committed `scheduledAt`.
- **Cron creation against the same oracle** — leap day (`0 0 29 2 *` from 2026-03-01 → `2028-02-29`), Vixie day-of-month/day-of-week OR semantics (`0 0 13 * 5` → the first Friday on or after 2026-01-01), first-of-month, `02:30` across the Berlin spring-forward (skipped, fires 2026-03-30) and fall-back (earlier overlap, 2026-10-25 00:30Z), and `02:15` on the Lord Howe 30-minute gap day (skipped to the next date): **6/6 match**, no drift.
- **Fixed-rate arithmetic** — `resolveEveryOccurrence` anchors on the committed target and uses `floor((acceptedAt - target) / interval)`, so a late dispatch cannot drift the cadence; read, not just trusted.

## M1 — the goal-subgoals branch would land two red generator gates (MEDIUM)

On `feat/goal-subgoals` (`8818023fea`), against the same tree and the same `node_modules`:

```
$ node_modules/.bin/tsx scripts/gen-tool-catalog.ts --check
gen-tool-catalog: docs/tool-catalog.md is stale. Run `pnpm run gen-tool-catalog` and commit docs/tool-catalog.md.
gen-tool-catalog: first difference at line 1450
  committed: "        \"blocked\""
  generated: "        \"blocked\","
rc=1

$ node_modules/.bin/tsx scripts/gen-config-catalog.ts --check
gen-config-catalog: stale — docs/config-catalog.md, docs/config-catalog.zh.md.
Run `pnpm run gen-config-catalog` and commit the result.
rc=1
```

Both are **rc=0 on `origin/master`** (the table above), so the failure is introduced by the branch, not by the checkout. The cause is visible in the branch tree: `packages/goal/tool-goal/src/index.ts` adds `add_subgoal`, `update_subgoal` and `remove_subgoal` to the action enum (lines 53, 63, 286-297), and `docs/tool-catalog.md` on the branch still ends the enum at `blocked` — the trailing comma in the generated text is the first of the actions the catalog does not list.

Two consequences worth stating plainly: the model-facing tool catalog on the branch is **wrong** (it documents five actions where the schema ships eight), and `pnpm run check:ci:static` (and any aggregate that includes the two generators) cannot pass until the docs are regenerated. The fix is the two commands, committed:

```sh
pnpm run gen-tool-catalog && pnpm run gen-config-catalog
git add docs/tool-catalog.md docs/config-catalog.md docs/config-catalog.zh.md
```

I did not run them in the hunt pass: regenerating a catalog rewrites committed documentation, which is the branch owner's call.

**Fixed 26-10-2026** on MG's word (`fix`): both generators ran on `feat/goal-subgoals`, the regenerated files were committed as `42688e3720` and pushed to `gasyoun/deepseek-harness`. `docs/tool-catalog.md` now lists the three actions and the four subgoal parameters; `docs/config-catalog.md` and its Chinese twin only carried stale source line references for `@deepseek-ai/dsh-goal` (`index.ts:168` → `:186`). Verified with the gates that caught it, all `rc=0`: `gen-tool-catalog --check`, `gen-config-catalog --check`, `verify-md-wrap` (2,252 files), `verify-md-links` (2,206 files), `verify-doc-budgets` (7 budgeted docs). The pre-push hook's own `typecheck` also passed (5 gates, 43 s).

## L1 — a gate crash looks like a gate rejection (LOW, unproven)

In the first batch of ten gate invocations, two died at 1.1 s and 34.6 s with `rc=1` and a tail of exactly `Node.js v26.7.0` — the last line of a Node stack trace with no message, no file, no diff. Re-running the same two commands unchanged gave `rc=0` with normal output (`gen-cli-help: 7 help pages; all outputs are current`, `verify-runtime-closure: … closed runtime dependency graph`). Most likely host memory pressure: the checkout is 5.7 GB with a 2.3 GB `node_modules`, and each `tsx` gate boots its own Node process.

I am labelling this LOW and unproven rather than raising it as a defect: two clean reruns is not a diagnosis, and no reproduction survived. The durable observation is the interface, not the cause — a crashed gate and a rejecting gate both exit 1, and the captured tail keeps no stack. If the estate ever wires these gates into a loop, the exit code alone cannot tell "the artifact is stale" from "the gate fell over".

## Suggested next slice

This pass covered the schedule domain in depth because it is pure, testable arithmetic with a documented contract — the highest ratio of provable defects to minutes. The next slice with a comparable ratio is `packages/compaction` (9.1k lines, 13 specs, budget arithmetic that is model-visible) and `packages/context` (15k lines, 11 specs), both untouched by the goal branch and both with model-facing failure modes that a differential oracle can reach.

_Dr. Mārcis Gasūns_
