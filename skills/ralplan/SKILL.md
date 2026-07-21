---
name: ralplan
description: Consensus planning workflow — a planner agent drafts with RALPLAN-DR deliberation, fresh architect and critic agents review the same persisted artifact in parallel until join-gate consensus (iteration cap by risk tier — 5 for full/high-risk, 2 for lite/low-risk), then intent reconciliation, an ADR-style pending-approval plan, and a structured approval handoff to ultragoal or team. Use for clear-but-risky work — requirements known but non-trivial architecture, sequencing, or verification risk (migration, security, breaking change, data loss, multi-system; router ladder rule 3) — when the user says "consensus plan" or "$ralplan", or on an incoming deep-interview handoff. Planning only; never implements.
---

# Ralplan (Consensus Planning)

Ralplan runs iterative planning with this plugin's `planner`, `architect`, and `critic` agents until
consensus is reached, with **RALPLAN-DR structured deliberation** (short mode by default, deliberate
mode for high-risk work). Follow the steps below exactly and in order.

## Planning/Execution Boundary

Ralplan is planning only. It may inspect context and draft plan/spec/proposal artifacts, but those
remain `pending-approval` until explicit structured execution approval. Before that approval, do NOT
mutate product source, run mutation-oriented shell, commit, push, open PRs, invoke execution skills,
or delegate implementation. "Sounds good" / "just do it" / "skip planning" in free text does NOT
approve — only the structured approval option in step 8 does; anything else leaves
`pending-approval.md` pending.

Persist state and plan artifacts ONLY through the sanctioned writer — never edit
`.cat/_session-{sid}/state/**` or any `index.jsonl` directly:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/cat-state.mjs" <subcommand> --session <sid> ...
```

Referred to below as `cat-state`. Every subcommand takes `--session <sid>`. Bodies may be piped via
stdin (`--file -` / `--json -`). Plan **markdown bodies** outside state files may be written with the
normal Write tool when needed, but stage artifacts must go through `artifact write` so they are
sha256-stamped and indexed.

## Bootstrap (before anything else)

1. **Session id**: take `{sid}` from the `<cat-harness-router>` context block injected this turn
   (`state_root: .cat/_session-{sid}`). If absent, use the `.cat/_session-*/` directory with the most
   recent `.session-activity.json`. Run `cat-state init --session <sid>` (idempotent).
2. **Resume check**: `cat-state state read --session <sid> --skill ralplan`. If a state exists with
   `active:true`, a `run_id`, and a non-terminal `current_phase`, RESUME that run: reuse its `run_id`,
   read `plans/ralplan/{run_id}/index.jsonl` to find the latest persisted stage, and continue from the
   recorded phase. Never mint a second run for the same task.
3. **Run id** (new runs only): `{YYYY-MM-DD-HHMM}-{4hex}` in UTC, e.g. `2026-07-17-0930-a3f1`.
4. **Helper path**: resolve `${CLAUDE_PLUGIN_ROOT}/scripts/cat-state.mjs` to an absolute path now —
   subagents do not inherit the plugin-root variable, so every agent prompt must carry the resolved
   path plus `{sid}` and `{run_id}`.

Do NOT seed ralplan state until the Pre-Execution Gate below has passed.

## Pre-Execution Gate

Execution skills (`ultragoal`, `team`) implement bounded work; they are not scope-discovery lanes.
Ralplan needs a task specific enough to plan. Check the incoming request:

**Auto-pass signals** (specific enough — proceed): file path, issue/PR number,
camelCase/PascalCase/snake_case symbol, test runner, numbered steps, acceptance criteria, error
reference, code block, or escape prefix (`force:` / `!`). An incoming deep-interview handoff also
auto-passes: if `.cat/_session-{sid}/specs/deep-interview-*.md` contains a spec for this task, use it
as the planning input (pass its path to the planner) and skip the gate.

**Gated** (vague — e.g. "improve the app", "fix this", "make it better", "add authentication" with no
anchor): no signal and no spec → ask via AskUserQuestion: **Run deep-interview first (recommended)** /
**Proceed with ralplan anyway** / **Cancel**. On deep-interview: invoke skill
`cat-harness:deep-interview` now (ralplan state was never seeded, so no chain guard applies) and
stop here. On cancel: stop, write nothing.

Once the gate passes, seed state and log the gate decision:

```
cat-state state write --session <sid> --skill ralplan --json '{"skill":"ralplan","active":true,
  "current_phase":"planner","run_id":"<run_id>","hud":{"nextAction":"planner drafting plan"}}'
