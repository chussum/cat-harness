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

Node >=18 for every subcommand, INCLUDING `graph build`/`graph query`, which are the ONLY subsystem
with vendored runtime dependencies: `web-tree-sitter@0.24.7` plus its JS/TS/TSX grammar `.wasm` files
(`scripts/vendor/tree-sitter/`, git-committed, loaded only by relative path — see
`scripts/vendor/tree-sitter/VENDOR.md`) for parsing, and `sql.js@1.14.1` (WASM SQLite,
`scripts/vendor/sql.js/`, git-committed, loaded only by relative path — see
`scripts/vendor/sql.js/VENDOR.md`) for storage. Both are dynamically imported only inside the graph
handlers, never at module top level, so an API drift in either vendored dependency can only ever break
these two subcommands — every other subcommand stays pure Node builtins. Neither vendored dependency
needs anything beyond Node's built-in `WebAssembly` (available since Node 8), so there is no Node
version floor specific to the graph subsystem — it works anywhere this plugin's own Node 18+ baseline
does. sql.js has no cross-process concurrency control of its own (it is memory-only); the entire
`graph build` read-modify-write critical section is instead guarded by a create-arbitrated
single-consumer lock file (`.cat/graph/graph.db.lock`) — see the concurrency note below the subcommand
table. Subcommands (all take `--session <sid>`; stdin `-` accepted for JSON/file bodies):

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
design diff  --figma <path|-> --impl <path|->  # design-QA lane authoring aid: join the extracted Figma sized-node
                                          # inventory against live-DOM measurements by (surface,element,property);
                                          # emit gate-ready qa.design rows (severity via the SAME computeSeverity()
                                          # the checkpoint gate uses) only for well-formed pairs; refuse (exit 2) on
                                          # any unmeasured (extracted-but-not-measured) or malformed pair — the
                                          # mechanical two-numbers rule. Read-only: touches no session state.
design visual --figma <path> --impl <path>     # design-QA lane authoring aid: pure-Node PNG pixel-diff (no
  [--major-threshold N] [--block-threshold N]  # dependency; node:zlib.inflateSync only). Decodes both PNGs
  [--exclude <json>]                           # (colorType 0/2/4/6, 8-bit, non-interlaced only), letterboxes +
                                          # box-average downscales onto a common canvas, classifies None/Major/
                                          # Blocking. Blocking is decided from raw_diff_ratio ALONE (before
                                          # exclude_regions) — never waivable, same code-shape as numeric
                                          # Critical. Read-only: touches no session state (--block-threshold is
                                          # diagnostic-only; the checkpoint gate always resolves the threshold via
                                          # .cat/settings.json designQa.visualDiffBlockThreshold, default 0.75).
graph build  [--changed-only]             # Node 18+: parse tracked JS/TS/TSX with the vendored Tree-sitter
                                          # runtime, upsert into REPO-scoped .cat/graph/graph.db (sql.js/WASM
                                          # SQLite). A create-arbitrated lock file serializes concurrent
                                          # builds (exit 0, {ok:false, skipped:"locked"} on contention — never
                                          # blocks, never crashes). --changed-only skips files whose sha256 is
                                          # unchanged; a leftover -wal/-shm sidecar forces one full rebuild
                                          # regardless (see Known limitations below). Fail-open per file: the
                                          # vendored 0.24.7 parser is known to emit a false-positive
                                          # parse_status:"partial" on some large valid files (e.g. this repo's
                                          # own cat-state.mjs, ~70 KiB — see tree-sitter VENDOR.md); it still
                                          # keeps whatever nodes/edges it managed to extract rather than
                                          # aborting the build. The graph is a HINT, not a source of truth.
graph query  --file <path> [--depth N]    # Node 18+: read-only BFS over call/import edges from
                                          # .cat/graph/graph.db for one file's own nodes plus transitive
                                          # callers/dependents up to --depth (default 2). Takes no lock (reads
                                          # the last atomically-renamed-into-place file). HINT, not a source
                                          # of truth — verify critical-path facts with Read/Grep (§9).
