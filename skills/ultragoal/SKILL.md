---
name: ultragoal
description: >-
  Durable multi-goal execution engine over .cat goal artifacts with evidence-gated,
  receipt-verified completion. Use for clear multi-goal / multi-step execution requests
  (router ladder rule 4), for approved plan handoffs from ralplan, or when the user says
  "ultragoal" / "$ultragoal". Not for vague requests (deep-interview) or unplanned
  high-risk architecture work (ralplan).
---

# ultragoal — durable multi-goal execution

You are the ultragoal **leader**: you own goal decomposition, scheduling, checkpoints, and
verification. Subagents implement and review; only you mutate durable goal state.

`ultragoal` turns a brief into durable repo-native artifacts and drives execution through them.
`goals.json` is the canonical source of goal identity and state; `ledger.jsonl` is the canonical
proof stream for checkpoints, receipts, blockers, steering notes, and reviews. Completion is
verified purely from durable `goals.json` plus fresh `ledger.jsonl` receipts — never from
conversation, memory, or `goals.json` status alone. **Status alone is not proof**: a goal counts
as complete only after `receipt verify` succeeds for it.

Durable artifacts (`{sid}` = current session id):

- `.cat/_session-{sid}/ultragoal/brief.md` — decomposed brief (normal Write tool OK)
- `.cat/_session-{sid}/ultragoal/goals.json` — goal identity + state (cat-state.mjs ONLY)
- `.cat/_session-{sid}/ultragoal/ledger.jsonl` — append-only proof stream (cat-state.mjs ONLY)
- `.cat/_session-{sid}/ultragoal/artifacts/` — evidence files (screenshots, test reports; Write/Bash OK)

## Sanctioned writer — the only mutation path

All `goals.json` / `ledger.jsonl` / `state/*` mutations go through the sanctioned CLI, invoked by
the leader (main thread) only. Never hand-edit these files; the PreToolUse guard denies direct
writes to them even outside active runs. Subagents never run `cat-state.mjs` and never mutate
`.cat/` — they return evidence; you checkpoint.

Resolve `{sid}` from the `<cat-harness-router>` context block (`state_root: .cat/_session-{sid}`);
fallback: the `.cat/_session-*` directory with the freshest `.session-activity.json`.

Use these exact commands instead of rediscovering syntax (every call takes `--session <sid>`;
`-` reads the JSON/file body from stdin):

```sh
node "${CLAUDE_PLUGIN_ROOT}/scripts/cat-state.mjs" init --session <sid>
node "${CLAUDE_PLUGIN_ROOT}/scripts/cat-state.mjs" state read  --session <sid> --skill ultragoal
node "${CLAUDE_PLUGIN_ROOT}/scripts/cat-state.mjs" state write --session <sid> --skill ultragoal --json '<envelope-json>'
node "${CLAUDE_PLUGIN_ROOT}/scripts/cat-state.mjs" state clear --session <sid> --skill ultragoal
node "${CLAUDE_PLUGIN_ROOT}/scripts/cat-state.mjs" goal init --session <sid> --brief <path|->
node "${CLAUDE_PLUGIN_ROOT}/scripts/cat-state.mjs" goal checkpoint --session <sid> --goal GNNN --status <s> [--quality-gate-json <path|->]
node "${CLAUDE_PLUGIN_ROOT}/scripts/cat-state.mjs" ledger append --session <sid> --json '<event-json>'
node "${CLAUDE_PLUGIN_ROOT}/scripts/cat-state.mjs" receipt verify --session <sid> --goal GNNN
```

Goal statuses: `pending | active | complete | failed | blocked | review_blocked | superseded`.
`--status complete` REQUIRES `--quality-gate-json` and is enforced fail-closed by the CLI (see
the quality gate section). `superseded` is a terminal status the leader may checkpoint when
blocker resolution makes the original goal moot — a superseded goal no longer blocks run
completion. Ledger events you append explicitly (checkpoint appends its own
`goal_checkpointed` event): `goal_started`, `review_blockers_recorded`, `blocker_resolved`,
`human_blocked`, `nudge`, `steering_note`, `delegation_note`. Every goal status change must have
a matching ledger event. Treat `ledger.jsonl` as the durable audit trail; checkpoint after every
success or failure.

If ultragoal's own session state is corrupt, tampered, or stale on resume: append a
`steering_note` ledger event describing the corruption if the ledger is still writable, run
`state clear --skill ultragoal`, then reseed with a fresh `state write`. Never clear other
skills' state.