```

## Deliberation mode

Default mode is `short`. **Deliberate** mode forces high-risk deliberation: a pre-mortem (3
scenarios) plus an expanded test plan (unit/integration/e2e/observability). Enable it when the user
asks, or auto-enable for explicit auth/security, migration, destructive, incident, compliance/PII, or
public-API-breakage risk. Record the chosen mode in the planner prompt and in state (`"mode"` field).

**Reviewer diet (risk tier → reviewer model + iteration cap)**: deliberation mode also sets the risk
tier that governs which model reviews the plan and how many re-review passes are allowed before
escalating to the user. This is orthogonal to the join gate itself — the gate formula (step 4 below)
never changes; only who runs it and how many times.

- **HIGH-risk tier** (`reviewer_tier: "full"`) — the same trigger set as deliberate mode above
  (explicit auth/security, migration, destructive, incident, compliance/PII, or public-API-breakage).
  Reviewers = `opus`, iteration cap = 5 (the existing max — FIXED, unchanged).
- **LOW-risk tier** (`reviewer_tier: "lite"`) — everything else (short mode's default territory).
  Reviewers = `sonnet`, iteration cap = 2.

Record the tier alongside the mode in state. `state write`'s free-merge already accepts unknown
top-level keys (no `cat-state.mjs` schema change needed) — the state-write JSON examples now carry
two extra fields:

```
cat-state state write --session <sid> --skill ralplan --json '{"skill":"ralplan","active":true,
  "current_phase":"planner","run_id":"<run_id>","reviewer_tier":"lite","reviewer_model":"sonnet",
  "hud":{"nextAction":"planner drafting plan"}}'
```

For a high-risk run the same write instead carries `"reviewer_tier":"full","reviewer_model":"opus"`.

**Step 0 — reviewer-model smoke check** (run before committing to the low-risk `sonnet` reviewer
tier, ahead of the step-3 fan-out): "the reviewer was actually spawned with `model: sonnet`" has NO
automatable unit assertion — the Agent tool's per-spawn `model` parameter is a runtime contract
between this skill and the platform, not something `cat-state.mjs` or a unit test can observe. For a
`lite`-tier pass, do a cheap smoke check that a subagent can actually be spawned with `model: sonnet`
before relying on it for the real review; treat this as manual/smoke verification only, never as an
automated test assertion. On smoke-check failure, fall back in this order: (a) keep `opus` and defer
the diet for this run (`reviewer_tier` stays `"full"`), or, only if (a) is unavailable, (b)
mechanical-classify as a last resort. Do not start the step-3 fan-out for a `lite`-tier pass without
this smoke check having run (or having failed with a recorded fallback).

**Self-escalation rule**: if a `lite`-tier pass surfaces a HIGH-risk trigger mid-review (any
architect or critic finding that matches the HIGH-risk trigger set above), immediately escalate:
switch `reviewer_tier` to `"full"`, `reviewer_model` to `"opus"`, and the iteration cap to 5 for the
remainder of the run, even if some low-risk iterations were already spent. Record the escalation via
`state write` (the `reviewer_tier`/`reviewer_model` fields) and in the final ADR's **Risks** section
so the plan's audit trail shows why the tier changed mid-run.

## Artifact & receipt contract

Each stage persists via:

```
node <cat-state path> artifact write --session <sid> --workflow ralplan --run <run_id> \
  --stage <NN>-<name> --file <path|->
