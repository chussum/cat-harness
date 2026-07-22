---
name: team
description: Coordinated multi-lane execution through native subagent fan-out (no tmux). Use when a task splits into 3+ independent parallel lanes, each owning its own verification. Maintains an evidence-backed task board via the sanctioned state writer; the leader may not declare success until every task has completion evidence.
---

# team — native subagent fan-out

You (the main thread) are the leader. Workers are `executor` subagents you spawn and await
directly — there is no tmux, no worker panes, no claim leases, no heartbeats. What survives is the
philosophy: explicit lanes, a durable task board, per-task completion evidence, and a shutdown
phase computed from evidence, never from optimism.

## State plumbing

- Resolve the session id, state root (`.cat/_session-{sid}`), and helper script path from the
  `<cat-harness-router>` context block; fall back to
  `${CLAUDE_PLUGIN_ROOT}/scripts/cat-state.mjs`. Below, `$CAT` means that script path and every
  invocation takes `--session <sid>`.
- Ensure the session tree exists: `node "$CAT" init --session <sid>`.
- Phases: `starting → running → complete`; terminal alternates `awaiting_integration`, `failed`,
  `cancelled`. Initial phase is `starting`. While `starting`, the PreToolUse guard blocks
  mutations — do not move to `running` until the gates below pass.
- ALL team state writes go through the sanctioned writer — never the Write tool
  (`state/**` is runtime-owned; the guard denies direct writes always):

      node "$CAT" state write --session <sid> --skill team --json -

  passing the full envelope on stdin. The task board is the `board` object embedded in that
  envelope; the sanctioned writer owns the board's canonical on-disk home at
  `.cat/_session-{sid}/state/team-board.json`. Read state back with
  `node "$CAT" state read --session <sid> --skill team`.
- Corrupt/stale team state on resume: `node "$CAT" state clear --session <sid> --skill team`,
  then reseed from `starting`. This clears only team state for this session.

Envelope shape (starred fields are hook-critical; keep them accurate on every write):

```json
{
  "skill": "team",
  "active": true,
  "current_phase": "running",
  "updated_at": "<ISO8601 UTC>",
  "hud": { "nextAction": "one-line status, e.g. 3 lanes running; verifying lane B" },
  "board": { "tasks": [ { "id": "task-1", "lane": "A — Delivery", "status": "in_progress",
                           "owner": "worker-1", "completion_evidence": null } ] }
}
```

## Gate 1 — Justify team (before any state is written)

Team is never the default. Count truly independent lanes: disjoint file surfaces, no sequential
dependency between them, each verifiable on its own.

- **3+ independent lanes** → team is justified; continue.
- **Fewer** → exit this skill without creating team state. Delegate the work to a single
  `executor` subagent (Agent tool, `subagent_type: cat-harness:executor`) — or handle a trivial
  reversible op directly — and tell the user in one line
  why single-lane was chosen. Use native single-subagent fan-out for bounded parallelism the
  leader can await without shared board state.

## Gate 2 — Intake (before spawning workers)

Require a grounded context snapshot before launch:

1. Task statement and desired outcome.
2. Known facts/evidence, constraints, unknowns/open questions, likely codebase touchpoints.
3. When arriving from ralplan or deep-interview, reuse the approved artifacts:
   `.cat/_session-{sid}/plans/ralplan/{run-id}/pending-approval.md`,
   `.cat/_session-{sid}/specs/deep-interview-*.md`. Never execute from an artifact still marked
   `pending-approval` without the user's explicit approval.
4. If intent, scope, or acceptance criteria remain ambiguous, do NOT start team state — invoke
   `cat-harness:deep-interview` first (the chain guard forbids switching skills mid-run, so
   route before initializing team).

Do not spawn workers until this gate is satisfied. If the user forces a fast launch, state the
explicit scope/risk limitations in your launch report.

Once both gates pass: `node "$CAT" state write --skill team` with `current_phase: "starting"`,
`active: true`, and the board seeded as below.

## Lane splitting → worker-owned tasks

Lanes MUST be explicit markdown sections in the brief you assemble:

```md
### Lane A — Delivery
Implement delivery-only changes and evidence. Files: src/foo/**.

### Lane B — Verification
Add focused tests and smoke evidence for lane A's surface.
```