## Phase contract

Canonical phases (persist every transition via `state write`; include `hud.nextAction` — a
one-line status the router injects each prompt):

| phase | meaning |
|---|---|
| `goal-planning` | decompose brief → `goal init` (mutations outside `.cat/` are hook-denied here) |
| `executing` | goal loop: implement, per-goal completion gate, checkpoint, next goal |
| `review` | run-level audit: `receipt verify` every goal, compile receipts summary |
| `complete` | terminal; releases the Stop gate |

Transition envelope example: `{"skill":"ultragoal","active":true,"current_phase":"executing",
"hud":{"nextAction":"G002 active: implementing parser slice via 2 executors"}}`

The Stop gate blocks ending the turn while `active:true` and phase is non-terminal — do not stop
mid-run; keep working, or record `human_blocked` (below). The chain guard denies invoking a
different cat-harness skill while ultragoal is non-terminal: finish the run, or (only on an
explicit user cancel) append a `steering_note` ledger event with the reason, then
`state clear --skill ultragoal`.

## Phase: goal-planning

1. **Plan check (before activating).** Preferred input is an approved ralplan artifact
   (`plans/ralplan/{run-id}/pending-approval.md` with the user's explicit structured approval —
   "just do it" does not approve). If there is no approved plan or consensus artifact and the
   work carries real architecture/sequencing/verification risk, recommend `cat-harness:ralplan`
   first instead of activating ultragoal. Do not silently substitute ad-hoc execution for missing
   planning. When a plan exists, preserve its constraints and verification guidance in the brief
   and cite it in a `steering_note` ledger event after init.
2. Run `init` if the session tree is missing, then `state write` with
   `current_phase:"goal-planning"`, `active:true`.
3. **Write the brief** to `.cat/_session-{sid}/ultragoal/brief.md`. To produce multiple goals,
   separate stories with a reserved `@goal` column-0 delimiter line; the title follows on the same
   line and the objective is everything beneath it until the next delimiter:

   ```text
   Shared brief constraints / context go here (optional preamble).

   @goal: Parse the intake CSVs
   Ingest reviewer CSVs from the watch dir, validate headers, and reject
   malformed rows with a per-row reason. Objectives can span multiple lines
   and contain `code`, "quotes", or commands — no escaping needed.

   @goal: Normalize records
   Map raw rows onto the canonical schema and dedupe by record id.
   ```

   Delimiter contract:
   - A `@goal` line is a story boundary **only** when it starts at column 0 (no leading
     whitespace) and the character right after `@goal` is `:`, whitespace, or end-of-line. So
     `@goal: Title`, `@goal Title`, and a bare `@goal` line all open a story.
   - `@goalish`, `@goals:`, `@goal-foo`, and any indented or mid-line `@goal` are ordinary
     objective text, not delimiters. To keep a literal `@goal` line inside an objective, indent it.
   - A title-only block uses the title as its objective. An empty title borrows the first body
     line as the title. A block with **neither** title nor body is rejected — `goal init` errors
     instead of writing a placeholder goal.
   - **Preamble** (text before the first delimiter) is global context/constraints only; it is
     retained in the brief but never becomes a goal.
   - With **no** `@goal` delimiter anywhere, the whole brief becomes a single goal `G001`.

   Stories become `G001`, `G002`, … in order.
4. **Granularity — merge validation-coupled stories.** Before splitting into many thin stories,
   check coupling. Two stories are validation-coupled when they share any of: the same feature
   stack (one story's code cannot be meaningfully verified without the other's), the same
   acceptance surface, the same red-team surface, or the same final review boundary. Merge
   validation-coupled stories into ONE goal and fan out executor slices inside that goal instead
   of creating one goal per slice — one review/QA boundary, parallel implementation preserved.
5. Run `goal init --brief .cat/_session-{sid}/ultragoal/brief.md`. Inspect `goals.json` (Read is
   fine — only writes are restricted) and refine the brief + re-init if decomposition is wrong
   BEFORE any goal starts.
6. `state write` → `current_phase:"executing"`.

## Phase: executing — the goal loop

Goals execute **sequentially** — one goal fully through its completion gate before the next
starts. Pipeline overlap and validation batches are explicitly out of scope for v1: never overlap
one goal's implementation with another goal's review, and never defer a goal's review to a later
goal. Parallelism lives INSIDE a goal (executor slices, review lanes).

For each goal, first `pending` (or first `failed` when retrying):