```

`<NN>` = zero-padded consensus pass number, `<name>` ∈ `planner | architect | critic | revision |
post-interview | adr | final`. The writer lands `plans/ralplan/{run_id}/stage-{NN}-{name}.md`,
appends `{stage, stage_n, path, created_at, sha256}` to `index.jsonl`, and refuses a
different-content rewrite of the same `(stage, stage_n)` — never rewrite a pass; bump `<NN>` for
another pass. A **receipt** is `{run_id, path, sha256, stage, stage_n}`.

**RECEIPT-ONLY rule**: role agents and this skill return/report receipts plus verdict/status fields
and a ≤10-line summary — NEVER paste a persisted plan body back into the conversation.

Pass counter `N` starts at 1. A pass = one planner artifact + its architect and critic reviews, all
sharing the same `NN`.

## Code-graph blast-radius (planner-only, best-effort — never for architect/critic)

Before the FIRST planner spawn of this run (step 1's initial pass), run one full `graph build` (no
`--changed-only`) — best-effort, non-blocking:

```
node <cat-state path> graph build --session <sid>
```

Treat a non-zero exit, `EXIT_USAGE` (Node < 22.13), or `{ok:false, skipped:"locked"}` as a silent,
non-blocking fallback — never block the planner turn on this. At step 5b (each subsequent planner
re-spawn within the SAME run — a revision pass), run `graph build --changed-only` instead (cheap;
the generation already advanced from the run-start full build).

If the task or an incoming deep-interview spec names specific file paths (cap 3), run
`graph query --file <path> --depth 2 --session <sid>` per file. When `ok:true` and `callers` is
non-empty, splice the pinned-format block below into the **planner** dispatch prompt at step 1 and
step 5b **ONLY** — this block is NEVER spliced into the architect or critic dispatch prompt (step
3's explicit negative instruction below; DESIGN.md §6 reviewer-independence invariant):

```
[blast-radius HINT — not source of truth{, possibly stale — incremental build; verify with Read/Grep}]
<file>: <N nodes>
  related: <symbol> (<kind>) — <file>, distance <N>
  ... (top ~8 entries by distance, one list — callers/dependents are the same
      underlying array in the current data model, do not render as two
      duplicate-content sections)