- An inline sentence like "Split lanes: A..., B..." is ambiguous and rejected — rewrite it as
  explicit `### Lane <id> — <title>` sections first. (Upstream, inline splits caused every worker
  to receive the same broad task.)
- Each lane section becomes exactly one worker-owned board task:
  `{id, lane, status, owner, completion_evidence}` with `id` = `task-1..N`,
  `lane` = the section label/title, `status` ∈ `pending|in_progress|blocked|completed|failed`
  (initially `pending`), `owner` = `worker-<n>`, `completion_evidence` = `null`.
- If the request genuinely has no lane structure, do not fake one — go back to Gate 1's
  single-lane exit.
- Exactly one lane must own verification (tests, regression coverage, evidence for the other
  lanes' work). If no lane does, add a verification lane before launch.

Write the seeded board (phase `starting`), then advance the phase to `running` via
`state write` — mutations are blocked until you do — and spawn.

## Code-graph blast-radius (executor-only, best-effort)

At board-init (the first worker spawn of this run), run one full `graph build` (no
`--changed-only`) — best-effort, non-blocking:

```
node "$CAT" graph build --session <sid>
```

Treat a non-zero exit or `{ok:false, skipped:"locked"}` as a silent,
non-blocking fallback — never block a launch on this. Team never re-spawns a worker mid-run except
on a targeted re-spawn (Collect/verify/integrate step 3); if that happens, run `graph build
--changed-only` first (cheap; the generation already advanced from the run-start full build).

When a lane's file surface names specific paths (cap 3 PER LANE), run `graph query --file <path>
--depth 2 --session <sid>` per file. When `ok:true` and `callers` is non-empty, splice the
pinned-format block below into that **executor** worker's dispatch prompt — capped PER LANE (≤3
files, ≤800 bytes total) to bound cost under multi-lane fan-out:

```
[blast-radius HINT — not source of truth{, possibly stale — incremental build; verify with Read/Grep}]
<file>: <N nodes>
  related: <symbol> (<kind>) — <file>, distance <N>
  ... (top ~8 entries by distance, one list — callers/dependents are the same
      underlying array in the current data model, do not render as two
      duplicate-content sections)
```

Fields per entry are exactly what `graph query` returns for `callers`/`dependents`: `symbol`,
`kind`, `file`, `distance` — never `line`. Prepend `(possibly stale — incremental build; verify
with Read/Grep)` to the block's header line whenever the queried file's `graph query` response has
`incremental_since_full_build:true` OR `stale:true`. When the graph is absent or the query returns empty, inject nothing — silent fallback to the worker's own
Read/Grep/Glob guidance (`agents/executor.md`). Team has no architect/critic spawn point of its
own; the reviewer-independence invariant (DESIGN.md §6) applies globally regardless.

## Spawn workers

Spawn one `executor` subagent per lane (Agent tool, `subagent_type: cat-harness:executor`), all
in parallel in a single message. Each assignment must contain:

1. The lane section verbatim (its scope, file surface, and expected outcome) — never the whole
   team brief as the task.
2. Its board task id and owner (`task-1`, `worker-1`).
3. The `[blast-radius HINT]` block when applicable (Code-graph blast-radius section above).
4. The boundary: "Work only inside your lane's file surface; do not modify other lanes' files;
   never write `.cat/**` state; never invoke cat-harness skills."
5. The completion_evidence requirement and schema (below), and that the lane owns its own
   verification.
6. Receipt-only return contract: changed_files, decisions, verification, evidence
   (with the completion_evidence object), blockers — no file bodies or full diffs.
7. Worktree isolation whenever 2+ lanes mutate files in parallel: create one git worktree per
   mutating lane before spawning, give each worker its worktree path, and instruct it to commit
   there; the leader integrates afterwards. Skip worktrees only when at most one lane writes.

Workers never mutate the board or any `.cat/` state — the leader owns every state write.

## completion_evidence contract

Stored inline on the task record. Required shape:

```json
{
  "summary": "non-empty one-line result",
  "items": [
    { "kind": "command",    "status": "passed",   "summary": "focused test passed",
      "command": "npm test -- --filter foo" },
    { "kind": "inspection", "status": "verified", "summary": "reviewed output matches spec",
      "location": "src/foo/bar.ts:42" },
    { "kind": "artifact",   "status": "verified", "summary": "screenshot captured",
      "location": ".cat/_session-{sid}/ultragoal/artifacts/foo.png" }
  ],
  "files": ["optional touched paths"],
  "notes": "optional"
}
```

Rules: `summary` non-empty; `items` must contain **at least one item with status `passed`
(a passed command, `command` field required) or `verified` (a verified inspection/artifact)**.
Item kinds: `command | inspection | artifact`; statuses: `passed | failed | not_run | verified |
rejected`. A review-only task may complete with a single verified inspection item. Bare prose
("it works"), pointers without locations, and evidence the leader cannot re-check do not qualify.

## Collect, verify, integrate

1. Await all workers. Mark a task `in_progress` when its worker starts, via `state write` —
   update the board on EVERY status change; never back-fill the board at the end.
2. For each returned receipt, verify the evidence YOURSELF before marking `completed`: re-run at
   least one claimed passed command, or open the referenced inspection/artifact location. Record
   the verified `completion_evidence` object onto the task.
3. Evidence missing or unverifiable → the task is NOT complete. Re-spawn that lane's executor once
   with the specific gap named; if it still cannot produce qualifying evidence, mark the task
   `failed` (or `blocked` with the blocker recorded in the board task).
4. Integrate worktrees: merge or rebase each lane worktree into the leader branch. A conflict or
   un-merged lane means integration is pending — record it; do not count it as settled.
5. Never silently drop a lane. Every task ends in `completed` (with evidence), `failed`, or
   `blocked` — and the phase formula below charges you for anything else.

## Shutdown

Preconditions before computing the terminal phase: no task `pending`, no task `in_progress`
(each resolved to `completed`/`failed`/`blocked`), integration settled or explicitly recorded as
pending/conflicted.

Shutdown phase formula — compute exactly, no judgment calls:

- all tasks evidence-complete → `complete`
- work merged but integration pending → `awaiting_integration`
- any failed/blocked or missing evidence → `failed`
- work remaining → `cancelled`

Expanded: `complete` only when EVERY task is `completed` with a verified `completion_evidence`
containing ≥1 passed/verified item AND no integration request/conflict is pending;
`awaiting_integration` when all tasks are evidence-complete but leader integration still requires
action; `failed` when any task is `failed`/`blocked` or any `completed` task lacks qualifying
evidence; `cancelled` when work remains `pending`/`in_progress` (user abort, early exit).

Write the terminal phase via `state write` with the final board. Every releasing terminal write
(`complete`, `failed`, `cancelled`) sets `"active": false` in the envelope while preserving the
board; `awaiting_integration` stays `"active": true`. Note: `complete`, `failed`, and
`cancelled` release the Stop gate; `awaiting_integration` does NOT — resolve integration, then
write `complete`. If integration proves impossible, demote: the writer accepts `failed` and
`cancelled` from `awaiting_integration`, and `state clear` is the other demotion path when the
run must be abandoned entirely. Preserve the board as evidence; do not clear state after a
normal run.

## Required reporting

The leader may not declare success until every task has verified completion evidence. Report:

1. Team summary line: lane count, worker count, terminal phase.
2. Per-task line: id, lane, status, one-line evidence summary (command + result, or
   inspection/artifact location).
3. Receipts only — board path/state revision, artifact paths, commit ids. Never paste artifact
   bodies or worker transcripts.

Do not claim success without evidence. Do not claim clean completion if any task ended
`pending`/`in_progress`. A `failed`/`cancelled` phase is a truthful result — report it as such
with the blockers.

## Handoff and the ultragoal bridge

Team has no `handoff` phase: chain to another cat-harness skill only AFTER writing a terminal
phase (the chain guard blocks skill switches mid-run). If the user wants to continue into
ralplan/ultragoal, terminalize first, then invoke the next skill.

When team runs under an active ultragoal goal: workers provide task status and verification
evidence only. They never mutate `.cat/_session-{sid}/ultragoal/goals.json` or `ledger.jsonl`
and never run `goal checkpoint` — checkpoint authority stays with the leader, who runs
`node "$CAT" goal checkpoint --session <sid> --goal GNNN --status complete
--quality-gate-json <path|->` only after terminal team evidence exists.
