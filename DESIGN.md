# cat-harness — Design Contract

Claude Code plugin porting gajae-code's workflow philosophy:
**Interview before guessing / Plan before mutation / Execute with evidence / Parallelize when useful.**

Vague implementation requests auto-route through `deep-interview → ralplan → ultragoal (└ optional team)`
without any manual slash command, via a UserPromptSubmit router hook + in-skill LLM gates +
PreToolUse mutation guard + Stop completion gate.

This file is the SHARED CONTRACT. Every file in this plugin must agree with every token defined here
(paths, phase names, keywords, CLI flags, verdict vocabularies). Fidelity details beyond this contract
come from the gajae-code sources (see "Fidelity sources" at the bottom).

---

## 1. Surface (fixed, gajae-style minimal — never expand casually)

- **4 skills**: `deep-interview`, `ralplan`, `ultragoal`, `team`
- **4 agents**: `planner`, `architect`, `critic`, `executor`
- **4 hook events** (narrow, documented exception to "3 hook events" — G004 added `SubagentStop` for
  passive dialogue-excerpt capture only; it makes no gating decisions): `UserPromptSubmit` (router),
  `PreToolUse` (mutation guard + G004 dispatch capture), `Stop` (completion gate), `SubagentStop`
  (G004 reply capture)
- **1 sanctioned state writer**: `scripts/cat-state.mjs`
- **4 thin commands** (manual escape hatch): `/cat-harness:interview|plan|execute|team`
- **Dashboard is OUT-OF-SURFACE infrastructure, not a 5th skill/agent** (`dashboard/`, §10): a
  monitoring UI + status server layered over the `.cat` state this contract already defines. It never
  gates or adds a user-facing workflow, and it never touches any project's `.cat/**` at all — it only
  reads that disk state and renders it. It does hold exactly one narrow, honest exception to
  read-only: `POST /api/unregister`, a loopback-only endpoint that removes a root from the dashboard's
  OWN home-directory registry (`~/.cat-harness/registry.json`, never a project's `.cat/**`), symmetric
  with the hook's existing registration write into that same file (see §10). Adding the dashboard, and
  this one endpoint, does not change the 4-skill/4-agent count above; it lives alongside them, outside
  the count.

Lateral-panel personas (researcher / contrarian / simplifier) are prompt fragments inside the
deep-interview skill run as generic subagents — NOT plugin agents (keeps the 4-agent surface).

## 2. File tree

```
cat-harness/
├── .claude-plugin/
│   ├── plugin.json               # name "cat-harness", version (bump every release). Do NOT reference hooks here.
│   └── marketplace.json          # marketplace name "cat-harness", owner chussum, source "./"
├── hooks/
│   ├── hooks.json                # UserPromptSubmit / PreToolUse (Edit|MultiEdit|Write|NotebookEdit|Bash|Skill|Agent|Task) / Stop / SubagentStop
│   └── cat-hook.mjs              # single entry: node cat-hook.mjs <router|pretool|stop|subagentstop>
├── scripts/
│   └── cat-state.mjs             # sanctioned writer + ambiguity floor + receipts (node, zero deps)
├── skills/
│   ├── deep-interview/SKILL.md
│   ├── deep-interview/references/lateral-review-panel.md
│   ├── deep-interview/references/auto-answer.md
│   ├── ralplan/SKILL.md
│   ├── ultragoal/SKILL.md
│   ├── ultragoal/references/ai-slop-cleaner.md
│   ├── ultragoal/references/design-qa.md
│   └── team/SKILL.md
├── agents/
│   ├── planner.md  ├── architect.md  ├── critic.md  └── executor.md
├── commands/
│   ├── interview.md  ├── plan.md  ├── execute.md  └── team.md
├── dashboard/                     # OUT-OF-SURFACE infra (§1) — status server + monitoring UI
│   ├── server/                    # zero-dep Node status server + SSE (§10)
│   └── app/                       # Vite/React/FSD dashboard UI — the ONE build-time npm-dep
│                                   # surface (§9); README.md documents layout + dist regen
└── README.md
```

Dashboard runtime state does NOT live under this repo or any project's `.cat/`: it lives
EXTERNALLY, under the user's home directory (`~/.cat-harness/`, override `CAT_HARNESS_HOME`) —
`registry.json` (known project roots) and `server.json` (the live server's discovery record). See
§10 for the full shape. This is a deliberate separation: `.cat/` stays per-project and
git-ignorable; `~/.cat-harness/` is global, cross-project, and never committed.

hooks.json command form: `node "${CLAUDE_PLUGIN_ROOT}/hooks/cat-hook.mjs" <mode>` (node required; document in README).

## 3. State contract

Root: `<project cwd>/.cat/` — runtime-owned. Session tree:

```
.cat/
├── settings.json                                # user config: {"deepInterview":{"ambiguityThreshold":0.05}}
└── _session-{session_id}/
    ├── .session-activity.json                   # activity marker v2 (schema below), touched on every mutation
    ├── state/{skill}-state.json                 # per-skill mode state (envelope below)
    ├── state/audit.jsonl                        # append-only audit (nudges, invalid transitions, guard denials)
    ├── state/dialogue-pending.json              # G004: bounded FIFO per agentType, dispatch awaiting a reply
    ├── state/dialogue-excerpts.jsonl            # G004: append-only dispatch/reply excerpt pairs (round_trip_id)
    ├── specs/deep-interview-{slug}.md           # interview spec, header `status: pending-approval`
    ├── plans/ralplan/{run-id}/stage-{NN}-{stage}.md
    ├── plans/ralplan/{run-id}/index.jsonl       # {stage, stage_n, path, created_at, sha256} append-only, sha-dedup
    ├── plans/ralplan/{run-id}/pending-approval.md
    └── ultragoal/{brief.md, goals.json, ledger.jsonl}
```

G004 dialogue-capture shapes (hook-internal writer; §4's `dialogue append` CLI subcommand is the
alternative sanctioned path for the second one):

`state/dialogue-pending.json` — bounded FIFO array keyed per `agentType` (camelCase; hook-internal
record, popped and discarded once paired — never read by anything else):

```json
{ "cat-harness:executor": [ { "roundTripId": "uuid", "agentType": "cat-harness:executor", "dispatchExcerpt": "...", "dispatchedAt": "ISO8601", "promptId": "uuid|null" } ] }
```

`state/dialogue-excerpts.jsonl` — append-only, one JSON object per line, snake_case (matches the
rest of the on-disk JSON convention, §9): `round_trip_id` (shared by a paired dispatch+reply),
`role` (`"dispatch"|"reply"`), `agent_type`, `excerpt` (≤140 chars), `ts` (ISO8601), `prompt_id`
(metadata-only, may be `null`), `paired` (`true` when a FIFO match was found, `false` for an
unmatched reply), and the OPTIONAL `parent_agent_type` (Feature B, nested dispatch — see below;
**present only** when the dispatcher was itself a cat-harness subagent, OMITTED for a top-level
leader dispatch so the non-nested line stays byte-identical to the pre-Feature-B format):

```json
{"round_trip_id":"uuid","role":"dispatch","agent_type":"cat-harness:executor","excerpt":"...","ts":"ISO8601","prompt_id":"uuid|null","paired":true}
{"round_trip_id":"uuid","role":"reply","agent_type":"cat-harness:executor","excerpt":"...","ts":"ISO8601","prompt_id":"uuid|null","paired":true}
```

Nested (Feature B) — an executor that itself dispatched a critic. `agent_type` still names the
CHILD (critic); `parent_agent_type` names the dispatcher, so the UI renders `executor → critic`
instead of `Lead → critic`:

```json
{"round_trip_id":"uuid","role":"dispatch","agent_type":"cat-harness:critic","parent_agent_type":"cat-harness:executor","excerpt":"...","ts":"ISO8601","prompt_id":"uuid|null","paired":true}
{"round_trip_id":"uuid","role":"reply","agent_type":"cat-harness:critic","parent_agent_type":"cat-harness:executor","excerpt":"...","ts":"ISO8601","prompt_id":"uuid|null","paired":true}
```

Activity marker schema v2 (`.session-activity.json`):

```json
{ "updated_at": "ISO8601", "skills": { "deep-interview": "ISO8601", "ultragoal": "ISO8601" } }
```

`cat-state.mjs` merges its skill's timestamp into `skills` on every mutation; hook nudge writes
update `updated_at` only and PRESERVE the `skills` map. The Stop gate's fail-closed check keys
off `skills` (see §5).

Mode-state envelope (`state/{skill}-state.json`) — hooks rely ONLY on the starred fields; the rest is skill-owned:

```json
{
  "skill": "deep-interview",            // *
  "active": true,                        // *
  "current_phase": "interviewing",      // *
  "updated_at": "ISO8601",              // *
  "state_revision": 3,
  "threshold": 0.05, "threshold_source": "default",
  "current_ambiguity": 0.42, "reported_ambiguity": 0.42, "ambiguity_floor": 0.10,
  "round_count": 4, "rounds": [ ... ], "established_facts": [ ... ], "topology": { ... },
  "run_id": "ralplan run id when applicable",
  "hud": { "nextAction": "one-line status for router injection" },
  "stop_nudges": 0
}
```

Canonical phases:

| skill | phases (order) | initial |
|---|---|---|
| deep-interview | `interviewing → handoff → complete` | `interviewing` |
| ralplan | `planner → review → revision → post-interview → adr → final → handoff → complete` | `planner` |
| ultragoal | `goal-planning → executing → review → complete` | `goal-planning` |
| team | `starting → running → complete` (terminal alt: `awaiting_integration`, `failed`, `cancelled`) | `starting` |

PHASE_EDGES loop-backs beyond the listed order: ralplan adds `post-interview → revision`,
`final → revision`, and `planner → revision` (correction paths back into the consensus loop);
team adds `awaiting_integration → failed` and `awaiting_integration → cancelled` (demotion).

`STOP_RELEASING_PHASES = ["complete","completed","failed","cancelled","canceled","inactive"]`.
`handoff` deliberately does NOT release the Stop gate. deep-interview and ralplan are
**handoff-required / fail-closed**: if the activity marker's `skills` map records the skill but its
state file is missing/corrupt, the Stop gate still blocks. All other skills fail open.

Abort/terminal convention: aborting a run is ONE deactivation write
`{"active": false, "current_phase": "cancelled"}` (or `"failed"`) via the sanctioned writer —
edge validation skips deactivation writes, so this is legal from any phase. All SUCCESS terminal
writes also set `"active": false` (deep-interview `complete`, ralplan `complete` via `state clear`,
team `complete`); team `awaiting_integration` stays `active: true`. Defense in depth: the router's
active descriptor also skips entries whose phase is in `STOP_RELEASING_PHASES`.

Writer policy (G1 port): `state/**`, `ultragoal/goals.json`, `ultragoal/ledger.jsonl`, and
`plans/**/index.jsonl` may ONLY be mutated via `cat-state.mjs` (atomic tmp+rename, sha256 receipt
stamping, revision bump, floor clamp). Spec/plan **markdown bodies** may be written with the normal
Write tool. Skills return receipt fields (run_id, path, sha256, verdict) — never paste artifact bodies.

## 4. Sanctioned writer CLI (`scripts/cat-state.mjs`)

Zero-dependency Node (>=18). Subcommands (all take `--session <sid>`; stdin `-` accepted for JSON/file bodies):

```
init                                      # create session tree + activity marker
state read   [--skill s]                  # print state JSON (all skills if no --skill)
state write  --skill s --json <str|->    # validate envelope + phase edge, atomic write, revision++,
                                          # for deep-interview: recompute floor, clamp current_ambiguity=max(reported,floor)
state clear  --skill s                    # sentinel {active:false, current_phase:"complete"}
artifact write --workflow ralplan --run <id> --stage <NN>-<name> --file <path|->
                                          # sha256 + index.jsonl append (dedup by (stage,stage_n)+sha; refuse
                                          # different-content rewrite of same (stage, stage_n))
goal init    --brief <path|->             # parse @goal column-0 delimiters -> goals.json G001..GNNN
goal checkpoint --goal GNNN --status <s> [--quality-gate-json <path|->]
                                          # status=complete REQUIRES gate: architect_verdicts all CLEAR + APPROVE,
                                          # qa.status=="passed", evidence artifacts exist (screenshots >=4096 bytes,
                                          # PNG/JPEG magic), else exit 2 with reason. Mints receipt
                                          # {plan_generation_sha256, quality_gate_sha256, ledger_event_id, verified_at}
ledger append --json <str|->              # append-only ledger.jsonl event
dialogue append --json <str|->            # G004: append-only state/dialogue-excerpts.jsonl row
                                          # (role: "dispatch"|"reply"); CLI-accessible sibling of the
                                          # hook's own sanctioned inline writes (§5)
floor                                     # recompute deep-interview deterministic floor, print {floor, parts}
receipt verify --goal GNNN                # freshness: receipt exists, anchored ledger row exists, hashes match,
                                          # goal row untouched since verified_at; exit 2 on stale/tampered
```

Completion receipt v2 (field name `plan_generation_sha256` kept for continuity): at
`goal checkpoint --status complete`, AFTER the goal row is mutated (status, `completed_at`,
`updated_at = verified_at`), the CLI computes
`plan_generation_sha256 = sha256(canonical(goal row minus completion_receipt))` and anchors
`{plan_generation_sha256, quality_gate_sha256}` in the `goal_checkpointed` ledger row.
`receipt verify` recomputes the hash over the CURRENT goal row minus `completion_receipt` and
compares, and additionally requires freshness (`goal.updated_at === verified_at`), the anchor
ledger row to exist, and the gate hash to match — any post-verification edit to ANY goal-row
field (including `completed_at`) fails verify.

Mechanical design-QA gate (`goal checkpoint --status complete`, `validateQualityGate(gate, ctx, goalId)`):
when a design source is on record for the goal — a Figma/design URL found by scanning the
deep-interview spec's `Design Source` line, the approved plan (`plans/**`), OR the checkpointed
goal's own objective/title in `goals.json` (goalId-scoped so a sibling goal's URL never
false-triggers) — the gate additionally REQUIRES a `qa.design` measurement matrix and REFUSES the
checkpoint unless it is complete and clean. Each row `{surface, element, property, figma_expected,
impl_actual, severity}` has its severity RECOMPUTED by the CLI from `figma_expected`/`impl_actual`
against `design-qa.md`'s severity table (ordinal `Critical>Major>Minor>Trivial>None`); a submitted
severity more lenient than computed is rejected, and any unresolved Critical/Major fails the gate —
so the fix-then-remeasure loop is structurally forced, not self-declared. Mandatory coverage per
surface: font-size, line-height, font-weight (unless `no_text:true`) plus one of padding/margin/gap;
an unparseable MANDATORY row rejects, an unparseable OPTIONAL row is skipped with a non-throwing
`design_optional_row_skipped` audit note. Two audited escape hatches: `not_applicable{reason}`
(valid only with NO screenshot artifact present + a substantive reason + nested
`architect_review.design_not_applicable_acknowledged:true`), and `waived{reason, surfaces,
user_acknowledged}` (a **Major only**, never a Critical; requires `user_acknowledged:true` — the
leader must surface the Major to the user first per `design-qa.md`; the user, not the architect, is
the waiver authority). A goal with NO design source on record is byte-identical to the pre-gate
behavior. Disclosed residuals (the CLI is a zero-dependency verifier): fabrication (cannot prove a
measurement was taken), coverage-floor (cannot force the specific wrong element), ack-softness
(acks are leader-assembled), and chat-only links (a design URL only in free-text chat, never
persisted to spec/plan/goal, does not trigger).

Deterministic ambiguity floor (exact port):
`floor = clamp( 0.10 × disputed_facts + 0.05 × unscored_active_components + 0.05 × min(1, auto_answered_rounds / max(scored_rounds,1)), 0, 1 )`, rounded to 2 decimals.
- disputed fact = established fact with `disputed:true` and no non-empty `superseded_by`
- unscored component = active (non-deferred) component of a `status:"confirmed"` topology whose
  goal/constraints/criteria clarity_scores are not all finite numbers
Clamp applies to `current_ambiguity` and the LATEST scored round only; raw value preserved as
`reported_ambiguity`, floor recorded as `ambiguity_floor`. Historical rounds never rewritten.

Invalid phase transitions: append to `state/audit.jsonl` and refuse (exit 2). Trigger consistency
(fail-closed): a round carrying an `active` ambiguity-raising trigger must report ambiguity strictly
greater than the prior scored round, and the affected dimension must not improve.

## 5. Hook contracts (`hooks/cat-hook.mjs`)

Stdin: Claude Code hook JSON. Must never crash (top-level try/catch → fail-open exit 0, log to audit
when possible). No network, no LLM calls. Session dir from `session_id`; project root from `cwd`.

### `router` (UserPromptSubmit)
Always exit 0 with JSON `{hookSpecificOutput:{hookEventName:"UserPromptSubmit", additionalContext}}`.
additionalContext = bounded block (≤4 KiB, Tier-1 discipline):

```
<cat-harness-router>
state_root: .cat/_session-{sid} | helper: node "{PLUGIN_ROOT}/scripts/cat-state.mjs"
active: none | "{skill} phase={phase} ambiguity={a}/{t} next={hud.nextAction}"   ← stickiness: re-inject EVERY prompt while a run is live
[keyword: {skill} explicitly requested — invoke skill cat-harness:{skill} now]   ← only when keyword matched
[signals: file-path, code-fence, issue-ref | vagueness-cues: "not sure", scope-risk: "migration"]  ← advisory regex hints
Routing ladder — apply BEFORE acting; choose the smallest sufficient workflow:
1. Pure question / discussion / trivial reversible op → answer directly, no gating.
2. Implementation-shaped request with ambiguous intent, scope, or acceptance criteria → invoke cat-harness:deep-interview.
3. Requirements clear but non-trivial architecture/sequencing/verification risk (migration, security,
   breaking change, data loss, multi-system) → invoke cat-harness:ralplan.
4. Clear multi-goal / multi-step execution → invoke cat-harness:ultragoal.
5. 3+ independent parallel lanes → invoke cat-harness:team.
Escapes: prompt prefixed "!" or "force:" bypasses gating this turn. Explicit user workflow choice always wins.
Never implement from a spec/plan marked pending-approval without the user's explicit approval — "just do it" does not approve.
</cat-harness-router>
```

Keyword table (priority; first match wins, higher number outranks):
`consensus plan` | `$ralplan` → ralplan (9); `$deep-interview` | `deep interview` | `interview me` |
`don't assume` → deep-interview (8); `$ultragoal` → ultragoal (8); `$team` | `coordinated team` → team (8).
There is deliberately NO bare `ultragoal` keyword — only the explicit `$ultragoal` token routes.
Explicit-`$token` suppression: `$<skill>` / `$cat-harness:<skill>` tokens are parsed first and win
outright; any explicit-like `$word` token that is NOT a cat-harness skill suppresses ALL implicit
keyword matching for that prompt (so e.g. `$ralph` never falls through to an implicit match).
Advisory regex hints (never route on their own): vagueness cues `/not sure|unclear|vague|don't assume|어떻게든|알아서|대충/i`;
scope-risk `/migration|security|breaking change|data loss|마이그레이션|보안/i`;
auto-pass signals = file paths, `#\d+` issue refs, camelCase/snake_case symbols, numbered lists,
code fences, error/stack traces (their presence suggests ladder 1/3/4 over 2).

### `pretool` (PreToolUse, matcher `Edit|MultiEdit|Write|NotebookEdit|Bash|Skill|Agent|Task`)
Read active states. Blocking phases: deep-interview `interviewing`; ralplan `planner|review|revision|post-interview|adr|final`;
ultragoal `goal-planning`; team `starting`. While blocking:
- **Edit/Write/NotebookEdit**: deny (`permissionDecision:"deny"` + phase-boundary reason) UNLESS target
  path is inside `.cat/` and not a G1-protected file (state/**, goals.json, ledger.jsonl, index.jsonl — those
  are denied always with "runtime-owned — use cat-state.mjs").
- **Bash**: allow read-only commands and any `cat-state.mjs` invocation; deny commands matching write
  patterns (`>`/`>>` redirects, `tee`, `sed -i`, `rm/mv/cp` into non-.cat paths, `python|node|ruby -c/-e`
  containing `open(|writeFile|\.write(`, heredocs writing files, `git apply|patch`).
- **Skill**: chain guard — deny invoking a DIFFERENT cat-harness skill while the active one's phase is
  not `handoff` or terminal ("finish or hand off {skill} first"). Same-skill re-invocation allowed.
- **Agent/Task** (G004, additive — see the dedicated subsection below): PASSIVE dialogue-dispatch
  capture only. Placed immediately after the Skill branch (`tool_name` values are mutually exclusive,
  so this is provably isolated from the deny-logic above). Never emits `permissionDecision` — always
  falls through to exit 0 either way.
G1 protection of `.cat` state files applies even with no active workflow. Corrupt state → fail open (log).

### G004 dialogue-excerpt capture (`PreToolUse[Agent|Task]` dispatch half + `SubagentStop` reply half)
Passive, disk-only, best-effort capture of the prose exchanged with cat-harness's own subagents —
NEVER a gating decision, NEVER re-injected as additionalContext, NEVER affects the tool call. Scope is
namespaced `subagent_type`/`agent_type` values only (`cat-harness:planner|architect|critic|executor`);
`general-purpose` and any other non-namespaced dispatch is skipped silently.

- **Dispatch half** (`pretool`, `tool_name ∈ {Agent, Task}`): reads `tool_input.prompt` (dispatch prose)
  and `tool_input.subagent_type` (scope key). Extracts a ≤140-char excerpt — sentence-boundary aware
  (up through the first `.`/`!`/`?`), then hard-truncated regardless — and enqueues
  `{roundTripId, agentType, dispatchExcerpt, dispatchedAt, promptId}` onto a bounded FIFO queue per
  `agentType` in `state/dialogue-pending.json` (~50-entry cap, oldest evicted first). `prompt_id` is
  carried as `promptId` metadata only — see the pairing-strategy note below. **Feature B (nested
  dispatch):** also reads the dispatching payload's OWN `agent_type` — present only when this
  `PreToolUse[Agent]` fired from INSIDE a running subagent (a cat-harness agent that itself dispatched
  a subagent) — and, when it is itself namespaced `cat-harness:*`, records it as `parentAgentType` on
  the pending record. A top-level (leader) dispatch has no `agent_type`, so `parentAgentType` is `null`.
- **Reply half** (`subagentstop`, new mode): reads `agent_type` (scope key) and extracts the same
  ≤140-char excerpt from `last_assistant_message` (primary); if absent, a bounded tail-read
  (16 KiB) of `agent_transcript_path` then `transcript_path` is a fallback-only source, scanning
  backward for the last `{type:"assistant", message:{content:[{type:"text", text}]}}` entry.
  **Pops the OLDEST pending entry for the same `agentType`** (FIFO) from `state/dialogue-pending.json`
  and appends to `state/dialogue-excerpts.jsonl`: on a match, TWO lines sharing one `round_trip_id`
  (`{role:"dispatch",...}` then `{role:"reply",...}`, both `paired:true`); on no match (empty queue),
  ONE `{role:"reply",...,paired:false}` line. Emits NOTHING to stdout — no `decision`, no
  `additionalContext` — under any outcome, including errors (fail-open).
- **Pairing strategy (architect-ratified, G001 spike)**: FIFO-per-`agentType` is PRIMARY. `prompt_id`
  is recorded as metadata only and never drives pairing — a single sequential (n=1) capture cannot
  rule out `prompt_id` being shared across concurrent same-turn dispatches of the same `agentType`,
  which would make it unsafe as a pairing key. Known accepted degradation: under out-of-order
  completion of ≥2 concurrent same-`agentType` subagents, FIFO pairs the oldest pending dispatch with
  whichever reply arrives first — a cosmetic mispair (both halves are still recorded; only the
  cross-linking is wrong). `prompt_id` may be promoted to primary in a future goal if a concurrent-
  dispatch capture proves it unique-per-dispatch.
- **G001 spike verification (SPIKE-CONFIRMED, not assumed)**: a live capture
  (`.cat/_session-0e700c4d-16ed-43e7-9ab7-b4447bcda067/ultragoal/artifacts/phase2-spike-findings.md`)
  confirmed `session_id` and `cwd` are both present, and IDENTICAL, on the dispatching
  `PreToolUse[Agent]` payload and its paired `SubagentStop` payload — both resolve via `sessionOf()`
  to the SAME `.cat/_session-*` dir (**same-session-dir resolution: PASS**), so FIFO dispatch↔reply
  pairing writes to the correct tree rather than assuming it. The subagent's OWN identity
  (`agent_id`/`agent_type`) travels separately in the SubagentStop payload and is what scopes the
  FIFO queue; the session identity (`session_id`/`cwd`) is always the LEADER's. This reconfirms the
  disk-only guarantee above (capture never round-trips back into an LLM prompt) and the
  cat-harness-namespace scope (only `cat-harness:planner|architect|critic|executor` `agent_type`/
  `subagent_type` values are captured; `general-purpose` and other subagents are invisible to G004).
  Separately, the plan's F11 ambiguity ("왕복 첫 문장" / "round-trip first sentence") was resolved
  user-side as **BOTH halves** (Intent Reconciliation, `pending-approval.md`) — capturing the
  leader's dispatch excerpt AND the subagent's reply excerpt, not just one side — which is why this
  subsection has a dispatch half and a reply half at all.
- **Feature B nested-dispatch capture (LIVE-CONFIRMED, not assumed)**: a real nested capture
  (executor → critic; raw payloads in `.cat/nested-capture/cap-*.jsonl`, spike-only, deleted at
  cleanup) confirmed the G001 hypothesis: the INNER `PreToolUse[Agent]` (dispatching the critic)
  carries the EXECUTOR's own `agent_type: cat-harness:executor` + `agent_id`, i.e. the dispatcher's
  identity, sitting unused until now — whereas the OUTER (leader → executor) `PreToolUse` has NO
  `agent_type`. The INNER `SubagentStop` (critic) fired, and all four payloads shared one
  `session_id`+`cwd` → the SAME `.cat/_session-*` dir (nested same-dir resolution: PASS). Note
  `transcript_path` stays the LEADER's session transcript even for the inner dispatch; the child's own
  transcript is `agent_transcript_path` on `SubagentStop`, so `extractReplyExcerpt`'s tail-read
  fallback is unaffected. The hook threads the captured `parentAgentType` verbatim onto BOTH round-trip
  lines as `parent_agent_type` (omitted when null); the dashboard's `whoToWhomLabel` renders
  `{parent} → {child}` / `{child} → {parent}` when present, else `Lead → {child}` as before.
- **Writer policy**: `state/dialogue-pending.json` and `state/dialogue-excerpts.jsonl` live under
  `state/**`, so G1 auto-protects them from AGENT mutation tools. The hook's own inline writes (atomic
  tmp+rename, mirroring `audit.jsonl`'s append pattern) are sanctioned, as is the CLI's
  `dialogue append --json <str|->` subcommand (§4) — an alternative append-only path for the same file.

### `stop` (Stop)
If any skill state `active:true` and `current_phase ∉ STOP_RELEASING_PHASES` → `{decision:"block", reason}`
with a phase-specific next action (e.g. "deep-interview mid-round (ambiguity 0.42 > 0.05): ask the next
question via AskUserQuestion, or crystallize the spec"). deep-interview additionally requires a spec file
on disk before `handoff`/`complete` releases. Fail-closed set: {deep-interview, ralplan} — block when
the activity marker's `skills` map records the skill but its state file is MISSING or corrupt (same
fail-closed reason; the `stop_hook_active` escape still applies). Nudge budget: the stop hook
increments `stop_nudges` with a SANCTIONED INLINE write that restamps the envelope exactly like
cat-state.mjs (delete `content_sha256`, bump `state_revision`, recompute sha256 over key-sorted
canonical JSON) and touches only the activity marker's `updated_at` (never its `skills` map); after
10 nudges for the same phase, fail open with an audit warning. Block reasons for a stuck run must
show the working remediation invocation (the exact deactivation `state write` command). Always honor
`stop_hook_active` sanity: if state is unparseable AND `stop_hook_active` is true, fail open (no loops).

## 6. Workflow skill contracts (fidelity anchors — port prompt logic from gajae-code sources)

### deep-interview (`skills/deep-interview/SKILL.md`)
- Phase 0 (blocking): resolve threshold — precedence `.cat/settings.json deepInterview.ambiguityThreshold`
  → mode default (`quick` 0.6 / `standard` 0.5 / `deep` 0.35) → `0.05`. First output line MUST be
  `Deep Interview threshold: <percent> (source: <source>)`.
- Phase 0.5 Suitability Gate: clear bounded request (auto-pass signals present, criteria stated) → exit
  the skill and proceed directly; log the decision.
- Round 0: topology enumeration (components, deferred list) before any scoring.
- Loop: ONE question per round via AskUserQuestion (options + free-text Other maps to selected/other/custom);
  target the weakest dimension of the weakest component, rotate per component. After each answer, score
  dimensions 0.0–1.0 with justification (+gap when <0.9):
  greenfield `ambiguity = 1 − (goal×0.40 + constraints×0.30 + criteria×0.30)`;
  brownfield `ambiguity = 1 − (goal×0.35 + constraints×0.25 + criteria×0.25 + context×0.15)`.
  Multi-component: overall dimension = weakest across active components. Persist each round via
  `cat-state.mjs state write` (floor clamp happens there); report per-round: ambiguity, floor, weakest dim.
- Bidirectional triggers (A contradiction / B inconsistency / C evasive answer / D scope expansion):
  active trigger ⇒ lower affected dimension (no separate penalty), ambiguity must strictly rise.
  Contradicted facts: mark `disputed:true` — NEVER delete; resolve by re-confirmation or `superseded_by`.
- Lateral review panel at milestone bands (port from source): spawn researcher/contrarian/simplifier as
  parallel generic subagents with fragments from `references/lateral-review-panel.md`.
- Auto-answer (references/auto-answer.md): machine-answerable questions may be auto-answered with a
  clarity cap; auto-answered rounds feed the dilution term of the floor.
- Ontology stability escalation: score stalls ±0.05 for 3 rounds, or stays >0.30 after 8 rounds.
- End: ambiguity ≤ threshold (status `ready`; `refined` = 0.30 ≥ a > threshold) or explicit user early-exit.
  Dual pre-crystallization gates: closure audit + one-sentence restate confirmed by user.
- Artifact: `specs/deep-interview-{slug}.md`, header `status: pending-approval`, includes threshold+source,
  final scores, facts, topology, open items. Then AskUserQuestion handoff: **ralplan (recommended) /
  ultragoal / team / stop here**. Set phase `handoff` → chosen skill; never auto-execute.

### ralplan (`skills/ralplan/SKILL.md`)
- Pre-Execution Gate: vague execution request without auto-pass signals → offer deep-interview first.
- Loop (≤5 iterations): `planner` agent drafts plan + RALPLAN-DR deliberation summary → persist via
  `artifact write` (stage-`NN`-planner.md) → fresh `architect` (verdicts CLEAR/WATCH/BLOCK +
  APPROVE/COMMENT/REQUEST CHANGES) and fresh `critic` (OKAY/ITERATE/REJECT) review the SAME artifact
  (identified by path+sha256+stage_n), in parallel. Reviewer return discipline: architect/critic have
  no Bash and cannot run the writer, so each returns its full review BODY; the ORCHESTRATOR persists
  each body via `artifact write` and holds the receipts. Plan bodies are still never pasted by anyone.
  Join gate: Critic `OKAY` AND Architect `CLEAR`+`APPROVE` on the same artifact. Else consolidate feedback
  → re-spawn planner with prior artifact path + feedback (fresh-spawn model). After 5 failed loops present
  best version to the user.
- Post-consensus intent reconciliation: confirm every loop-made assumption with the user ONE AT A TIME
  via AskUserQuestion.
- Final: ADR-style plan → `pending-approval.md`. Explicit structured approval → phase `handoff` → default
  ultragoal (or team). "Sounds good"/"just do it" without the structured approval question does NOT approve.

### ultragoal (`skills/ultragoal/SKILL.md`)
- Decompose brief into `@goal` column-0 delimited units → `goal init` → G001..GNNN in goals.json.
- Execution: leader owns checkpoints (only main thread mutates goals.json/ledger.jsonl via CLI).
  Mandatory delegation to `executor` subagents when scope ≥3 files / ~200+ net lines / 2+ separable surfaces.
- Every status change = `ledger append` event. Blockers: spawn a new blocker goal
  (record-review-blockers) instead of giving up; pause only when latest ledger event is `human_blocked`.
- Completion per goal: run `references/ai-slop-cleaner.md` read-only pass → architect review (CLEAR + APPROVE)
  → QA evidence (passed commands, artifacts) → `goal checkpoint --status complete --quality-gate-json` —
  the CLI enforces the gate fail-closed and mints the receipt. Try-harder nudges are budgeted (10/goal).
- Design-QA evidence lane (`references/design-qa.md`): for web-UI goals with a design source (Figma
  URL / design-policy doc — captured as `Design Source` in the deep-interview spec, in the plan, or
  asked once), run goal-scoped design verification (policy extraction → Figma↔implementation mapping →
  Playwright capture at design breakpoints → computed-style comparison → severity-classified gaps).
  Unresolved Critical/Major gaps are completion blockers; findings/artifacts feed `qa.evidence`/`qa.artifacts`.
  A user-provided design source is captured VERBATIM through deep-interview → ralplan → ultragoal (never
  dropped). When a design source is present but its capture tool (Figma/Playwright MCP, or the
  claude-in-chrome path) is not connected, the lane **FAILS CLOSED** — it emits a `qa.blocker` and nudges
  the user to connect the MCP (or explicitly waive), rather than silently degrading to inspection-only and
  passing. Only a genuinely absent design source skips the lane. Test-case generation / reports / Jira are OUT of scope
  (the standalone Zigzag_web_QA skill covers those). Surface stays 4-skill: this is a reference fragment.
- All goals terminal → phase `complete`; report receipts summary (never claim done without `receipt verify`).

### team (`skills/team/SKILL.md`)
- Native subagent fan-out (NO tmux): use when 3+ independent lanes, each lane owns its verification.
- Task board `.cat/_session-{sid}/state/team-board.json` (via sanctioned writer): tasks with
  `{id, lane, status, owner, completion_evidence}`; evidence = ≥1 passed command or verified
  inspection/artifact reference. Leader spawns executor subagents per lane (worktree isolation when
  they mutate files in parallel), collects receipt-only results.
- Shutdown phase formula: all tasks evidence-complete → `complete`; work merged but integration pending →
  `awaiting_integration`; any failed/blocked or missing evidence → `failed`; work remaining → `cancelled`.

## 7. Agents (`agents/*.md`, CC frontmatter: name/description/tools/model)

Plugin agents register as `<plugin>:<name>` (verified against live plugin agent listings), so every
Agent-tool `subagent_type` token in skills is NAMESPACED: `cat-harness:planner`,
`cat-harness:architect`, `cat-harness:critic`, `cat-harness:executor` — never the bare name.

| agent | tools | model | essence |
|---|---|---|---|
| planner | Read, Grep, Glob, WebSearch, WebFetch, Bash(read-only discipline in prompt) | sonnet | drafts plans + RALPLAN-DR; receipt-only returns |
| architect | Read, Grep, Glob | opus | architecture+code review; CLEAR/WATCH/BLOCK + APPROVE/COMMENT/REQUEST CHANGES; evidence-cited findings |
| critic | Read, Grep, Glob | opus | plan-only actionability gatekeeper; OKAY/ITERATE/REJECT; checks testability, sequencing, rollback |
| executor | (omit tools → all) | sonnet | only write-capable role; follows plan stages; returns receipts + evidence |

All read-only agents: last non-empty line = a machine-parseable verdict. Exact formats —
architect: `VERDICT: <CLEAR|WATCH|BLOCK> + <APPROVE|COMMENT|REQUEST CHANGES>` (with the literal
` + ` separator); critic: `VERDICT: <OKAY|ITERATE|REJECT>`. Review bodies are persisted by the
orchestrator via artifact paths (see §6), never inline dumps of plan bodies.

## 8. Commands (thin escape hatches)

`commands/interview.md|plan.md|execute.md|team.md`: frontmatter description + one imperative line:
"Invoke skill `cat-harness:<skill>` now with the user's arguments; follow it exactly."

## 9. Conventions

- Language: skills/agents/docs in English (prompt reliability); README bilingual intro (Korean summary section).
- User-facing language (guaranteed via a ROUTER_LADDER line injected every prompt): questions
  (AskUserQuestion), progress updates, results, and spec/plan/findings bodies mirror the USER's
  language; state JSON (envelopes, goals.json, ledger, gate field values) stays English.
- Question register (ROUTER_LADDER line + deep-interview/ralplan skill rules): every question to
  the user is written in plain language for non-developers — technical terms are KEPT but glossed
  in parentheses on first use (learning-by-exposure, e.g. 마이그레이션(기존 데이터를 새 구조로 옮기는 작업));
  options are labeled by outcome, not mechanism. Simplify the language, never the decision.
- All JSON written by hooks/CLI: 2-space indent, trailing newline. All timestamps ISO8601 UTC.
- Never `console.log` debug noise from hooks (stdout is the contract). Errors → stderr + audit.jsonl.
- **Zero-dependency runtime, ONE deliberate build-time exception**: `hooks/`, `scripts/`, and
  `dashboard/server/` are pure Node builtins — no `npm install` is ever required to run the plugin
  or the status server. `dashboard/app/` (the Vite/React/FSD dashboard UI, §10) is the SOLE
  npm-dependency surface in the repo, and it is build-time only: its compiled `dist/` is committed
  to git so end users never run `npm install`/`npm run build` themselves
  (`dashboard/server/server.mjs` serves the committed `dist/` directly). Drift between the
  committed `dist/` and current `src/` is caught by `dashboard/app/scripts/check-dist-drift.mjs`
  (`npm run check-dist-drift`), which rebuilds into a scratch temp dir with the same
  `tsc -b && vite build` command and byte-diffs it against the committed `dist/` — the check itself
  is Node builtins only, so verifying the exception adds no new dependency. Rebuild/verify with
  Node ≥ 20.19 (Vite 8's floor) or the pinned toolchain: an older Node can emit a byte-different
  bundle and trip a drift false-positive. This affects contributors regenerating `dist/` only —
  end users just serve the committed static `dist/` and never rebuild.
- Version 0.3.0 everywhere — bump on every released change (the plugin cache is keyed by version; same-version pushes may not reach installed users).

## 10. Dashboard & Status Server Contract (`dashboard/server/`, `~/.cat-harness/`)

A single global, stateless, singleton Node status server (Node builtins only — no runtime deps) that
discovers every registered project's `.cat` tree and serves it over HTTP + SSE to the tycoon dashboard.
Disk is the sole source of truth: the server holds no authoritative in-memory state, it rebuilds by
rescanning `~/.cat-harness/**` and each registered root's `.cat/**` on boot and on every fresh
full-snapshot request. This section is additive to DESIGN.md's existing per-project `.cat` state
contract (§3) — it documents the NEW global, cross-project runtime directory the dashboard subsystem
introduces outside any single project.

**Home directory** (`~/.cat-harness/`, override via `CAT_HARNESS_HOME`):
- `registry.json` — `{ version: 1, roots: ["/abs/project/a", ...], updated_at: ISO8601 }`. Atomic
  tmp+rename write (`dashboard/server/registry.mjs`'s `upsertRegistryRoot`, mirrored inline in
  `hooks/cat-hook.mjs`'s router step). Roots are added only once a project's `.cat` directory already
  exists (registration gate — a bare `cd` into a fresh, uninitialized repo never adds a dormant floor).
  A dedicated `fs.watch` on this file (`watcher.mjs`) reconciles added/removed roots into the live
  per-project watcher set with no server restart. **Ghost-floor self-heal** (`registry.mjs`'s
  `pruneMissingRoots`): a registered root whose DIRECTORY no longer exists on disk (a deleted temp
  project, a moved repo) can only render as an empty, undismissable dormant floor and will never
  re-register itself, so the server prunes it — on boot, on every fresh snapshot, and on registry
  change — rewriting `registry.json` without it and broadcasting the same `removed` SSE event a real
  unregister uses, so open clients drop the ghost live. Prunes ONLY on the clear signal that the root
  path is absent, never merely because `.cat` is missing (a real project between runs legitimately has
  a root but an empty/absent `.cat`).
- `server.json` — `{ port, pid, token, boot_nonce, started_at }`. Written **only** after the server's
  own `listen()` call has already succeeded (never speculatively — a failed bind can never masquerade
  as live). `boot_nonce` (`crypto.randomUUID()`) + `started_at` make the singleton lifecycle race-safe
  (see Singleton lifecycle below).
- `launcher.log` — append-only JSONL, one structured line per launcher decision (`already_healthy`,
  `stale_discovery_file`, `started`, `bind_failed`, `bind_failed_foreign_port_owner`). Diagnostic only,
  never read by the server or hook.

**Port, token, idle shutdown** (`dashboard/server/constants.mjs`):
- Fixed default port **9223** (`DEFAULT_PORT`), override via `CAT_HARNESS_PORT`. Chosen adjacent to,
  and specifically to avoid, port 9222 (Chrome DevTools/Playwright/agent-browser remote debugging),
  which under the no-fallback rule below would otherwise silently fail to bind whenever Chrome remote
  debugging is active on the same machine. **No automatic port fallback ever** — a bind failure is a
  hard, logged failure (F16); `CAT_HARNESS_PORT` is an explicit, non-automatic escape hatch, never an
  automatic retry.
- A random per-boot health token (`generateToken()`, 24 random bytes hex) gates `/healthz` only.
  `/api/snapshot` and `/api/stream` are intentionally unauthenticated — the server binds to
  `127.0.0.1` only, so the loopback boundary is the actual access control for read-only dashboard data;
  the token exists solely to let the launcher/hook prove liveness, not to gate general API access.
- Idle auto-shutdown after 30 minutes of no request/SSE activity (`DEFAULT_IDLE_MS`, override via
  `CAT_HARNESS_IDLE_MS`, `<= 0` disables it — test-only escape hatch).

**The one mutating endpoint — `POST /api/unregister` (`dashboard/server/server.mjs`,
`dashboard/server/registry.mjs`'s `removeRegistryRoot`)**: the server is honest about no longer being
*strictly* read-only, but the mutation this endpoint performs is narrow and symmetric with the hook's
own existing registration write. It is the real, server-side "폐업 처리" (close/retire a dormant
floor) — replacing an earlier client-side-only localStorage hide that never touched disk. Body
`{ "root": "<projectRoot>" }`; removes that root from `~/.cat-harness/registry.json`
(resolved-path compare, atomic tmp+rename, mirroring `upsertRegistryRoot`) — a root that isn't present,
or a missing registry.json, is a no-op success, never an error. **Loopback-only, strictly**: on top of
the server's existing `listen(port, "127.0.0.1")` bind, the handler independently checks
`isLoopbackAddress(req.socket.remoteAddress)` and rejects (403) anything else — defense in depth
specifically because, unlike `/api/snapshot`/`/api/stream`, this one writes to disk. A malformed or
non-object body (unparseable JSON, missing/non-string `root`) is a 400, never a crash. On success the
response carries `{ ok: true, snapshot }` (the already-updated fresh snapshot), and the server also
broadcasts a `removed` SSE event (`sse.mjs`'s `broadcastRemoved`, `{ root }`) so every OTHER
already-connected dashboard client drops that floor immediately too — the drop counterpart to the
existing per-project `delta` broadcast, added because a registry removal previously had no live-client
notification at all (silently correct only for a client's *next* full reconnect). A project reappears
automatically the moment its hook re-registers it (its `.cat` directory already existing is the
existing registration gate above) — there is deliberately no separate "restore" affordance anymore.
**Client-side failure feedback**: the browser's unregister call (`features/floor-unregister`'s
`useUnregisterFloor`) never throws, but it now reports a non-OK/rejected request through an `onError`
callback so `DashboardPage` can show a transient error banner ("폐업 실패 — 상태 서버 실행 중인지 확인").
Previously the failure was swallowed silently, so an unregister against a down/unreachable server
looked identical to nothing happening ("폐업 눌러도 안 사라짐") — the banner makes that visible.

**Singleton lifecycle (compare-and-delete, `dashboard/server/singleton.mjs`)**: on graceful or idle
shutdown, the server re-reads `server.json` fresh from disk immediately before unlinking and deletes it
**only** on an exact `pid` AND `boot_nonce` match against its own in-memory identity. A mismatch (a
newer instance already overwrote the file) skips the unlink and logs — an old instance's shutdown can
never delete a newer instance's live discovery file.

**Auto-start (router hook → detached launcher, G003, `hooks/cat-hook.mjs` + `dashboard/server/launcher.mjs`)**:
1. On every `UserPromptSubmit`, the router does a **cheap, local, synchronous** liveness pre-check —
   `fs.readFileSync` + `process.kill(pid, 0)` (never signals; throws if no such process) **plus** a
   well-formed `boot_nonce` shape check — wrapped in its own try/catch, fully isolated from the
   router's emitted `additionalContext` block. It also upserts the current project root into
   `registry.json` (gated on `.cat` already existing). Neither step ever performs network I/O — Node
   has no synchronous HTTP client, and the hook stays on its existing fast/fail-open budget.
2. If the pre-check finds the discovery file missing, stale (dead pid), or malformed, the router
   spawns `dashboard/server/launcher.mjs` **detached and `unref()`'d** and returns immediately —
   the spawn cost is paid once per cold start/idle cycle, not per prompt.
3. The launcher (a separate process, off the hook's timing budget) is the **only** place allowed to
   make the authoritative network call: an HTTP GET to `http://127.0.0.1:<port>/healthz?token=<token>`
   against whatever `server.json` currently says. A healthy `200 {ok:true}` response means a live
   cat-harness server already exists — the launcher exits without starting a second one. Any other
   outcome (no discovery file, connection refused, timeout, bad token, malformed body) is treated as
   unhealthy, and the launcher starts a fresh server in-process (reusing `dashboard/server/server.mjs`),
   becoming the running server itself (mirrors `dashboard/server/index.mjs`'s own SIGINT/SIGTERM
   handling) once `listen()` succeeds.
4. **No port fallback (F16).** If starting a fresh server hits `EADDRINUSE`, the probe above has
   already ruled out a *healthy* cat-harness instance holding that port — so whatever is bound there
   is a foreign occupant (or an unhealthy one). The launcher logs one structured
   `bind_failed_foreign_port_owner` line to `launcher.log`, calls `shutdown()` to release its watcher,
   and exits cleanly. It never retries another port and never lets the failure surface as a hook error
   (the router already returned long before the launcher even started).

**PID-reuse posture (advisory pre-check, accepted residual risk)**: the router's sync liveness
pre-check is **advisory only**, never authoritative. `process.kill(pid, 0)` can succeed not because the
original server is alive, but because the OS reassigned that exact pid to an unrelated process after
the real server died — the hook would then wrongly conclude "alive" and never spawn a launcher. The
`boot_nonce` shape check narrows this (rules out missing/corrupt/stale-format `server.json`), but the
narrower case of a *reused pid* whose `server.json` content still happens to parse as well-formed
remains a real, if rare, residual edge (large pid space on macOS makes near-term reuse uncommon). This
is accepted rather than engineered away with a network probe in the hot hook path (which would
reintroduce exactly the network-in-hook risk F16/the hook contract forbids) — the launcher's own
health-token probe is the actual source of truth and self-corrects any false positive that reaches it:
a foreign process squatting on a reused pid does not know the token in `server.json`, so the probe
fails and the launcher starts a fresh server. **Operator remedy** for the vanishingly rare case where
even the token happens to still validate (or the launcher itself cannot reach the port): delete
`~/.cat-harness/server.json` — the next hook call relaunches cleanly.

**Watch / debounce / SSE contract** (`watcher.mjs`, `sse.mjs`, F17 — no polling, ever): one
`fs.watch({recursive:true})` per registered project's `.cat` directory, plus a dedicated watch on the
home `registry.json`. Any event (including ordinary atomic tmp+rename writes) is treated only as a
trigger for a full, coarse re-read — never byte-level diffing — debounced 100-200ms
(`WATCH_DEBOUNCE_MS`) so a rapid multi-file write burst coalesces into one re-read. `/api/stream`
sends a full snapshot on every (re)connect (rebuilt fresh from disk, never replayed in-memory state —
F18-style guarantee: a missed watch event self-heals on the next reconnect), then `delta` events
afterward as a per-changed-project full resend, and `removed` events (`{ root }`) when a project drops
out of the registry — most directly via `POST /api/unregister` above, which broadcasts its own removal
synchronously rather than waiting on the debounced registry watch, though a root removed by any other
means (e.g. `registry.json` hand-edited) is still caught and broadcast the same way once the watch
fires. SSE connection presence and requests both count as activity for the idle timer.

**MCP-friendly JSON note**: `dashboard/server/snapshot.mjs`'s `buildSnapshot`/`buildProjectSnapshot`
output (`{schemaVersion, generatedAt, projects: [{root, lit, sessions: [...]}]}`) is plain,
stable-keyed, function-free JSON by construction — safe for a future MCP bridge to consume unchanged.
No MCP server or bridge is implemented by this contract; the shape is designed to already be that
friendly on day one.

**Dashboard UI structure (`dashboard/app/`, Feature-Sliced Design slice map)**: `shared/` (SSE
client + TS types mirroring the server's snapshot shape, `cn()` class-merge helper, shadcn/ui-style
primitives) → `entities/` (`project`, `floor`, `cat` — pure snapshot→model mappings plus
presentational rendering) → `features/` (`floor-inspect`, `cat-inspect`, `scene-controls`) →
`widgets/` (`office-scene` the building + cats + speech bubbles, `side-panel` goals/phases/
receipts/dialogue timeline, `floor-list` quick-jump nav) → `pages/dashboard` (composition root).
This is the build-time npm-dependency surface described in §9; see `dashboard/app/README.md` for
the full layout, the committed-`dist`/drift-check mechanism, and asset provenance.

## Fidelity sources (read before writing)

- Original gjc skill/agent sources (VERBATIM inspiration):
  `/private/tmp/claude-501/-Users-hyungjoo-Projects-private-cat-workflow/0e700c4d-16ed-43e7-9ab7-b4447bcda067/scratchpad/gajae-code/packages/coding-agent/src/defaults/gjc/skills/{deep-interview,ralplan,ultragoal,team}/`
  and `.../src/defaults/gjc/agents/` (planner/architect/critic/executor if present; else grep defaults for role prompts).
- Structured analysis (mechanisms incl. exact formulas, guard regexes, stop semantics):
  `/private/tmp/claude-501/-Users-hyungjoo-Projects-private-cat-workflow/0e700c4d-16ed-43e7-9ab7-b4447bcda067/tasks/wlzt4vg1r.output`
  — extract with: `jq -r '.result.map[] | select(.key=="<KEY>") | .key_mechanisms[] | "### \(.name)\n\(.how_it_works)\n"' <file>`
  keys: deep-interview, ralplan, ultragoal, team-and-agents, auto-gating, state-and-evidence, cc-plugin-surface, philosophy-docs;
  gap-check corrections: `jq -r '.result.gap'`.
