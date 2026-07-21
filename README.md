# cat-harness

**Interview before guessing. Plan before mutation. Execute with evidence. Parallelize when useful.**

A Claude Code plugin that ports the workflow philosophy of
[gajae-code](https://github.com/Yeachan-Heo/gajae-code) into native Claude Code
mechanics: hooks, skills, agents, and a zero-dependency state CLI. Vague
implementation requests auto-route through `deep-interview → ralplan → ultragoal
(└ optional team)` without any manual slash command. Planning artifacts stay
`pending-approval` until you explicitly approve them; completion claims are
fail-closed behind machine-checked receipts.

The surface is deliberately small and fixed, in gajae-code's spirit ("no
sprawling default skill zoo"): 4 skills, 4 agents, 4 hook events, 1 sanctioned
state writer, 4 thin escape-hatch commands. It does not expand casually.

---

## 한국어 요약

cat-harness는 [gajae-code](https://github.com/Yeachan-Heo/gajae-code)의 작업
철학 — **추측하기 전에 인터뷰하고, 변경하기 전에 계획하고, 증거와 함께 실행하고,
유용할 때만 병렬화한다** — 를 Claude Code 플러그인으로 이식한 것입니다.

- 모호한 구현 요청은 슬래시 명령 없이 자동으로 `deep-interview → ralplan →
  ultragoal (필요시 team)` 경로를 탑니다. 라우팅은 UserPromptSubmit 훅이 주입하는
  라우팅 사다리 + 스킬 내부 게이트가 담당합니다.
- deep-interview는 모호도(ambiguity)를 수식으로 채점해 임계값(기본 0.05) 이하가
  될 때까지 한 라운드에 한 질문씩 인터뷰합니다. 논쟁 중인 사실(disputed fact)
  하나만 있어도 결정론적 하한(floor)이 0.10으로 고정되어 수렴이 차단됩니다.
- 계획 산출물은 항상 `pending-approval` 상태로 남으며, "그냥 해줘" 같은 말로는
  실행이 승인되지 않습니다. 구조화된 승인 질문에 명시적으로 답해야 합니다.
- 목표(goal)의 완료 처리는 CLI가 품질 게이트(아키텍트 승인 + QA 증거)를 검증한
  뒤에만 허용되는 fail-closed 방식입니다.
- 모든 사용자 대면 출력(질문·진행 상황·결과·스펙/플랜 본문)은 사용자의 언어를
  따릅니다. 한국어로 쓰면 한국어로 질문하고 한국어로 보고합니다. (매 프롬프트
  주입되는 라우터 규칙으로 보장)
- Figma 링크(또는 디자인 정책 문서)가 있는 웹 UI 목표는 완료 시 **디자인 검증
  레인**이 추가로 돕니다: Figma 정책 추출 → 구현 매핑 → Playwright 캡처 →
  computed-style 대조 → 심각도 분류. Critical/Major 갭은 완료를 차단합니다.
  (Playwright MCP 필요, Figma MCP 권장 / Jira·엑셀 리포트·TC 생성은 범위 밖)
- 요구 사항: PATH에 Node.js 18 이상 (코드-그래프 `graph build`/`graph query`
  서브커맨드를 포함한 모든 기능이 Node.js 18 이상에서 동작합니다). 설치는 아래
  [Install](#install) 참조.

---

## How auto-triggering works

Four hook events, one entry point (`hooks/cat-hook.mjs`, plain Node, no
network, no LLM calls, fail-open on internal error):

### 1. `UserPromptSubmit` — the router

On every prompt the router injects a bounded (≤4 KiB) context block containing
the session state root, the currently active workflow (re-injected **every**
prompt while a run is live, so the workflow stays armed across turns), and this
routing ladder — the model applies it before acting, choosing the smallest
sufficient workflow:

1. Pure question / discussion / trivial reversible op → answer directly, no gating.
2. Implementation-shaped request with ambiguous intent, scope, or acceptance
   criteria → `cat-harness:deep-interview`.
3. Requirements clear but non-trivial architecture/sequencing/verification risk
   (migration, security, breaking change, data loss, multi-system) →
   `cat-harness:ralplan`.
4. Clear multi-goal / multi-step execution → `cat-harness:ultragoal`.
5. 3+ independent parallel lanes → `cat-harness:team`.

**Keywords** hard-route (first match wins; higher priority outranks):

| keywords | skill | priority |
|---|---|---|
| `consensus plan`, `$ralplan` | ralplan | 9 |
| `$deep-interview`, `deep interview`, `interview me`, `don't assume` | deep-interview | 8 |
| `$ultragoal` | ultragoal | 8 |
| `$team`, `coordinated team` | team | 8 |

There is deliberately **no generic vagueness keyword** — the hook never
hard-routes a merely vague prompt. The router also emits advisory regex hints
(vagueness cues like "not sure"/"unclear", scope-risk terms like
"migration"/"security", and auto-pass signals: file paths, `#123` issue refs,
code fences, symbols, numbered lists, error traces). Hints inform the ladder;
they never route on their own. Final over/under-trigger correction happens
inside the skills themselves: ralplan's Pre-Execution Gate catches vague
execution requests, deep-interview's Suitability Gate exits immediately when a
request is already clear and bounded ("a small verification need does not make
a request interview-worthy").

**Code-graph advisory** (main thread only): when a prompt carries a file-path or
symbol signal, the router also reports whether `.cat/graph/graph.db` exists and
how fresh it is (`fs.statSync` only — never opens the DB, never spawns a build).
This informs *your* own next move; it makes no promise about what a
subagent (planner/architect/critic/executor) receives — that is governed
entirely by the orchestrated workflows below (`ralplan`/`ultragoal`/`team`
auto-refresh the graph and, for planner/executor only, splice a
`[blast-radius HINT]` into the dispatch prompt). The graph subsystem has no
Node version floor of its own (it runs on this plugin's ordinary Node 18+
baseline), so the advisory only ever reports built / not-yet-built / fresh —
never a version gate.

**Escapes**: prefix your prompt with `!` or `force:` to bypass gating for that
turn. An explicit workflow choice by you always wins. One rule has no escape:
a spec or plan marked `pending-approval` is never implemented without your
explicit approval — "just do it" does not approve.

**Language**: the router block guarantees that every question, progress update,
result, and spec/plan body mirrors *your* language (write in Korean, get asked
in Korean). Skill/agent prompt internals and state JSON stay English.

**Questions anyone can answer**: interview and approval questions are written in
plain language for non-developers — technical terms are kept but glossed in
parentheses on first use (e.g., 마이그레이션(기존 데이터를 새 구조로 옮기는 작업)),
so designers and PMs can answer confidently and pick up the vocabulary as they go.

### 2. `PreToolUse` — the mutation guard

While a planning phase is active (deep-interview `interviewing`; ralplan
`planner|review|revision|post-interview|adr|final`; ultragoal `goal-planning`;
team `starting`), file-mutation tools are denied outside `.cat/`, Bash is
restricted to read-only commands and `cat-state.mjs` invocations (write-shaped
commands — redirects, `tee`, `sed -i`, interpreter one-liners that write files,
`git apply` — are denied), and chaining into a different cat-harness skill is
denied until the active one reaches `handoff` or a terminal phase. Runtime-owned
state files (`state/**`, `goals.json`, `ledger.jsonl`, `index.jsonl`) are denied
to mutation tools **always**, active workflow or not — they may only be written
via the sanctioned CLI.

### 3. `Stop` — the completion gate

Claude cannot end the turn while a workflow is active and not in a releasing
phase (`complete`, `failed`, `cancelled`, …). `handoff` deliberately does not
release. deep-interview and ralplan are fail-closed: if the activity marker's
per-skill record (`skills` map) shows a live run but their state file is
missing or corrupt, the gate still blocks (other skills fail open).
deep-interview additionally requires the spec file to exist on disk before it
can release. A nudge budget (10 per phase) prevents infinite loops.

Aborting a run is a single sanctioned deactivation write (`active: false`,
phase `cancelled` or `failed`) via the state CLI; successful terminal writes
also set `active: false`, so finished runs stop being advertised as active.

### 4. `SubagentStop` — dialogue reply capture

Passive, disk-only: pairs a subagent's reply with its earlier dispatch
(matched on `agent_type`, FIFO) and appends the excerpt pair to
`state/dialogue-excerpts.jsonl`. Never emits a permission decision and never
blocks the turn — fail-open on any capture error.

## The four workflows

Code-graph auto-refresh and blast-radius injection (below, "Known limitations —
`graph build --changed-only`") are automatic **WITHIN** `ralplan`/`ultragoal`/
`team` only — plain main-conversation chat never auto-builds or auto-injects;
see the router's Code-graph advisory above for what plain chat gets instead.

### deep-interview — clarity gate

Socratic interview with mathematical ambiguity gating. One question per round
(via structured ask, options + free text), targeting the weakest dimension of
the weakest component. After every answer, dimensions are scored 0.0–1.0 and:

```
greenfield:  ambiguity = 1 − (goal×0.40 + constraints×0.30 + criteria×0.30)
brownfield:  ambiguity = 1 − (goal×0.35 + constraints×0.25 + criteria×0.25 + context×0.15)
```

The interview repeats until `ambiguity ≤ threshold` or you exit early. The
threshold defaults to **0.05** (strict), with mode defaults `quick` 0.6 /
`standard` 0.5 / `deep` 0.35 — see [Configuration](#configuration). The first
output line always announces the resolved threshold and its source.

The model's self-reported score is clamped by a **deterministic floor** computed
by the state CLI, not the model:

```
floor = clamp( 0.10 × disputed_facts
             + 0.05 × unscored_active_components
             + 0.05 × min(1, auto_answered_rounds / max(scored_rounds, 1)), 0, 1 )
current_ambiguity = max(reported_ambiguity, floor)
```

A single disputed established fact holds the floor at 0.10 — above the 0.05
default threshold — so convergence is structurally blocked until the fact is
re-confirmed or superseded. Contradictions, inconsistencies, evasive answers,
and scope expansion are triggers that must raise ambiguity (scores are
non-monotonic by design). Output: a spec at
`specs/deep-interview-{slug}.md` with header `status: pending-approval`, then a
handoff question (ralplan recommended / ultragoal / team / stop here). Never
auto-executes.

### ralplan — feasibility gate

Consensus planning loop (iteration cap set by risk tier — high-risk `full` ≤5,
unchanged; low-risk `lite` ≤2, escalating to 5 the moment a low-risk pass
surfaces a high-risk trigger): a `planner` agent drafts the plan + deliberation
summary; a fresh `architect` (CLEAR/WATCH/BLOCK +
APPROVE/COMMENT/REQUEST CHANGES) and a fresh `critic` (OKAY/ITERATE/REJECT),
spawned with the tier's reviewer model (`opus` for high-risk, `sonnet` for
low-risk), review the same persisted artifact in parallel. The join gate
requires Critic `OKAY` **and** Architect `CLEAR`+`APPROVE` on the same artifact
(path + sha256) — identical for both tiers; only the model and cap vary. Then
every loop-made assumption is confirmed with you one at a
time, an ADR-style final plan lands as `pending-approval.md`, and execution
requires answering a structured approval question — "sounds good" is not
approval.

### ultragoal — evidence-gated execution

Decomposes an approved brief into durable goals (`G001..GNNN` in `goals.json`)
with an append-only `ledger.jsonl`. Implementation is delegated to `executor`
subagents for non-trivial scope; only the leader mutates goal state, and only
via the CLI. Marking a goal `complete` is **fail-closed**: the CLI itself
verifies the quality gate (architect verdicts all CLEAR + APPROVE, QA passed,
evidence artifacts exist and are real files) and mints a receipt, or refuses
with a reason. Blockers become new goals instead of silent give-ups. The final
report is a receipts summary — never a bare "done".

For web-UI goals with a design source (a Figma URL or design-policy doc), the
completion gate additionally runs the **design-QA evidence lane**
(`references/design-qa.md`): goal-scoped design policy extraction from Figma
(MCP Dev Mode preferred, REST token or screenshots as fallback),
Figma↔implementation mapping, Playwright capture at the design's breakpoints,
computed-style comparison, and severity-classified gaps. The comparison runs on
a **two-numbers rule** — no mismatch is asserted without BOTH the design's number
and the live-DOM number, and no sampling: every explicitly-sized node (down to
pills, badges, labels, and thumbnails) is enumerated and measured. The
`cat-state.mjs design diff` subcommand mechanizes this — it joins the extracted
Figma inventory against the live measurements and stays red until every extracted
node has a well-formed measured counterpart, so extracted-but-dropped elements and
impression-based guesses cannot pass. Unresolved Critical/Major design gaps block
completion. Requires Playwright MCP for live capture (degrades to inspection-only
with an explicit evidence note).
Test-case generation, Excel reports, and Jira tickets are deliberately out of
scope — use a dedicated QA skill for the full pipeline.

### team — parallel lanes

Native subagent fan-out (no tmux) for 3+ genuinely independent lanes. A task
board tracks `{id, lane, status, owner, completion_evidence}`; every lane must
produce at least one passed command or verified artifact as evidence. Shutdown
is a formula, not a vibe: all evidence-complete → `complete`; integration
pending → `awaiting_integration`; anything failed/blocked or missing evidence →
`failed`; work remaining → `cancelled`.

## The four agents

| agent | tools | model | role |
|---|---|---|---|
| `planner` | Read, Grep, Glob, WebSearch, WebFetch, Bash (read-only discipline) | sonnet | drafts plans + deliberation records; receipt-only returns |
| `architect` | Read, Grep, Glob | opus¹ | architecture + code review; CLEAR/WATCH/BLOCK + APPROVE/COMMENT/REQUEST CHANGES; evidence-cited findings |
| `critic` | Read, Grep, Glob | opus¹ | plan-only actionability gatekeeper; OKAY/ITERATE/REJECT; checks testability, sequencing, rollback |
| `executor` | all | sonnet | the only write-capable role; follows plan stages; returns receipts + evidence |

¹ frontmatter default/fallback. In ralplan's low-risk consensus passes (`reviewer_tier: "lite"`), the
Agent tool spawns architect/critic with an explicit `model: sonnet` override instead — see "ralplan —
feasibility gate" below.

Read-only agents end with a machine-parseable `VERDICT: <verdict>` line and
persist bodies as artifact files, never inline dumps. Authoring and reviewing
are structurally separate lanes. The deep-interview lateral panel personas
(researcher / contrarian / simplifier) are prompt fragments run as generic
subagents, not additional plugin agents.

## State layout

Everything lives under `<project>/.cat/`, per session:

```
.cat/
├── settings.json                                # user config (see Configuration)
├── graph/graph.db                               # REPO-scoped code graph (sql.js/WASM SQLite; plus a
│                                                 #   short-lived .lock file during builds) — the one
│                                                 #   artifact here that is NOT per-session
└── _session-{session_id}/
    ├── .session-activity.json                   # touched on every mutation
    ├── state/{skill}-state.json                 # per-skill phase/ambiguity envelope
    ├── state/audit.jsonl                        # append-only audit trail
    ├── specs/deep-interview-{slug}.md           # interview specs (pending-approval)
    ├── plans/ralplan/{run-id}/stage-{NN}-{stage}.md
    ├── plans/ralplan/{run-id}/index.jsonl       # sha256-deduped artifact index
    ├── plans/ralplan/{run-id}/pending-approval.md
    └── ultragoal/{brief.md, goals.json, ledger.jsonl}
```

State files, `goals.json`, `ledger.jsonl`, and `index.jsonl` are runtime-owned:
only `scripts/cat-state.mjs` may mutate them (atomic writes, sha256 receipts,
revision bumps, phase-transition validation, ambiguity floor clamping). Spec and
plan markdown bodies are written with normal tools. `.cat/graph/graph.db` is
likewise runtime-owned and repo-scoped rather than per-session — only
`cat-state.mjs graph build` may mutate it. `.cat/` is safe to delete between
projects; it is the audit trail while work is in flight (deleting
`graph/graph.db` just means the next `graph build` rebuilds it from scratch).

### Known limitations — `graph build --changed-only`

`--changed-only` is a fast incremental mode: it skips reparsing any file
whose sha256 is unchanged, so it never recomputes inbound cross-file edges
for dependents that were not reparsed. After a cross-file symbol rename or
removal, a dependent file's stale caller edges can persist even though the
renamed/removed file's own `stale` field reports `false`. Run a full
`graph build` (no `--changed-only`) after such a rename for correct
caller/dependent results. `graph query` sets `incremental_since_full_build:
true` whenever the most recent build was `--changed-only`, to flag that
cross-file caller/dependent data may be stale even when `stale` is `false`.

**Empty-DB false positive**: this signal is also `true` the very FIRST time
`--changed-only` is ever run against a brand-new (empty) graph.db, even though
100% of files were freshly parsed and no dangling cross-file edge is possible
yet — `last_build_mode` is derived from the flag alone, not from whether the
DB was actually empty. `ralplan`/`ultragoal`/`team` avoid this in practice by
running one full `graph build` at run-start (see below) and `--changed-only`
only at later phase-starts within the same run.

**Legacy `-wal`/`-shm` sidecars**: a `graph.db` built by the previous
`node:sqlite`-based engine (pre-1.4.0) may have left `-wal`/`-shm` sidecar
files behind if a build crashed mid-write. `graph build` deletes both on
sight and forces one full rebuild for that invocation regardless of
`--changed-only` (subsequent calls respect the flag again). A `graph query`
called BEFORE that first post-upgrade `graph build` runs cannot detect this
and may silently return a stale pre-crash snapshot in that narrow window —
let the orchestrator's run-start full build complete first.

**Automatic refresh inside the four workflows**: `ralplan`, `ultragoal`, and
`team` run `graph build` for you — one full build at the first
planner/executor spawn of a run, `--changed-only` at every later phase-start
within that run — and, when a task/goal/lane names real files, splice a
bounded `[blast-radius HINT]` (`graph query` results) into the **planner**
(ralplan) or **executor** (ultragoal, team) dispatch prompt only. This never
reaches the architect or critic dispatch — they always form their own map via
Read/Grep/Glob, preserving the consensus gate's fresh-eyes review. Always
best-effort: a locked DB, or any build error, is a silent, non-blocking
fallback to the pre-automation behavior described above.

## Requirements

- **Node.js 18 or newer on PATH — no separate floor for any feature.**
  Hooks and the state CLI run as `node "${CLAUDE_PLUGIN_ROOT}/..."`. The
  code-graph subcommands (`graph build`, `graph query`) run on this same
  Node 18+ baseline as everything else — they use two vendored WASM
  runtimes (below), never Node's builtin `node:sqlite`, so there is no
  version gate specific to the graph feature.
- **Two vendored dependencies, not an npm install.** `graph build`/`graph
  query` parse JS/TS/TSX with `web-tree-sitter@0.24.7` plus its grammar
  `.wasm` files, vendored and git-committed under
  `scripts/vendor/tree-sitter/` (~5.5 MiB, loaded only by relative path —
  see `scripts/vendor/tree-sitter/VENDOR.md`), and store the resulting graph
  with `sql.js@1.14.1` (WASM SQLite, ~692 KiB), vendored and git-committed
  under `scripts/vendor/sql.js/` (loaded only by relative path — see
  `scripts/vendor/sql.js/VENDOR.md`). There is still nothing for end users
  to `npm install`: clone or install the plugin and go.
- Claude Code with plugin support.

## Install

```
/plugin marketplace add chussum/cat-harness
/plugin install cat-harness@cat-harness
```

Installing from a local clone works the same way — pass the directory path
instead of the GitHub slug: `/plugin marketplace add /path/to/cat-harness`.

Then restart Claude Code so the hooks register.

## Manual commands

Auto-routing means you rarely need these; they exist as thin escape hatches:

| command | invokes |
|---|---|
| `/cat-harness:interview` | `cat-harness:deep-interview` |
| `/cat-harness:plan` | `cat-harness:ralplan` |
| `/cat-harness:execute` | `cat-harness:ultragoal` |
| `/cat-harness:team` | `cat-harness:team` |

## Configuration

`.cat/settings.json` in your project root:

```json
{
  "deepInterview": {
    "ambiguityThreshold": 0.05
  },
  "designQa": {
    "visualDiffBlockThreshold": 0.75
  }
}
```

Threshold precedence: `.cat/settings.json deepInterview.ambiguityThreshold` →
mode default (`quick` 0.6 / `standard` 0.5 / `deep` 0.35, when you ask for a
quick/standard/deep interview) → base default `0.05`. The base default is
strict on purpose: 0.05 means "interview until nearly nothing is ambiguous".
Raise it (e.g. 0.35–0.5) if you want shorter interviews, or ask for a
`quick interview`.

`designQa.visualDiffBlockThreshold` (optional; default `0.75`, PROVISIONAL pre-calibration) overrides the
design-QA visual gate's `Blocking` cutoff — the mechanical PNG pixel-diff ratio at or above which
`cat-state.mjs design visual`/the completion gate refuses a surface unconditionally (never waivable, like
a numeric Critical). Valid range: strictly greater than `0.45`, strictly less than `1`; an out-of-range or
malformed value falls back to the default and is audited. Lower it if your project's UI is legitimately
low-noise and you want a stricter gate; raise it if a normal, correct surface is a false-block risk at the
default. `exclude_regions` (bounded to 15% of the frame) can only ever affect this threshold's `Major`/`None`
boundary, never `Blocking` — a low threshold cannot be bypassed by excluding regions.

## What this plugin deliberately does NOT do

- **No tmux, no external processes.**¹ gajae-code's team workflow drives tmux
  workers; this port uses Claude Code's native subagents only. If you need
  persistent OS-level workers, this plugin is not that.
- **No auto-execution of pending-approval plans.** Specs and plans stay
  `pending-approval` until you answer a structured approval question. Phrases
  like "just do it" or "skip planning" do not approve, by design.
- **No optimistic completion.** Goal completion is fail-closed: the CLI refuses
  `complete` without a verified quality gate, and completion claims are backed
  by receipts (`receipt verify` checks freshness and hash integrity). deep-interview
  and ralplan block turn-ending even on corrupt state rather than silently
  releasing.
- **No LLM or network calls from hooks.** Hooks are deterministic Node scripts:
  they inject context, guard tools, and gate stops. Judgment calls (is this
  vague? is this risky?) stay with the model following injected rules and
  in-skill gates.
- **No surface growth.** 4 skills, 4 agents, 4 hook events, 1 state writer,
  4 commands — fixed. `graph build`/`graph query` are subcommands of that one
  existing state writer, not new surface — subcommand count is not part of
  the fixed count. The plugin improves by making this small method better,
  not by adding a fifth workflow.

¹ This bans self-managed persistent OS-level processes (e.g. tmux panes kept
alive across turns) — it does not cover reading an already-present external
`.codegraph/` index, or `graph build`/`graph query` calling the vendored
web-tree-sitter WASM runtime in-process. Neither spawns or supervises an
external process; both run inside the same Node invocation as the CLI call.

## License

MIT