1. `ledger append` `{"event":"goal_started","goal":"GNNN"}`, then
   `goal checkpoint --goal GNNN --status active`. Update `hud.nextAction`.
2. Implement against the goal objective — inline for small scope, delegated for big scope
   (mandatory rules below).
3. Run targeted verification for the goal (focused tests/commands proving the objective).
4. Run the **mandatory completion cleanup and review gate** (below). Only a clean gate may
   checkpoint `complete`.
5. Read the checkpoint result; continue to the next goal, or enter `review` when all goals are
   terminal.
6. If blocked or failed: append the evidence event, then
   `goal checkpoint --goal GNNN --status failed` (or `blocked`). Never leave a status change
   without a ledger event. Retry failed goals after their blocker work resolves.

### Mandatory implementation delegation on big scope

When a goal's implementation scope is **big enough**, you MUST delegate implementation to one or
more `executor` subagents (Agent tool, `subagent_type: cat-harness:executor`) instead of writing
the code inline. This is a hard requirement, not a preference: solo inline implementation of a big-scope
goal is a gate violation, and the completion gate must treat missing delegation on a big-scope
goal as a blocker.

Scope is **big enough** when ANY of the following hold:

- It spans **3+ files** or **2+ cleanly separable surfaces/modules** that can be implemented
  against bounded, independent acceptance criteria.
- It is estimated at **~200+ lines of net implementation change**, or is otherwise large enough
  that a single inline pass would crowd out your checkpoint/verification duties.
- It decomposes into **independent slices** that can proceed in parallel without shared-file
  contention.
- You have already made **2+ inline edit passes** on the same goal and implementation is still
  materially incomplete.

Forced-delegation rules:

- Split the goal into cleanly separable slices; give each `executor` bounded targets and explicit
  acceptance criteria; keep checkpoint/goal-state ownership with the leader.
- Prefer **parallel** `executor` subagents for independent slices; sequence only slices with a
  real dependency. When 2+ parallel executors would mutate files, isolate them — disjoint file
  sets, or a git worktree per executor with leader-owned integration.
- Before workers start, each per-slice contract MUST name: target files/surfaces, independence
  assumptions, allowed coordination channel, conflict-escalation rule, expected evidence, and
  terminal status. Record the split as a `delegation_note` ledger event.
- If a big-scope goal cannot be cleanly split, record the reason as a `delegation_note` and
  delegate the whole implementation to a single `executor`; you still own verification.
- Small, atomic, single-file changes below the thresholds stay with the leader — do not
  over-delegate trivial work.
- Workers never mutate `.cat/`, never run `cat-state.mjs`, never checkpoint, and return
  receipt-style evidence (files touched, commands passed, artifact paths) — not pasted bodies.
- An await timeout only limits your wait; it is NOT subagent failure evidence and must not be
  used as a cancellation reason. Inspect or continue independent work; cancel only on actual
  failure or unrecoverable drift. For failed or contract-violating slices, record ledger
  evidence, keep safe terminal slices, and reassign/retry or collapse to serial execution under
  an updated contract.

### Blocker triage and pause discipline

An active ultragoal run must not give up on a blocker by pausing and asking the user. Classify
every blocker before deciding, defaulting to `resolvable` when unsure:

- **`resolvable`** — anything the agent can act on: failing tests, missing implementation, a
  dependency to install, an ambiguous-but-inferable detail, investigation. **Never pause.**
  Exhaust autonomous resolution first: investigate; record a blocker goal (below); delegate an
  `executor`; or checkpoint `--status blocked` with ledger evidence and keep scheduling the next
  goal. Recording a `resolvable` classification is an audit note only; it never authorizes a pause.
- **`human_blocked`** — only the user can act: credentials/secrets, a manual or physical step, an
  external approval/decision, access the agent lacks. Pause is the last resort and is gated.

**Never pause without a `human_blocked` ledger event.** You may prompt the user (AskUserQuestion)
or end the turn on a blocker ONLY when the latest ledger event is `human_blocked`, appended
immediately beforehand and citing the specific human-only dependency:

```sh
node "${CLAUDE_PLUGIN_ROOT}/scripts/cat-state.mjs" ledger append --session <sid> \
  --json '{"event":"human_blocked","goal":"GNNN","evidence":"<the specific human-only dependency>"}'
```

Then update `hud.nextAction` with what the human must do. Unresolved review decisions are
recorded as durable blockers, not asked interactively.