```

Fields per entry are exactly what `graph query` returns for `callers`/`dependents`: `symbol`,
`kind`, `file`, `distance` — never `line` (the API does not return a line number for caller/dependent
entries, only for the queried file's own `nodes[]`). Size bound: top ~8 entries by distance, ≤800
bytes total per file queried, ≤3 files per task. Prepend `(possibly stale — incremental build;
verify with Read/Grep)` to the block's header line whenever the queried file's `graph query`
response has `incremental_since_full_build:true` OR `stale:true`. When the graph is absent, Node is
below 22.13, or the query returns empty, inject nothing — silent fallback to the planner's own
Read/Grep/Glob guidance (`agents/planner.md`).

## Consensus workflow

1. **Planner draft** (phase `planner`). Spawn the `planner` agent (Agent tool,
   `subagent_type: cat-harness:planner`) ONCE with: the task (and deep-interview spec path if any),
   deliberation mode, resolved cat-state path + `<sid>` + `<run_id>`, the `[blast-radius HINT]`
   block when applicable (Code-graph blast-radius section above), and the instruction to persist
   its plan via `artifact write --stage 01-planner --file -` and return ONLY the receipt plus a
   ≤10-line summary. The plan MUST open with a compact **RALPLAN-DR summary**:
   - Principles (3–5)
   - Decision Drivers (top 3)
   - Viable Options (>=2) with bounded pros/cons
   - If only one viable option remains, explicit invalidation rationale for alternatives
   - Deliberate mode only: pre-mortem (3 scenarios) + expanded test plan
     (unit/integration/e2e/observability)
   - If the task carries a design source (deep-interview spec `Design Source` or a Figma/design URL in
     the request): the plan MUST copy that source URL VERBATIM into the plan body (never let it fall
     out of the plan), and its acceptance criteria MUST include design verification — UI goals will be
     gated by ultragoal's `references/design-qa.md` evidence lane at completion. If the design-
     verification capability (Figma/Playwright MCP or the claude-in-chrome path) is not yet connected,
     the plan records it as a **setup prerequisite** (the design-QA gate fails closed and nudges the
     user to connect it — it does not silently pass). Do not drop a design source just because the tool
     to check it is missing; surface the setup need instead.

   Await the planner; record its receipt. Do not paste the plan body.
2. **User draft review** *(only if the user asked for interactive review)*: present the
   Principles / Drivers / Options summary plus the artifact path via AskUserQuestion (Proceed to
   review / Request changes / Skip review). "Request changes" → treat the answer as consolidated
   feedback and go to step 5b (the writer allows the `planner → revision` edge for exactly this
   path). Otherwise proceed automatically.
3. **Review fan-out** (phase `review` — `state write` the transition, then spawn). **Do NOT inject
   any `[blast-radius HINT]` block into the architect or critic dispatch prompt below — they must
   independently form their own map via Read/Grep/Glob (`agents/architect.md`/`agents/critic.md`
   §"Code exploration priority"). Sharing an automated map here would correlate two reviews the
   consensus gate (step 4) depends on staying independent.** Launch a fresh
   `architect` (`subagent_type: cat-harness:architect`) and a fresh `critic`
   (`subagent_type: cat-harness:critic`) **in PARALLEL — both Agent calls in the same message** —
   against the SAME immutable planner artifact, identified by the receipt triple
   (`path`, `sha256`, `stage_n`). Critic is plan-only here and never consumes architect output, so
   the two lanes always run in the same parallel batch; if a critic pass ever had to evaluate
   architect findings, run it sequentially after the architect and apply the same join gate.
   Pass an explicit per-spawn `model` parameter on both Agent calls, set from the current
   `reviewer_tier` (Deliberation mode section): `model: opus` for `"full"`, `model: sonnet` for
   `"lite"`. The Agent tool's per-spawn `model` parameter takes precedence over the
   agent-definition frontmatter — `agents/architect.md` and `agents/critic.md` keep `model: opus`
   in frontmatter as the default/fallback (used when no tier is set, or the step-0 smoke check
   failed); do not edit those frontmatter files.
   Each review prompt must include: the artifact identity triple, "read the plan from that path on
   disk", and the return contract below. Neither agent can run the writer (no Bash) — each returns
   its review BODY for the orchestrator to persist:
   - **Architect lane**: challenge architecture, surface tradeoff tensions, and enrich thin plans
     with synthesis or missed sub-scope. Returns: a header echoing the reviewed artifact's
     `path`/`sha256`/`stage_n`, findings (severity + file + impact + fix), and last non-empty line
     `VERDICT: <CLEAR|WATCH|BLOCK> + <APPROVE|COMMENT|REQUEST CHANGES>` (with the literal
     ` + ` separator).
   - **Plan-only critic lane**: independently check quality, principle-option consistency,
     alternatives, risks, acceptance criteria, and verification; when the plan is thin, request
     concrete expansion rather than only defects. Returns: the same identity header, required
     changes, and last non-empty line `VERDICT: <OKAY|ITERATE|REJECT>`.

   Neither reviewer pastes the plan body back. On return, persist each review body via
   `artifact write --stage <NN>-architect --file -` and `--stage <NN>-critic --file -` (stdin
   heredoc), keeping both receipts.
4. **Review join gate**: before consensus, revision, reconciliation, finalization, or approval,
   verify BOTH architect and critic receipts/verdicts exist for the SAME planner artifact/pass
   (`path`, `sha256`, `stage_n` echoed in each review header match the planner receipt). If a lane
   reviewed a stale artifact, re-spawn that lane against the current receipt. Never finalize from
   only one review lane. **Consensus = critic `OKAY` AND architect `CLEAR` + `APPROVE`** for the same
   planner artifact/pass.
5. **Re-review loop** (tier-based cap — `full` = 5 iterations, unchanged; `lite` = 2 iterations; a
   mid-loop self-escalation per the Deliberation mode section immediately raises the cap to 5): any
   critic non-`OKAY` (`ITERATE` or `REJECT`) or architect result that is not `CLEAR`/`APPROVE` MUST
   run the same full closed loop:
   a. Collect architect + critic feedback (read the two persisted review artifacts from disk;
      consolidate findings and required changes into one compact feedback block).
   b. `state write` phase `revision`, increment `N`, run `graph build --changed-only` (Code-graph
      blast-radius section above), then **fresh-spawn** a new `planner` agent with: the PRIOR plan
      artifact path, the consolidated feedback, mode, writer coordinates, and the `[blast-radius
      HINT]` block when applicable — PLANNER dispatch only, same rule as step 1. (Claude Code
      subagents are not resumable; fresh-spawn with prior-artifact-path + feedback is gajae-code's
      own sanctioned fallback path.) It persists via `artifact write --stage <NN>-revision --file -`
      and returns receipt-only.
   c. `state write` phase `review`, then return to the step 3 fan-out with fresh architect + critic
      at the new `<NN>`.
   d. Re-join both verdicts for the same revised planner artifact/pass (step 4).
   e. Repeat until consensus or the current tier's cap (5 for `full`, 2 for `lite`) is reached.
   f. At the tier's cap without consensus, present the best version to the user via AskUserQuestion
      (pick the pass closest to consensus — prefer `CLEAR`/`APPROVE`/`OKAY` counts, no
      `BLOCK`/`REJECT`): **Use this version and continue** / **Give direction for one more
      user-directed pass** / **Stop here** (leave artifacts, `state clear`, stop).
6. **Post-consensus interview** (intent reconciliation gate; phase `post-interview` — `state write`
   the transition). Runs ALWAYS after consensus and before finalization. Goal: make sure ralplan did
   not silently bake in assumptions that conflict with what the user wants.
   a. **Collect open items** from the run: every assumption the planner/architect/critic resolved by
      assumption rather than by stated fact, every ambiguity flagged during review, and every
      decision the loop made without explicit user input. Source these from the persisted
      `planner`/`architect`/`critic`/`revision` stage artifacts on disk — not from memory.
   b. **Cross-check prior context for conflicts**: glob
      `.cat/_session-{sid}/specs/deep-interview-*.md` and other prior specs/plans relevant by topic.
      For each, list points where the consensus plan contradicts, weakens, or expands beyond a
      previously crystallized decision, constraint, or non-goal. Cite the conflicting artifact and
      line/section.
   c. **Reconcile with the user via AskUserQuestion (always, regardless of mode)**. Never stop idle
      with plain-text prose after the consensus loop. Phrase each confirmation in plain language
      with technical terms glossed in parentheses on first use (router question-style rule) — the
      approver may not be a developer.
      - If open items exist, confirm the open assumptions and conflicts **ONE AT A TIME**,
        weakest/highest-impact first, each with contextual options plus free text. If any
        confirmation reveals the plan diverges from user intent, route the consolidated correction
        back into the re-review loop (step 5b planner revision — the writer allows the
        `post-interview → revision` edge for this correction path) and re-run architect + critic
        before returning here. Cap at the same tier-based iteration ceiling (5 for `full`, 2 for
        `lite`).
      - If the plan is crystal clear (no open assumptions or prior-context conflicts), skip straight
        to the step 8 final-options question — do not invent filler questions.
      - For every confirmed open item, embed the resolved outcome into the final plan under an
        **## Intent Reconciliation** section so the pending-approval artifact records each decision;
        record any item the user explicitly defers as an open confirmation under that same section.
   d. Persist the reconciliation record via `artifact write --stage <NN>-post-interview --file -`,
      then track only the receipt plus a compact status: `reconciled-clean` /
      `reconciled-with-revision` / `open-confirmations-pending`.
7. **Finalize** — on reconciliation completion, re-check the review join gate (critic `OKAY` plus
   architect `CLEAR`/`APPROVE` for the same planner artifact/pass), then:
   a. `state write` phase `adr` and compose the final plan in ADR form. It MUST include the ADR
      sections — **Decision, Drivers, Alternatives considered, Why chosen, Consequences,
      Follow-ups** — and, when present, the **## Intent Reconciliation** section. Mark it
      `pending-approval` (header line `status: pending-approval`).
   b. Persist via `artifact write --stage <NN>-final --file -`, then `state write` phase `final`.
      Verify `plans/ralplan/{run_id}/pending-approval.md` exists (the writer copies `final` stages
      there); if it does not, Write the same final content to that path yourself (markdown body —
      permitted).
8. **Structured approval** — ALWAYS present the finalized plan via AskUserQuestion (never stop with
   plain text and no question; this is the gate's terminal action). Show the ADR summary (Decision,
   Drivers, Alternatives, Consequences) plus the `pending-approval.md` path — not the full body.
   Write the summary and options in plain language, glossing technical terms in parentheses on
   first use (router question-style rule).
   Options (free text is available via the tool's Other input):
   - **Refine further** — collect direction, run one more revision + review pass (steps 5b–5d; a
     user-directed pass is allowed even at the cap; the writer allows the `final → revision` edge
     for this path), then return here
   - **Approve execution via ultragoal (Recommended)** — goal-tracked autonomous execution
   - **Approve execution via team** — only when the work splits into 3+ independent parallel lanes
   - **Stop here** — keep the plan as `pending-approval` and make no further changes

   Only these structured selections (or an explicit execution-skill choice in the Other field)
   approve. Free-text "just do it" / "sounds good" outside this question does not — re-present the
   question and leave `pending-approval.md` pending.
9. **Handoff** — on approval, never implement directly:
   a. `state write` phase `handoff`:
      `cat-state state write --session <sid> --skill ralplan --json '{"skill":"ralplan","active":true,"current_phase":"handoff","run_id":"<run_id>","hud":{"nextAction":"handing off to <ultragoal|team>"}}'`
      (the PreToolUse chain guard only permits invoking another cat-harness skill from `handoff` or
      a terminal phase; `handoff` deliberately does NOT release the Stop gate, so finish the chain
      same-turn).
   b. Invoke skill `cat-harness:ultragoal` (default) or `cat-harness:team` (only when chosen) via
      the Skill tool, passing the approved plan path `plans/ralplan/{run_id}/pending-approval.md`
      and the run receipts.
   c. Immediately after the invocation returns and the callee's instructions are loaded — before
      executing any callee step — run `cat-state state clear --session <sid> --skill ralplan`
      (sentinel `{active:false, current_phase:"complete"}`), then follow the callee skill.

   On **Refine further**: return to the step 5 re-review loop. On **Stop here**: leave the
   `pending-approval` artifact, run `cat-state state clear --session <sid> --skill ralplan`, report
   the run's receipts summary, and stop.

## Phase map (state write on every transition)

| Step | `current_phase` |
|---|---|
| Planner drafting (initial) | `planner` |
| Architect + critic fan-out / join gate | `review` |
| Planner revision pass | `revision` (then back to `review`) |
| Intent reconciliation | `post-interview` |
| ADR composition | `adr` |
| Final persisted, awaiting structured approval | `final` |
| Approval captured, chaining to execution skill | `handoff` |
| Run terminal (handed off or stopped) | `complete` (via `state clear`) |

Every `state write` carries `run_id` and a one-line `hud.nextAction` (e.g. `"pass 3/5: architect
BLOCK — planner revising"`). Invalid phase edges are refused by the writer (exit 2) and audited —
transition in the order above. Loop-backs into `revision` are legal from `planner` (step 2
"Request changes"), `review` (step 5 re-review loop), `post-interview` (step 6c intent-divergence
corrections), and `final` (step 8 "Refine further"); every revision pass returns through `review`.

## Recovery

- Corrupt, tampered, or stale ralplan state for the current session:
  `cat-state state clear --session <sid> --skill ralplan` clears ONLY ralplan state for that
  session, then re-bootstrap.
- `artifact write` exit 2 ("refusing different-content rewrite"): you reused a `(stage, NN)` pair —
  bump `<NN>` to record another pass; never overwrite.
- A run interrupted mid-loop resumes via the Bootstrap resume check: latest `index.jsonl` row +
  recorded phase tell you exactly which step to re-enter.