```

**Concurrency model — create-arbitrated, best-effort single-consumer lock file**: sql.js is a
memory-only engine with no cross-process locking, so `graph build`'s entire read-modify-write is
guarded end-to-end by `.cat/graph/graph.db.lock` (git-ignored, sibling of `graph.db`). The winner is
decided ONLY by operations that hand the loser an explicit failure — exclusive create
(`open(...,"wx")`, i.e. `O_EXCL`) and a single-consumer `rename()` of the shared lock file itself.
**"Overwrite an existing shared target, then re-read to confirm" is banned outright as a lock
arbiter** — `renameSync` over an existing target always succeeds regardless of whether the target
existed, so it gives the loser no failure to detect, and two earlier designs of this same lock both
independently reproduced a lost-update race for exactly that reason. Staleness is judged by
`process.kill(pid, 0)` (ESRCH ⇒ dead) OR a TTL (`GRAPH_LOCK_TTL_MS`, default 60000ms, derived from a
measured full-build wall-time with 10x headroom — see `scripts/vendor/sql.js/VENDOR.md`; override via
`CAT_GRAPH_LOCK_TTL_MS`); corrupt/empty lock content falls back to the lock file's own mtime for the
TTL decision, so a holder that crashed between creating the lock and writing its body still ages out.
The retry loop is capped (50 attempts) to avoid livelock, failing open to `{ok:false,
skipped:"locked"}`. **Behavior change from the previous `node:sqlite` engine**: `node:sqlite`'s WAL +
`busy_timeout` (~5s) waited out contention; this lock fails open *immediately* on contention instead
(no wait) — acceptable for a repository-scoped single DB, since a concurrent lane's own rebuild
eventually repopulates it, but it does shift the freshness/skip-rate profile, worth knowing if `graph
build` calls show up as `skipped:"locked"` more often than the old engine's occasional busy-wait.

**Known limitation — the lock is best-effort mutual exclusion, not exactly-one-winner**: the
stale-lock reclaim above is a content-blind `rename()`, so under RARE contention on a lock left stale
by a crashed builder, a slow racer can rename away a *different*, freshly created live lock instead of
the stale generation it judged, letting two builders believe they both hold it and both proceed to
build. This is not limited to 3+ simultaneous builders — it can occur with as few as two, because the
reclaiming racer's own immediate retry (re-creating the lock) can itself race a second racer's delayed
rename of the same path; more racers only make the window easier to hit, not required to open it at
all. (An earlier revision tried to close this with a content-reverify-then-`link()`-restore step; that
restore itself could lose a further race under 3+ racers and silently drop the live lock it was
restoring, orphaning the real holder — a lost-update strictly worse than the case it was guarding
against, while still not achieving exactly-one-winner even for two racers — so it was removed rather
than chased further; stale-lock reclaim races are a known-hard problem and this lock does not claim to
solve them exactly.) This is safe to leave best-effort because the actual data-integrity guarantee for
`graph.db` does not come from the lock at all — it comes from the atomic
`db.export()` → tmp file → `renameSync` commit in `cmdGraphBuild` (see the write path above): every
write is a complete, valid SQLite snapshot of the same repository, `PRAGMA integrity_check` is always
`ok`, and two overlapping builders can at worst produce a redundant rebuild whose result is atomically
replaced by the other's valid snapshot — never a corrupt or torn `graph.db`. Scope: this relies on
local-filesystem `O_EXCL`/`rename()` atomicity (see the NFS caveat in
`scripts/vendor/sql.js/VENDOR.md`).

**Known limitation — `--changed-only` cross-file staleness**: `--changed-only`
is a fast incremental mode that skips reparsing any file whose sha256 is
unchanged, so it never recomputes inbound cross-file edges for dependents
that were not reparsed. After a cross-file symbol rename or removal, a
dependent file's caller/import edges into the renamed/removed symbol can
persist as dangling even though the renamed file's own `stale` field (a
sha256 comparison scoped to that one file) correctly reports `false` — a
silent false negative on `graph query`'s caller/dependent data. Mitigation:
run a full `graph build` (no `--changed-only`) after a cross-file rename for
correct results. `graph build` records the build mode and a full-build
generation counter in the `meta` table (`last_build_mode`,
`full_build_generation`); `graph query` surfaces this as
`incremental_since_full_build:true` whenever the most recent build was
`--changed-only`, so callers can treat cross-file caller/dependent data as
possibly stale even when `stale` is `false`, without paying for the
expensive full inbound-edge recompute on every query.

**Empty-DB first-build false positive**: `last_build_mode` is set from the `--changed-only` flag
alone, not from whether the DB was actually empty beforehand — so calling `graph build
--changed-only` as the very FIRST build ever (a cold-start empty DB) still sets
`incremental_since_full_build:true` on the following `graph query`, even though every file was
freshly parsed from empty and no dangling cross-file edge is even possible yet
(`scripts/cat-state.test.mjs`, the empty-DB fixture mirroring the rename-staleness fixture above).
This is why `graph build`/`graph query` are ALSO invoked automatically by the orchestrator skills
(`skills/{ralplan,ultragoal,team}/SKILL.md`, planner/executor dispatch only — see §6 Code-graph
automation): one full `graph build` (no `--changed-only`) at run-start sidesteps the false positive
entirely, with `--changed-only` used only at later phase-starts within the same run once a full
build has already established a clean `full_build_generation`.

**Legacy `-wal`/`-shm` sidecars (sql.js migration)**: a `graph.db` built by the previous `node:sqlite`
engine (WAL journal mode) may leave `graph.db-wal`/`graph.db-shm` sidecar files behind if a build
crashed mid-write. `graph build` deletes both on sight (best-effort) at the start of every invocation
and — since sql.js reads only the main `.db` file and knows nothing about WAL sidecars, so their
presence is itself the signal that this DB predates the migration and may be missing an uncommitted
tail — forces that one invocation to perform a FULL rebuild regardless of `--changed-only` (subsequent
calls respect the flag normally again). **Residual, undocumented-by-code window**: a `graph query`
called BEFORE the first post-upgrade `graph build` runs cannot detect or react to a stale sidecar
situation (it never touches sidecars) — it may return a stale pre-crash snapshot silently in that
narrow window. Always let the orchestrator's run-start full `graph build` complete before relying on
`graph query` output.

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
persisted to spec/plan/goal, does not trigger). The coverage-floor residual is *partially* mitigated
by the `design diff` subcommand: once the agent lists a sized node on the `--figma` inventory, the tool
mechanically refuses (exit 2) until that node carries a well-formed measured counterpart — so an
extracted-but-dropped element (the pill-omission class) can no longer pass silently, and a mismatch
asserted without both numbers (the 40px-guess class) cannot produce a row. It shares `computeSeverity()`
with the checkpoint gate, so the two can never disagree; it remains bounded by the honesty of the
declared inventory (it cannot force the inventory itself to be complete).

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
[graph: last built 3m ago (.cat/graph/graph.db) — HINT only, verify with Read/Grep]  ← only when a file-path/symbol signal fired
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

**Graph advisory line** (`graphAdvisoryLine`, gated on a `file-path`/`symbol` signal firing): informs
the MAIN thread only whether `.cat/graph/graph.db` exists / how fresh it is — it makes no claim
about, and has no effect on, what an Agent-tool-spawned subagent receives (see §6 Code-graph
automation for that contract). `fs.statSync` ONLY: never opens the DB (no `node:sqlite`/sql.js
import), never spawns a build, own isolated try/catch (a failure drops only this line, never the
router). No Node-version floor to duplicate anymore — `graph build`/`graph query` moved off
`node:sqlite` onto vendored sql.js (WASM SQLite), which needs only Node's built-in `WebAssembly`, so
the graph feature works on this plugin's own Node 18+ baseline unconditionally. `.cat/graph/graph.db`
absent (`ENOENT`) → `[graph: not built yet — cat-harness:ralplan/ultragoal/team auto-refresh it at
workflow start; Read/Grep until then]`; present → `[graph: last built {age} ago
(.cat/graph/graph.db) — HINT only, verify with Read/Grep]`; any other stat error
(inaccessible/corrupt path) → the line is omitted entirely, rest of the router block intact.

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
  lines as `parent_agent_type` (omitted when null), so a downstream reader of
  `state/dialogue-excerpts.jsonl` can render `{parent} → {child}` / `{child} → {parent}` when present,
  else treat it as a top-level (`Lead → {child}`) dispatch.
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
- Loop (cap by risk tier — full 5, lite 2; see Reviewer diet below): `planner` agent drafts plan + RALPLAN-DR deliberation summary → persist via
  `artifact write` (stage-`NN`-planner.md) → fresh `architect` (verdicts CLEAR/WATCH/BLOCK +
  APPROVE/COMMENT/REQUEST CHANGES) and fresh `critic` (OKAY/ITERATE/REJECT) review the SAME artifact
  (identified by path+sha256+stage_n), in parallel. Reviewer return discipline: architect/critic have
  no Bash and cannot run the writer, so each returns its full review BODY; the ORCHESTRATOR persists
  each body via `artifact write` and holds the receipts. Plan bodies are still never pasted by anyone.
  Join gate: Critic `OKAY` AND Architect `CLEAR`+`APPROVE` on the same artifact. Else consolidate feedback
  → re-spawn planner with prior artifact path + feedback (fresh-spawn model). After the tier's cap of
  failed loops (5 full, 2 lite) present best version to the user.
- Reviewer diet (SHARED CONTRACT — does not weaken the join gate above): the architect/critic reviewer
  model and iteration cap vary by risk tier, recorded in state as `reviewer_tier` (`"full"`/`"lite"`) and
  `reviewer_model` (`"opus"`/`"sonnet"`). HIGH-risk tier (deliberate mode's trigger set) = `opus`, cap 5
  (unchanged max). LOW-risk tier (everything else) = `sonnet`, cap 2. The Agent tool's per-spawn `model`
  parameter carries the tier's model and takes precedence over `agents/architect.md`/`agents/critic.md`
  frontmatter, which stays `opus` as the default/fallback. A mid-loop self-escalation (low-risk pass
  surfaces a high-risk trigger) raises the tier to `full`/cap 5 immediately and is recorded in state and
  the final ADR's Risks. The join gate formula itself — Critic `OKAY` AND Architect `CLEAR`+`APPROVE` on
  the same artifact — is identical for both tiers; only who runs it and how many passes are allowed vary.
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

### Code-graph automation (ralplan/ultragoal/team, planner/executor-only injection)

Each orchestrator skill (`ralplan`, `ultragoal`, `team`) drives `graph build`/`graph query` itself —
nothing here changes `scripts/cat-state.mjs`'s CLI contract, only who calls it and when:

- **Trigger**: ONE full `graph build` (no `--changed-only`) at the FIRST planner/executor spawn of a
  run; `graph build --changed-only` at every subsequent phase-start within the SAME run (ralplan
  step 5b revision, ultragoal's later goal-loop iterations, team's rare targeted re-spawn). Always
  best-effort and non-blocking: a non-zero exit or `{ok:false, skipped:"locked"}` (lock contention) is
  a silent fallback — the workflow proceeds exactly as it did before this automation existed. This is
  a prompt-level cadence (SKILL.md prose, not code-enforced); a redundant `graph build` call is cheap
  and harmless, never broken, so the "at most once per run" contract has no automated test oracle
  beyond CLI idempotency.
- **Injection**: when a task/goal/lane names specific file paths (cap 3, or ≤3 per lane for team),
  `graph query --file <path> --depth 2` results are spliced into the dispatch prompt as a
  `[blast-radius HINT]` block — **planner dispatch (ralplan) and executor dispatch (ultragoal, team)
  ONLY.** Pinned render format, identical across all three SKILL.md files:

  ```
  [blast-radius HINT — not source of truth{, possibly stale — incremental build; verify with Read/Grep}]
  <file>: <N nodes>
    related: <symbol> (<kind>) — <file>, distance <N>
    ... (top ~8 entries by distance, one list — callers/dependents are the same
        underlying array in the current data model, do not render as two
        duplicate-content sections)
  ```

  Fields are exactly what `graph query` returns for `callers`/`dependents`: `symbol`, `kind`,
  `file`, `distance` — never `line` (the API returns no line number for caller/dependent entries,
  only for the queried file's own `nodes[]`). Size bound: top ~8 entries by distance, ≤800 bytes per
  file queried, ≤3 files per task/goal (≤3 per lane for team). The header line is prefixed with
  `(possibly stale — incremental build; verify with Read/Grep)` whenever the queried file's `graph
  query` response has `incremental_since_full_build:true` OR `stale:true`. When the graph is absent,
  Node is below floor, or the query returns empty, nothing is injected — silent fallback to the
  agent's own Read/Grep/Glob guidance (`agents/planner.md`, `agents/executor.md`).

- **Reviewer-independence invariant** (named; non-negotiable): automated context — persistent agent
  memory OR an injected blast-radius map — feeds authoring lanes (planner, executor) only, NEVER
  reviewing lanes (architect, critic). This is the same rule already applied to `memory: local` in
  `agents/planner.md`/`agents/executor.md` (commit `1e90b55`, kept OFF `agents/architect.md`/
  `agents/critic.md` deliberately, to keep the consensus gate's fresh-eyes review). A shared or
  possibly-stale automated map handed to both reviewers would correlate their judgment and erode the
  independence the ralplan join gate (Critic `OKAY` AND Architect `CLEAR`+`APPROVE`) depends on.
  Enforced only at the prompt level: an explicit negative instruction sits immediately above every
  architect/critic (or ultragoal's "Architect review") spawn block in all three SKILL.md files —
  grep-verifiable, not code-enforced. `agents/architect.md`/`agents/critic.md` are deliberately left
  untouched by this change (no mention of ever receiving an injected block); their existing "Code
  exploration priority" paragraph already covers a SELF-run `graph query`, which remains the only
  graph access either reviewer has.
- **Subagent-reach rationale** (why the hook is not the injection point): `hooks/hooks.json`'s
  PreToolUse matcher includes `Agent|Task`, so PreToolUse DOES fire when a subagent is spawned — but
  a PreToolUse hook can only allow/deny/annotate the tool call, it cannot inject content into the
  spawned subagent's separate context window or rewrite the dispatch prompt itself. The orchestrator
  SKILL.md's own prompt composition is therefore the only mechanism able to inject the blast-radius
  block into planner/executor context; the router's `graph` advisory line (§5) informs only the MAIN
  thread and makes no promise about subagent behavior.
- **v1.2.0 reconciliation**: this automation is NOT a return to the background-process pattern
  `684b289` removed. `graph build`/`graph query` run synchronously, invoked from within an already
  in-flight orchestrator turn — no server process, no detached/backgrounded spawn, no network
  egress, no cross-project registry writes, and no unconditional per-prompt hook side effect (the
  router's advisory line is `fs.statSync`-only and never triggers a build itself). A hook-triggered
  detached background build was considered and rejected for this reason (it would re-bless the exact
  side effect v1.2.0 shipped to eliminate) and because it cannot reach a subagent's dispatch prompt
  by itself (see Subagent-reach rationale above).
- **Scope**: automatic ONLY within `ralplan`/`ultragoal`/`team`. Plain main-conversation chat never
  auto-builds or auto-injects; the router's `graph` advisory line (§5) is informational only.

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
- User-facing register — write like a UX writer (ROUTER_LADDER line injected every prompt +
  deep-interview/ralplan skill rules): EVERY user-facing message — progress updates, mid-workflow
  status narration, results, AND questions (not only questions) — is written in plain language for
  non-developers. Technical terms are KEPT but glossed in parentheses on first use
  (learning-by-exposure, e.g. 합의(consensus, 검토관들이 같은 결론에 도달) / 마이그레이션(기존 데이터를
  새 구조로 옮기는 작업)); internal agent-to-agent jargon is never dumped at the user unglossed. For
  questions, options are labeled by outcome, not mechanism. Simplify the language, never the
  decision. This governs only what the USER reads — agent/subagent PROMPT internals stay technical.
- All JSON written by hooks/CLI: 2-space indent, trailing newline. All timestamps ISO8601 UTC.
- Never `console.log` debug noise from hooks (stdout is the contract). Errors → stderr + audit.jsonl.
- **Zero-install runtime, TWO deliberate vendored dependencies — neither requires an end-user `npm
  install`**: `hooks/` is pure Node builtins throughout; `scripts/cat-state.mjs` is pure Node builtins
  EXCEPT its `graph build`/`graph query` subcommands (§4). There is no npm-dependency subsystem anywhere
  else in the repo.
  1. **Vendored parser (`scripts/cat-state.mjs` graph subcommands, Node 18+)**: `web-tree-sitter@0.24.7`
     plus JS/TS/TSX grammar `.wasm` files are vendored and git-committed under
     `scripts/vendor/tree-sitter/` (see that directory's `VENDOR.md` for pinned versions, sha256s, and
     why `0.24.7` rather than the nominal-latest `0.26.11` — a grammar-ABI incompatibility with
     `tree-sitter-wasms@0.1.13`), loaded only by relative path so no `node_modules` resolution is ever
     needed.
  2. **Vendored storage engine (`scripts/cat-state.mjs` graph subcommands, Node 18+)**: `sql.js@1.14.1`
     (WASM SQLite, MIT) is vendored and git-committed under `scripts/vendor/sql.js/` (see that
     directory's `VENDOR.md` for pinned version, sha256s, the `GRAPH_LOCK_TTL_MS` derivation, and the
     local-filesystem scoping note on the lock's atomicity guarantees), loaded only by relative path.
     Replaces the previous builtin `node:sqlite` dependency (which forced a Node 22.13.0+ floor on the
     graph subsystem alone) — sql.js needs only Node's built-in `WebAssembly`, so the graph subsystem now
     shares this plugin's ordinary Node 18+ baseline with no separate floor.

  Both are dynamically imported only inside the graph handlers (blast-radius confinement: an API drift
  in either can only break these two subcommands). Every other subcommand, and every hook, still runs on
  Node 18+ with zero dependencies of any kind. Both vendored trees are git-committed, not npm-installed,
  so neither reintroduces an `npm install` step for end users.
- `.cat/graph/graph.db` is the one documented exception to the per-session `.cat/_session-{id}/` layout
  (§3): it is REPO-scoped (a sibling of `.cat/settings.json`), because a code graph describes the
  repository, not a single session. It still falls fully under the G1 writer-policy doctrine (§3): only
  `cat-state.mjs graph build` may mutate it, same as every other runtime-owned path.
- Version 1.4.0 everywhere as of this change (bump on every released change — the plugin cache is keyed
  by version; same-version pushes may not reach installed users). The 1.3.0 → 1.4.0 change replaces the
  graph subsystem's storage engine (`node:sqlite` → vendored sql.js), which LOWERS its Node floor back
  down to this plugin's ordinary Node 18+ baseline (reversing the earlier 1.0.0 → 1.3.0 breaking bump to
  22.13.0 for `graph build`/`graph query` — see CHANGELOG.md for both entries).

## Fidelity sources (read before writing)

- Original gjc skill/agent sources (VERBATIM inspiration):
  `/private/tmp/claude-501/-Users-hyungjoo-Projects-private-cat-workflow/0e700c4d-16ed-43e7-9ab7-b4447bcda067/scratchpad/gajae-code/packages/coding-agent/src/defaults/gjc/skills/{deep-interview,ralplan,ultragoal,team}/`
  and `.../src/defaults/gjc/agents/` (planner/architect/critic/executor if present; else grep defaults for role prompts).
- Structured analysis (mechanisms incl. exact formulas, guard regexes, stop semantics):
  `/private/tmp/claude-501/-Users-hyungjoo-Projects-private-cat-workflow/0e700c4d-16ed-43e7-9ab7-b4447bcda067/tasks/wlzt4vg1r.output`
  — extract with: `jq -r '.result.map[] | select(.key=="<KEY>") | .key_mechanisms[] | "### \(.name)\n\(.how_it_works)\n"' <file>`
  keys: deep-interview, ralplan, ultragoal, team-and-agents, auto-gating, state-and-evidence, cc-plugin-surface, philosophy-docs;
  gap-check corrections: `jq -r '.result.gap'`.