**Blocker goals (record-review-blockers).** When verification or review finds issues you cannot
fix in place, spawn durable blocker work instead of giving up:
`ledger append '{"event":"review_blockers_recorded","goal":"GNNN","title":"Resolve verification blockers","objective":"<blocker-resolution objective>","evidence":"<architect/QA findings>"}'`
then `goal checkpoint --goal GNNN --status review_blocked`. Blocker objectives are
**ledger-tracked work items, NOT `goals.json` rows** — there is no goal-add verb in v1; the
`review_blockers_recorded` event IS the durable record. Work the blocker objective as if it were
a goal in its own right (delegation rules apply), append `blocker_resolved` with evidence when
done, then rerun the FULL completion gate on the original goal — or, if blocker resolution made
the original goal moot, checkpoint it `--status superseded` instead. A `review_blocked` goal
still blocks run completion until resolved.

### Try-harder nudges (budget: 10 per goal)

Each guarded give-up attempt — pausing, asking the user about resolvable work, dropping the run,
or claiming completion before the gate — consumes one nudge:
`ledger append '{"event":"nudge","goal":"GNNN","surface":"pause|ask|drop|early_complete","count":N}'`,
then apply the nudge to yourself:

> Ultragoal try-harder nudge (N/10) for GNNN: <surface> was refused before the normal gate.
> Resolving this is part of the goal, not a reason to stop. Try a different approach first:
> inspect the failure, run a focused test or replay, find local credentials/config if access is
> the blocker, split the obstacle into a recorded blocker goal, delegate an executor, or record
> concrete review blockers.

After 10 nudges for the same goal, stop nudging and proceed through the normal durable-blocker
path (`review_blocked` / `blocked` / `human_blocked`) — never through a weakened gate.

### Steering invariants

Real findings may change execution details, but the decomposition contract is protected:

- Never edit a goal's objective, the brief's constraints, quality gates, or completion status
  outside sanctioned checkpoints. Never hard-delete goals, auto-complete work, or weaken
  verification. Never silently mutate `.cat/…/ultragoal`.
- Record every decomposition-affecting decision — accepted AND rejected — as a `steering_note`
  ledger event with `evidence` and `rationale`. Broad natural-language steering is rejected, not
  guessed. Blocked goals without resolution are skipped for scheduling but still block final
  completion until explicitly resolved.

## Mandatory completion cleanup and review gate (per goal)

A goal cannot be checkpointed `complete` until this gate has run, in order:

1. **Targeted verification** — run the focused commands proving the goal objective; capture
   passed output.
2. **AI-slop cleanup sweep** — run `references/ai-slop-cleaner.md` as a **read-only generic
   subagent** (Agent tool, general-purpose read-only type — NOT executor): its instructions are
   the full fragment text plus the goal id, objective, and the goal's changed-files list. It is a
   detector only — it emits an `AI SLOP CLEANUP REPORT` and never edits anything. If there are no
   relevant edits it still runs and records a passed/no-op report. Every BLOCKING cleaner finding
   is a completion blocker: spawn an `executor` to fix blocking findings only, then rerun the
   cleaner until Blocking Findings is none. Advisory findings live in the gate report only —
   carry the report through `iteration.evidence`; never add a new top-level gate key, never write
   advisory findings to the ledger.
3. **Rerun verification** after the cleaner pass so reviewed evidence covers the cleaned code.
4. **Architect review** — delegate `architect` (Agent tool, `subagent_type: cat-harness:architect`) covering
   all three lanes: architecture-side (system boundaries, layering, data/control flow,
   operational risks); product-side (user-visible behavior, acceptance criteria, edge cases,
   regressions); code-side (maintainability, tests, integration points, unsafe shortcuts).
   Verdicts: `CLEAR`/`WATCH`/`BLOCK` per lane + `APPROVE`/`COMMENT`/`REQUEST CHANGES`.
5. **Executor QA/red-team lane** — delegate an `executor` to build and run the QA suite
   appropriate for the goal. This lane must try to break the change, not just confirm the happy
   path. It starts from the approved plan/spec/acceptance criteria, then user-facing contracts,
   and only then implementation code as supporting evidence. Plan/code mismatches are blockers,
   not items to paper over with implementation intent.
