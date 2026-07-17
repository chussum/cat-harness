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
- **3 hook events**: `UserPromptSubmit` (router), `PreToolUse` (mutation guard), `Stop` (completion gate)
- **1 sanctioned state writer**: `scripts/cat-state.mjs`
- **4 thin commands** (manual escape hatch): `/cat-harness:interview|plan|execute|team`

Lateral-panel personas (researcher / contrarian / simplifier) are prompt fragments inside the
deep-interview skill run as generic subagents — NOT plugin agents (keeps the 4-agent surface).

## 2. File tree

```
cat-harness/
├── .claude-plugin/
│   ├── plugin.json               # name "cat-harness", version (bump every release). Do NOT reference hooks here.
│   └── marketplace.json          # marketplace name "cat-harness", owner chussum, source "./"
├── hooks/
│   ├── hooks.json                # UserPromptSubmit / PreToolUse (Edit|MultiEdit|Write|NotebookEdit|Bash|Skill) / Stop
│   └── cat-hook.mjs              # single entry: node cat-hook.mjs <router|pretool|stop>
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
└── README.md
```

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
    ├── specs/deep-interview-{slug}.md           # interview spec, header `status: pending-approval`
    ├── plans/ralplan/{run-id}/stage-{NN}-{stage}.md
    ├── plans/ralplan/{run-id}/index.jsonl       # {stage, stage_n, path, created_at, sha256} append-only, sha-dedup
    ├── plans/ralplan/{run-id}/pending-approval.md
    └── ultragoal/{brief.md, goals.json, ledger.jsonl}
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

### `pretool` (PreToolUse, matcher `Edit|MultiEdit|Write|NotebookEdit|Bash|Skill`)
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
G1 protection of `.cat` state files applies even with no active workflow. Corrupt state → fail open (log).

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
  Requires Playwright MCP (degrades to inspection-only with an explicit evidence note); Figma MCP
  preferred, REST-token or screenshot fallback. Test-case generation / reports / Jira are OUT of scope
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
- Version 0.2.0 everywhere — bump on every released change (the plugin cache is keyed by version; same-version pushes may not reach installed users).

## Fidelity sources (read before writing)

- Original gjc skill/agent sources (VERBATIM inspiration):
  `/private/tmp/claude-501/-Users-hyungjoo-Projects-private-cat-workflow/0e700c4d-16ed-43e7-9ab7-b4447bcda067/scratchpad/gajae-code/packages/coding-agent/src/defaults/gjc/skills/{deep-interview,ralplan,ultragoal,team}/`
  and `.../src/defaults/gjc/agents/` (planner/architect/critic/executor if present; else grep defaults for role prompts).
- Structured analysis (mechanisms incl. exact formulas, guard regexes, stop semantics):
  `/private/tmp/claude-501/-Users-hyungjoo-Projects-private-cat-workflow/0e700c4d-16ed-43e7-9ab7-b4447bcda067/tasks/wlzt4vg1r.output`
  — extract with: `jq -r '.result.map[] | select(.key=="<KEY>") | .key_mechanisms[] | "### \(.name)\n\(.how_it_works)\n"' <file>`
  keys: deep-interview, ralplan, ultragoal, team-and-agents, auto-gating, state-and-evidence, cc-plugin-surface, philosophy-docs;
  gap-check corrections: `jq -r '.result.gap'`.
