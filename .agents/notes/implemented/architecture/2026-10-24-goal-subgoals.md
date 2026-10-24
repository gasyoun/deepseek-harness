# Agent Note: Goal subgoals as a separate durable child list

Status: implemented

English | [中文](2026-10-24-goal-subgoals.zh.md)

## Problem

A persisted goal carried one objective, one phase and one round counter. A long objective is usually several independently checkable conditions — a green gate, a landed change, a cleared external blocker — and the goal domain could express none of them. The model had two bad options: write the conditions into the objective prose, where nothing replays them as state, or keep them only in its own reasoning, where a resumed session loses them. The user saw the same gap from the other side: the goal strip showed a single phase, so "which condition is still open" had no answer short of asking the model.

`complete` was the sharpest symptom. A goal whose gate was green but whose change had not landed was either completed early (overclaiming) or left active with no record of what remained.

## Decision

A subgoal is `{ id, title, status: open | done | blocked, note? }`. The parent keeps its objective, phase, round cap, revision and identity. A child mutation therefore does not spend a goal revision, and the compare-and-set answer to "is my goal view stale" stays about the goal, not about its checklist.

### Children ride their own event stream

A `goal/subgoal` session event carries the complete post-mutation list for one goal id plus the revision the list was computed against. Full-list events keep replay idempotent and keep the strict `goal/change` snapshot decoder untouched: a released v6 log remains valid, and it replays with an empty list because the fold initialises `subgoals: []` and only a create resets it. A list whose goal id no longer matches the current goal (a cleared or replaced goal) is dropped rather than failing replay.

### The state is visible where each consumer already reads

The `goal` projection exposes `subgoals` and its state version moves 6 → 7, so a cached v6 projection is discarded and re-derived rather than migrated. The model tools expose the list on `get_goal` and take `add_subgoal` / `update_subgoal` / `remove_subgoal` on `update_goal`, with one terse guidance sentence for the per-condition rule and the completion gate; `add_subgoal` creates children as `open` and refuses a status or note with a pointer to `update_subgoal` (a live GUI run caught the model passing `subgoal_status` to `add_subgoal`, which the first cut silently ignored) — kept short because the recorded compaction fixtures have token budgets a longer paragraph would cross; `/goal` renders `Subgoals: N/M done` with one line per child; the Web strip shows a `done/total` chip that expands in place.

### Bounds and the completion rule are enforced where the mutation happens

A goal carries at most 16 children, a title at most 160 characters, a note at most 500. The service mints ids (`s1`, `s2`, …) so a client cannot collide with or spoof another child. `complete` is refused while any child is not `done`, with an error naming the open ids and their states; marking a child `blocked` is the durable way to say a condition cannot close yet, and it keeps the goal itself active.

## Alternatives considered

- **Put the conditions in the objective prose.** Rejected: prose does not replay as state, cannot answer "which leg is open", and cannot gate completion.
- **Promote every condition to its own goal.** Rejected: the service keeps one current goal per session by design, so this would either multiply sessions or lose the shared round budget and objective.
- **Extend `goal/change` with the child list.** Rejected: the snapshot decoder validates an exact key set for each phase, so widening it would break released logs and the strict replay promise for a capability that does not need to share the goal's CAS revision.
- **Bump the projection without a version change.** Rejected: a cached v6 row would fail the new state schema; the version bump makes the registry discard and re-derive instead.

## Consequences

- A resumed or forked session replays its children exactly as it replays its goal; no new store, file or migration exists.
- Existing goal tests and the projection fixture carried a `subgoals: []` expectation change — the fold now always reports the list, which is the honest value for a goal-less session.
- The Web strip stays one line when collapsed; the list is a disclosure, not a new panel.
- The Web end-to-end recorded outputs stay owed in this change: that lane needs a Playwright browser, which the implementation environment could not install; the package README twins are included.