6. **Surface-matched evidence** — prove the change on the real surface under test; bare prose
   never proves live execution:
   - GUI/web: a real, non-uniform screenshot file under `artifacts/` (the CLI validates ≥4096
     bytes + PNG/JPEG magic) plus the automation/commands that produced it.
   - GUI/web **with a design source** (Figma URL or design-policy doc — from the deep-interview
     spec's `Design Source`, the plan, or asked from the user ONCE): additionally run
     `references/design-qa.md`, the design-verification evidence lane (goal-scoped policy
     extraction → Figma↔implementation mapping → Playwright capture at design breakpoints →
     computed-style comparison → severity-classified gaps). Unresolved Critical/Major design gaps
     are completion blockers (`qa.blockers`); its findings, policy doc, and screenshots feed
     `qa.evidence` and `qa.artifacts`. A design source that was provided but whose capture tool
     (Figma/Playwright MCP) is not connected is ALSO a blocker — the lane fails closed and nudges the
     user to connect the MCP (or use claude-in-chrome, or explicitly waive); it never silently degrades
     to inspection-only and passes. Likewise, a design source whose capture tool IS connected but whose
     live capture failed or was unreliable at runtime (browser crash/timeout, blank or error-page
     screenshot, MCP dropped mid-run) is a blocker too — `qa.status` `not-verified`, never a `passed`
     synthesized from the design spec or from reading the implementation source. A design verdict
     REQUIRES a real, on-disk, visually-inspected live render of the running component; reading the code
     is not a substitute. Only genuinely NO design source after asking once → skip the lane
     and note "design verification not applicable" in `qa.evidence`.
   - **Mechanical `qa.design` gate.** Whenever a design source is on record — in the deep-interview
     spec, the approved plan, OR the goal brief/objective (broadened trigger: any one of the three, not
     spec-only) — the sanctioned CLI additionally REQUIRES a complete `qa.design` measurement matrix
     (`references/design-qa.md`'s Evidence output contract has the exact JSON) and mechanically
     validates it: submitted `severity` values are NOT trusted — the CLI recomputes severity from
     `figma_expected`/`impl_actual` per the severity table and rejects the checkpoint if any unresolved
     Critical or Major remains. There are exactly two hatches, both same-ceremony, never a silent skip:
     `not_applicable` (only when no screenshot artifact exists and the goal's top-level
     `architect_review.design_not_applicable_acknowledged` is `true`) for genuinely non-UI
     design-sourced goals, and `waived` (Major only — a Critical is never waivable — requiring
     `user_acknowledged: true`, which the leader may set only after using AskUserQuestion to surface
     the specific Major to the user and getting explicit approval; the agent may never self-waive).
   - CLI: the actual passed command invocations with captured output, re-runnable as stated.
   - API/package/algorithm: a test-report artifact file or the passed test commands covering
     boundary/adversarial cases.
   Pick the red-team surface that matches what the change actually ships.
   The architect and QA lanes MAY run in parallel, but only on the same frozen post-cleaner
   change set, and both must join before checkpoint; fall back to sequential lanes when code is
   still changing or one lane's findings gate the other's scope.
7. **Delegation audit** — confirm big-scope work was delegated per the thresholds; missing
   delegation on a big-scope goal is a gate blocker.
8. **Clean check** — clean means: `architect_review.verdicts` architecture/product/code all
   `"CLEAR"` and `architect_review.recommendation` `"APPROVE"`; `qa.status` `"passed"` with
   `qa.commands` a non-empty array of the passed command invocations (e2e and red-team lanes
   included); `iteration.status` `"passed"` with `full_rerun: true`; every evidence field
   substantive and non-empty; every `qa.artifacts[].path` a real file; every `blockers` array
   present and empty; and `qa.design` (when required by the design-source trigger above) mechanically
   validated — no unresolved Critical/Major, and any `waived`/`not_applicable` hatch properly
   ceremonied (user-acknowledged Major-only waiver surfaced to the user first, or architect-acked
   not_applicable with no screenshot). `COMMENT`, `WATCH`, `REQUEST CHANGES`, `BLOCK`, missing evidence,
   plan/code mismatches, or non-empty blockers are non-clean.
9. **On any finding**: do NOT checkpoint `complete`. Record review blockers (see blocker goals
   above), resolve them, then rerun the full gate from step 1. Repeat until all lanes are clean.
10. **Checkpoint** — only after the loop is clean, write the gate JSON to a file (Write tool,
    e.g. under `artifacts/`) and run:
    ```sh
    node "${CLAUDE_PLUGIN_ROOT}/scripts/cat-state.mjs" goal checkpoint --session <sid> \
      --goal GNNN --status complete --quality-gate-json <path>
    ```
    The CLI enforces the gate fail-closed (`architect_review.verdicts` all `"CLEAR"` +
    recommendation `"APPROVE"`, `qa.status=="passed"` with non-empty `qa.commands`, artifact
    files exist and validate) — exit 2 with a reason means the gate is NOT satisfied; fix the
    underlying gap, never reshape the JSON to sneak past. On success it finalizes the goal row
    (status, `completed_at`, `updated_at = verified_at`) and mints a completion receipt
    `{plan_generation_sha256, quality_gate_sha256, ledger_event_id, verified_at}`:
    `plan_generation_sha256` is computed over the finalized goal row itself (minus the receipt),
    and `{plan_generation_sha256, quality_gate_sha256}` are anchored in the `goal_checkpointed`
    ledger row — so any later edit to ANY field of the goal row makes `receipt verify` fail.
11. **Verify the receipt** — `receipt verify --goal GNNN` must exit 0 before you state the goal
    is complete anywhere. Verify recomputes the hash over the CURRENT goal row minus the receipt
    and compares it, checks freshness (`goal.updated_at === verified_at`), the anchored
    `goal_checkpointed` ledger row, and the gate hash. Exit 2 (stale/tampered) means the goal is
    NOT complete: investigate, re-checkpoint if warranted, and never report around it.

### Quality-gate JSON shape

`--quality-gate-json` must use exactly this CLI-canonical shape (`cat-state.mjs` is the source
of truth; it validates `architect_review` and `qa` and ignores unknown keys — `iteration` is
kept for gjc fidelity):

```json
{
  "architect_review": {
    "verdicts": {
      "architecture": "CLEAR",
      "product": "CLEAR",
      "code": "CLEAR"
    },
    "recommendation": "APPROVE",
    "evidence": "architect review synthesis across architecture/product/code lanes",
    "blockers": []
  },
  "qa": {
    "status": "passed",
    "commands": ["npm test -- --run", "node scripts/smoke.mjs"],
    "evidence": "executor-built e2e and red-team QA commands/results",
    "artifacts": [
      { "path": ".cat/_session-<sid>/ultragoal/artifacts/GNNN-web.png",
        "kind": "screenshot", "description": "live web surface after change" }
    ],
    "blockers": []
  },
  "iteration": {
    "status": "passed",
    "full_rerun": true,
    "rerun_commands": ["npm test -- --run"],
    "evidence": "AI SLOP CLEANUP REPORT: PASS (rerun N); blockers absent or resolved and the full loop was rerun cleanly",
    "blockers": []
  }
}
```

`qa.commands` is the non-empty array of passed command invocations — the CLI requires exactly
this key; any other name for the command list fails the gate. `qa.artifacts` entries are
`{path, kind, description}` objects whose paths must be real files. Provide one `artifacts` entry per live surface actually exercised,
with the surface-appropriate `kind` from step 6. Evidence strings must be substantive — no
`todo`/`n/a`/placeholder filler.

## Phase: review — run-level audit

When every goal is terminal (`complete`, or explicitly resolved blockers), `state write` →
`current_phase:"review"`, then:

1. Run `receipt verify --goal GNNN` for EVERY goal. All must exit 0.
2. Confirm no goal remains `pending`, `active`, `failed`, `blocked`, or `review_blocked`.
3. Any stale/tampered receipt or unresolved goal → back to `executing` for that goal.

## Phase: complete — report

`state write` → `current_phase:"complete"`, `active:false`. Report a **receipts summary** —
receipt fields only, never pasted artifact bodies:

```
Ultragoal run complete — N/N goals receipt-verified.
GNNN <title> — complete, receipt verified_at <ts>, gate sha256 <first-12>   (one line per goal)
Ledger: .cat/_session-{sid}/ultragoal/ledger.jsonl (M events)
```

Never claim the run (or any goal) is done without `receipt verify` success in this turn's
transcript. If the user wants follow-up planning or clarification, invoke `cat-harness:ralplan`
or `cat-harness:deep-interview` only after ultragoal is terminal (chain guard).

## Constraints

- Leader-only state: only the main thread runs `cat-state.mjs`; workers return evidence, never
  checkpoint, never mutate `.cat/`.
- Sequential goal execution; parallelism only inside a goal (executor slices, joined review
  lanes). Pipeline overlap and validation batches are out of v1.
- team is explicit and separate: never auto-launch `cat-harness:team`; it never owns ultragoal
  goals, checkpoints, or ledger state.
- Recursion guard: subagents spawned by ultragoal never invoke cat-harness skills.
- Evidence over assertion: passed command outputs + real artifact files; receipts prove
  completion; `goals.json` status alone proves nothing.
