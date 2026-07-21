# Changelog

## 1.3.0 — Code-graph auto-refresh + planner/executor-only blast-radius injection (2026-07-21)

Non-breaking MINOR. Closes the gap between `graph build`/`graph query` existing in
`scripts/cat-state.mjs` (since the WS2 code-graph work) and anything ever calling them
automatically: nothing refreshed `.cat/graph/graph.db`, and nothing fed graph facts into subagent
context — `agents/*.md` only *guided* agents to prefer the graph if they chose to query it
themselves. `ralplan`, `ultragoal`, and `team` now drive the graph themselves, and — the crux of
this release — the injected blast-radius map is an **authoring-lane-only** aid.

- **Router advisory (`hooks/cat-hook.mjs`)**: a new, gated `[graph: …]` line in the
  `UserPromptSubmit` router block reports whether `.cat/graph/graph.db` exists / is fresh, ONLY
  when the prompt carries a file-path or symbol signal. `fs.statSync`-only (never opens the DB, no
  `node:sqlite` import, no spawn), own isolated try/catch, Node-floor-aware (< 22.13 states the
  floor plainly instead of implying a build that can never happen). Informs the MAIN thread only —
  it makes no claim about, and has no effect on, what a spawned subagent receives. `hooks/hooks.json`
  is unchanged (still 4 events).
- **Orchestrator-triggered graph refresh (`skills/{ralplan,ultragoal,team}/SKILL.md`)**: one full
  `graph build` (no `--changed-only`) at the first planner/executor spawn of a run, `graph build
  --changed-only` at every later phase-start within that run — always best-effort and non-blocking
  (a locked DB, a below-floor Node, or any build error is a silent fallback to pre-automation
  behavior). This retires the empty-DB first-build false positive (`incremental_since_full_build:
  true` even though a cold-start `--changed-only` build has 100% complete data — see DESIGN.md §4
  and the new `scripts/cat-state.test.mjs` fixture).
- **Planner/executor-only blast-radius injection**: when a task/goal/lane names real files (cap 3,
  or ≤3 per lane for team), a pinned-format `[blast-radius HINT]` block (`graph query` results,
  ≤800 bytes/file, staleness-marked when `incremental_since_full_build:true` or `stale:true`) is
  spliced into the **planner** dispatch (ralplan) or **executor** dispatch (ultragoal, team) —
  identical rendering across all three SKILL.md files. `agents/planner.md`/`agents/executor.md`
  gained one sentence: an injected block carries the same HINT-only trust level as a self-run
  `graph query`.
- **Reviewer independence (the reason this shipped as its own release, not a footnote)**: the
  blast-radius block is NEVER injected into the architect or critic dispatch prompt, in any of the
  three SKILL.md files — an explicit negative instruction sits immediately above every such spawn
  block, and `agents/architect.md`/`agents/critic.md` are deliberately left untouched. This mirrors
  the already-shipped precedent that `agents/planner.md`/`agents/executor.md` carry `memory: local`
  while `agents/architect.md`/`agents/critic.md` deliberately do not (`1e90b55`) — a shared or
  possibly-stale automated map handed to both reviewers would correlate their judgment and erode
  the independence ralplan's join gate (Critic `OKAY` AND Architect `CLEAR`+`APPROVE`) depends on.
  New DESIGN.md §6 subsection states the invariant by name.
- **Corrected rationale, not a new conclusion**: `hooks/hooks.json`'s PreToolUse matcher includes
  `Agent|Task` and DOES fire on subagent dispatch — but a PreToolUse hook can only allow/deny/
  annotate the tool call, it cannot inject content into or rewrite a spawned subagent's own dispatch
  prompt. A hook-triggered detached background build was considered and rejected: it would
  re-bless the exact background-process pattern 1.2.0 removed (no server process, no network
  egress, no cross-project registry — this release keeps that), and it still could not reach a
  subagent's dispatch prompt by itself, so the orchestrator SKILL.md's own prompt composition
  remains the only injection point, same conclusion as before, now correctly reasoned.
- **Surface unchanged**: no new hook event (still 4), no new skill, no new agent, no new
  `cat-state.mjs` subcommand — `graph build`/`graph query`'s existing fields carry everything
  needed.
- **Version bump**: `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json` corrected
  from the stale `1.0.0` (left uncorrected through 1.1.0/1.2.0) to `1.3.0`.
- **User-facing register widened to a UX-writer doctrine (`hooks/cat-hook.mjs` ROUTER_LADDER +
  `DESIGN.md`)**: the plain-language + gloss-technical-terms-on-first-use rule now governs EVERY
  user-facing message — progress updates, mid-workflow status narration, and results — not only
  AskUserQuestion questions. Internal agent-to-agent jargon (consensus, join gate, blast-radius,
  `--changed-only`, matcher, …) must be glossed or avoided when talking to the user; agent/subagent
  prompt internals stay technical. Injected every prompt via the router block (verified to fit the
  4 KiB bound: a representative block is ~2.1 KiB).

## 1.2.0 — Remove the dashboard subsystem (2026-07-21)

Removes `dashboard/` (the status server + monitoring UI, ~133MB / 95 tracked files) and every piece of
its runtime wiring. It was documented as OUT-OF-SURFACE infrastructure (DESIGN.md §1) layered on top of
the 4-skill/4-agent contract, never gating a workflow — but the hook still had two real side effects on
its behalf on every `UserPromptSubmit`: a detached-launcher auto-start (G003) and a project-root upsert
into `~/.cat-harness/registry.json`. Removing those is a user-visible behavior change (no more background
process spawned per prompt, no more cross-project registry writes), even though the core routing/gating
surface this contract defines is untouched — hence a MINOR bump (1.2.0), not a patch.

- **Deleted `dashboard/`** in full: `dashboard/server/` (Node status server, registry, singleton,
  launcher) and `dashboard/app/` (the Vite/React/FSD monitoring UI, including its committed `dist/`).
- **`hooks/cat-hook.mjs`**: removed the G003 auto-start block (`catHarnessHomeDir`, `isServerLocallyLive`,
  `spawnDetachedLauncher`, `upsertProjectRegistry`, `runAutoStart`) and its call from the router path.
  The `node:child_process` (`spawn`) and `node:os` imports were only used by that block and are removed
  with it. The UserPromptSubmit router still does its primary job — injecting the cat-harness routing
  context block — and the phase-guard / mutation-guard / G1 state-protection code (PreToolUse) and the
  Stop completion gate are untouched.
- **`hooks/cat-hook.test.mjs`**: removed the now-dead auto-start, launcher-spawn, server.json-liveness,
  and registry-upsert/parity test suites (12 tests); the phase-guard regression tests and all other
  suites are unaffected.
- **Docs**: DESIGN.md §10 ("Dashboard & Status Server Contract") is deleted in full; the `dashboard/`
  file-tree entry, §1's "Dashboard is OUT-OF-SURFACE infrastructure" bullet, and §9's build-time-npm
  exception for `dashboard/app/` are removed. §9 now states there is a single dependency exception left
  in the repo (the vendored, git-committed WS2 tree-sitter runtime — not npm-installed). `.github/
  workflows/ci.yml`'s now-moot "dashboard test suites are out of scope" comment is removed.
- Historical CHANGELOG entries that mention the dashboard (0.4.0, 0.5.1, and others) are left as-is —
  they describe what shipped at the time.

## 1.1.0 — Design-QA VISUAL gate: mechanical PNG pixel-diff enforcement (2026-07-21)

Non-breaking. Closes the last self-attested checkbox in the design-QA lane: the mandatory side-by-side
visual pass (`references/design-qa.md`) used to be an honor-system checklist item ("I opened BOTH images
and compared them"). It is now backed by a mechanical pixel diff the checkpoint gate itself enforces, the
same way the numeric measurement matrix already backs the two-numbers rule.

- **New `design visual` subcommand in `scripts/cat-state.mjs`** — a pure-Node PNG decoder
  (`node:zlib.inflateSync` only, no npm dependency; colorType 0/2/4/6, 8-bit, non-interlaced; palette/
  16-bit/interlaced fail closed with a remedy-naming error), letterbox + integer box-average downscale
  onto a common canvas (cap 480px long edge), and an AA-tolerant per-pixel diff. Decoded against an
  independently-written test encoder (not a self-consistent round-trip) exercising all 5 PNG scanline
  filter types (None/Sub/Up/Average/Paeth) and colorTypes 2/6, plus a hand-computed exact-ratio fixture —
  see `scripts/cat-state.test.mjs`'s "VISUAL decoder proof" tests.
- **`qa.design.visual[]`** — a new, mandatory, per-declared-surface array composed ADDITIVELY into the
  existing `validateDesignGate` (the numeric measurement matrix path is completely untouched; this is a
  new check appended after the existing Critical/Major block, never a replacement). Three severity bands:
  `None` / `Major` (waivable — reuses the exact same `qa.design.waived` + `user_acknowledged` mechanism as
  numeric Major) / `Blocking` (sits outside the waiver system entirely, exactly like numeric Critical —
  never waivable, exit 2, unconditionally audited as `design_visual_blocking`). Structural checks (both
  images present, PNG-only — JPEG is explicitly rejected even though the generic `qa.artifacts` screenshot
  check accepts it — decodable, non-blank, minimum 32px per side, registered in `qa.artifacts`) are
  fail-closed and non-waivable, exactly like the numeric gate's row-parse failures. Recompute-authoritative:
  the server always recomputes `raw_diff_ratio`/`diff_ratio`/`severity` from the real PNGs; a submitted
  value is informational only and a submitted severity more lenient than the recompute is rejected.
- **`Blocking` is decided from the RAW ratio ALONE, before `exclude_regions`.** `exclude_regions` (bounded
  to 15% of the frame total; an over-cap attempt is dropped entirely and the diff is recomputed on the
  full frame) can only ever move a surface between `Major` and `None` — it can NEVER pull a `Blocking`
  surface down to `Major` or `None`, at ANY configured `designQa.visualDiffBlockThreshold`. An earlier
  draft of this design computed `Blocking` from the POST-exclusion ratio and proved safety only for the
  default threshold (0.75); a low project override (e.g. 0.50, exactly the "strict project lowers the
  threshold" use case this override exists for) reopened a real bypass — a saturated 15% exclusion could
  pull a raw-Blocking surface down to `adjusted_ratio` ≈0.41, under the Major floor, and pass unwaived.
  The raw-ratio-only decision closes this for every valid override value, not just the default; see
  `scripts/cat-state.test.mjs`'s "VISUAL pass-11 regression (b=0.50)" test, which pins the exact closed
  bypass scenario.
- **`.cat/settings.json` `designQa.visualDiffBlockThreshold`** — a new, narrow single-key settings reader
  (this repo's `cat-state.mjs` previously never read `settings.json`; precedent: `deepInterview.
  ambiguityThreshold`, see README Configuration). Valid range: strictly greater than the hardcoded
  `VISUAL_DIFF_MAJOR_THRESHOLD` (0.45) and strictly less than 1; an out-of-range or malformed value falls
  back to the default and is audited once (`design_visual_block_threshold_override_invalid`); an absent
  file or an absent key is normal, silent default, no audit. `design visual`'s optional `--block-threshold`
  is a DIAGNOSTIC-only override (never used by the checkpoint gate) that lets an agent preview a candidate
  setting before writing it.
- **Thresholds are PROVISIONAL, pre-calibration.** `VISUAL_DIFF_MAJOR_THRESHOLD` (0.45, hardcoded, not
  settings-overridable) and the default `VISUAL_DIFF_BLOCK_THRESHOLD` (0.75) are set loose on purpose —
  roughly 2x an estimated normal-noise ceiling — to avoid a false-block epidemic before any real
  calibration corpus exists; every `Blocking` event is unconditionally audited specifically to start
  accumulating that corpus. `raw_diff_ratio` tracks GROSS raw mismatch only (wrong page, broken/near-blank
  render, totally different layout) — v1's magnitude discrimination is intentionally low; the real
  enforcement closure this release ships is the STRUCTURAL fail-closed checks (missing/blank/undecodable/
  one-sided/wrong-format), not fine-grained visual-quality scoring. Raise
  `designQa.visualDiffBlockThreshold` per-project if your UI is legitimately high-noise.
- **Docs.** `skills/ultragoal/references/design-qa.md`'s side-by-side pre-verdict checkbox now points at
  the mechanical `design visual` result instead of a self-attestation, plus a new "Mechanical visual
  enforcement" section and an updated `qa.design` schema block (`visual[]`, `raw_diff_ratio`/`diff_ratio`).
  `skills/ultragoal/SKILL.md`'s completion-gate bullets (mechanical gate description + Clean check) now
  require the mechanical visual result for design-sourced UI goals.

## 1.0.0 — Code-graph subcommands + reviewer diet; Node floor raised (BREAKING) (2026-07-21)

**BREAKING: the Node floor moves from 18 to 22.13.0 for the new `graph build`/`graph query`
subcommands.** Every other hook and subcommand keeps working on Node 18+ unchanged; only the two new
subcommands enforce the higher floor (a guard at the entry of each graph handler exits 1 with a clear
message on a below-floor Node — see DESIGN.md §4). WS1 (reviewer diet) was originally scoped as a
non-breaking 0.8.0, but it ships together with WS2 (code-graph) in this release, so it is folded into
1.0.0 rather than released separately.

- **New `graph build [--changed-only]` / `graph query --file <path> [--depth N]` subcommands in
  `scripts/cat-state.mjs`.** `graph build` parses tracked JS/TS/TSX with a vendored Tree-sitter runtime
  (`web-tree-sitter@0.24.7` + JS/TS/TSX grammar `.wasm` files, git-committed under
  `scripts/vendor/tree-sitter/` — see that directory's `VENDOR.md` for exact versions, sha256s, and why
  `0.24.7` rather than the nominal-latest `0.26.11`, which cannot load the only published
  `tree-sitter-wasms` grammar build) and upserts nodes/edges into a REPO-scoped
  `.cat/graph/graph.db` (SQLite, WAL). `graph query` is a read-only BFS over call/import edges from that
  DB, up to `--depth` (default 2). Both subcommands dynamically import the builtin `node:sqlite` (still
  "Experimental" upstream — a WATCH) only inside their own handlers, confining the blast radius of either
  dependency to these two subcommands. Fail-open by design: the graph is a HINT, not a source of truth —
  the vendored 0.24.7 parser is known to emit a false-positive `parse_status:"partial"` on some large
  valid files (e.g. this repo's own `cat-state.mjs`), and `graph build` keeps whatever it managed to
  extract rather than aborting. `agents/planner.md`, `architect.md`, `critic.md`, and `executor.md` now
  document a code-exploration priority (external `.codegraph/` → `graph query` → Read/Grep/Glob) with the
  same verify-with-Read/Grep caveat.
- **Reviewer diet for ralplan (WS1).** `skills/ralplan/SKILL.md`'s consensus loop now varies the
  architect/critic reviewer model and iteration cap by risk tier (`reviewer_tier`: `"full"` = `opus`,
  cap 5, unchanged; `"lite"` = `sonnet`, cap 2, for everything outside deliberate mode's trigger set),
  with mid-loop self-escalation back to `full` the moment a low-risk pass surfaces a high-risk trigger.
  The join gate itself (Critic `OKAY` AND Architect `CLEAR`+`APPROVE` on the same artifact) is unchanged
  and identical for both tiers — only who runs it and how many passes are allowed vary. Non-breaking.
  `DESIGN.md` §6 and `README.md`'s ralplan section + agent table document the tier contract.
- **Docs.** `README.md` and `DESIGN.md` updated throughout for the new Node floor, the vendored
  dependency, the fourth hook event (`SubagentStop`, previously undocumented though already wired in
  `hooks/hooks.json`), and the `.cat/graph/graph.db` repo-scoped state exception. `.github/workflows/ci.yml`
  added: a Node 22.13.x/24.x matrix running `scripts/cat-state.test.mjs` and `hooks/cat-hook.test.mjs`
  (dashboard/server test suites are intentionally out of scope for this workflow).
- **Phase-guard no longer misreads heredoc-body prose as a mutation (follow-up to the 5af4595 arrow
  fix).** The `PreToolUse` Bash mutation guard split commands on newlines, so every line of a `<<'DELIM'`
  heredoc BODY became a fake "segment" — a markdown blockquote (`> …`), a `>=`/`<=` comparison, an
  `a -> b`/`c => d` arrow, or plain `A > B` prose was read as an output redirect and DENIED, blocking
  legitimate `cat-state.mjs artifact write` heredocs during ralplan/ultragoal planning phases. Fixed by
  `stripHeredocBodies()` (heredoc bodies are literal data, removed before segment scanning; the opener
  line — and any real redirect on it, `cat <<X > file` — is kept), plus a redirect-target guard so `>=`
  is never a redirect. G1 (`.cat/` state) protection and the interpreter-heredoc-write (D3) check still
  run on the un-stripped command, so a `.cat/` mutation inside a heredoc body is still denied even when
  idle. +5 hook regression tests (hook suite 41/41).

## 0.7.0 — Two-numbers rule + `design diff` mechanical measurement diff (2026-07-19)

Closes the two design-QA misses the 0.6.0 gate could not: an element measured by
SAMPLING (small fixed-size nodes — pills, badges, labels, thumbnails — silently
dropped, so the gate never sees a row to recompute) and a mismatch asserted by
GUESSING (an impression or the wrong proxy value — e.g. a section-box `gap`
standing in for the design's real bottom-padding rhythm, the "40px" correction of
a value that was never wrong). Both are one disease — a comparison acted on
without both real numbers — so both get one cure.

- **New `design diff` subcommand in `scripts/cat-state.mjs`.** Joins the extracted
  Figma sized-node inventory (`--figma`) against the live-DOM measurements
  (`--impl`) by `(surface, element, property)` and emits gate-ready `qa.design`
  rows — with severity computed by the SAME `computeSeverity()` the checkpoint
  gate uses, so the diff and the gate can never disagree. It emits a row ONLY for
  a pair holding BOTH numbers, well-formed (the mechanical **two-numbers rule**);
  reports `unmeasured` (a design node on the inventory with no measured
  counterpart — the pill-omission and the 40px-guess made impossible), `malformed`
  (a pair whose value does not parse), and `unexpected` (an impl node with no
  design spec — informational); and exits **2** while any `unmeasured`/`malformed`
  entry remains, **0** once every extracted node carries a well-formed measured
  counterpart. A real Critical/Major gap on a well-formed pair is a finding, not a
  tool error (`ok:true`, surfaced in `summary.blocking`). Read-only — touches no
  session state. This *partially* mitigates the disclosed per-element coverage-floor
  residual: an extracted node can no longer be silently dropped, though the tool
  remains bounded by the honesty of the declared inventory. +11 tests (52→63
  cat-state suite total).
- **`skills/ultragoal/references/design-qa.md` measurement doctrine.** New governing
  "two-numbers rule & no sampling" section (read before measuring): hold BOTH
  `figma_expected` and `impl_actual` before asserting or fixing any mismatch;
  impressionistic language ("looks same/bigger/aligned") is banned; compare the
  design's OWN property on that node, never a nearby proxy (measure the resulting
  geometry when design and impl express the same spacing through different CSS
  mechanisms); enumerate EVERY explicitly-sized node (`w-[N]`/`h-[N]`/`min-width`/
  `gap`/`px`/`py`/…), prioritizing small fixed-size elements (pill/badge/label/chip/
  thumbnail/counter/avatar). Step 3 now routes the compare through `design diff`,
  and the pre-verdict self-check gains four boxes (full enumeration, both numbers,
  no proxy, diff exits 0).
- **Docs.** `DESIGN.md` §4 documents the subcommand and updates the coverage-floor
  residual note; `README.md` describes the two-numbers rule and `design diff` in the
  design-QA lane.

## 0.6.1 — Phase-guard no longer misreads `=>`/`->` as a redirect (2026-07-19)

- **Fix `hooks/cat-hook.mjs` false-positive mutation block.** The Bash
  phase-boundary guard's output-redirect detector allowed any non-`<>`
  character before `>`, so the ASCII arrow operators `=>` and `->` (JS arrow
  functions in `node -e`, `->`/`=>` inside heredoc/echo text, `a->b` prose) were
  misread as an output redirect to a phantom file and DENIED during ralplan/
  ultragoal planning phases. The redirect detector now excludes `=`/`-`
  immediately before `>` (a real redirect is never preceded by them); every real
  redirect (`x>file`, ` >file`, `2>file`) is still caught. +2 regression tests
  (arrows-not-denied; real-redirect-still-denied); hook suite 36/36. Surfaced
  during the 0.6.0 ralplan run, where arrow-bearing `cat-state artifact write`
  heredocs and `node -e` snippets kept tripping the guard.

## 0.6.0 — Mechanical design-QA gate (2026-07-19)

Closes the incident class where a UI goal was checkpointed `complete` with a
wrong font-size/spacing because the agent "checked alignment only" and
self-declared `qa.status: passed`. Three prior prose-only reinforcements
(0.4.0/0.5.0/0.5.2) could not stop it because the CLI gate only checked
structural things. This makes the check MECHANICAL.

- **New `qa.design` measurement-matrix gate in `scripts/cat-state.mjs`'s
  `validateQualityGate`.** When a design source is on record for the goal — a
  Figma/design URL in the deep-interview spec's `Design Source` line, the
  approved plan, OR the checkpointed goal's own objective (goalId-scoped, so a
  sibling goal's URL never false-triggers) — `goal checkpoint --status complete`
  is REFUSED unless a per-surface/per-property matrix (font-size, line-height,
  font-weight + spacing, color, geometry) was submitted and is clean. The CLI
  **recomputes** each property's severity from `figma_expected`/`impl_actual`
  against `design-qa.md`'s table (ordinal Critical>Major>Minor>Trivial>None) and
  rejects any self-labeled downgrade or unresolved Critical/Major — so the
  fix-then-remeasure loop is structurally forced, not self-declared.
- **Two audited escape hatches, no soft underbelly.** `not_applicable` (no UI:
  requires no screenshot artifact + substantive reason + nested architect ack);
  `waived` (a **Major only**, never a Critical; requires `user_acknowledged` and
  the leader must surface the Major to the user first — the **user**, not the
  agent/architect, is the waiver authority).
- **Broadened, non-gameable trigger + user-gated waiver** were the two
  user-reconciled decisions in the ralplan consensus that produced this
  (architect CLEAR+APPROVE, critic OKAY).
- **Doctrine**: `design-qa.md` + `ultragoal/SKILL.md` now emit/require the
  matrix, enumerate per-variant surfaces (e.g. a card's 1- vs 2-thumbnail
  layout), and require the leader to STOP-and-ask the user before waiving a
  Major.
- **Disclosed residuals** (a zero-dependency CLI cannot solve these; named so the
  gate is not oversold): fabrication (can't prove a measurement was taken),
  coverage-floor (can't force the specific wrong element), ack-softness (acks are
  leader-assembled), chat-only links (a design URL only in chat, never persisted,
  won't trigger).
- Additive: a goal with no design source on record is byte-identical to before;
  full `cat-state.test.mjs` suite green + 24 new gate tests (AC1-AC19 + sibling).

## 0.5.2 — Search-efficiency + Figma-scoping doctrine (2026-07-18)

Doctrine-only refinements from a run retrospective (no code/dashboard change).

- **executor: safe search of minified/bundled files** (`agents/executor.md`
  `<search_efficiency>`). To find what an API or design system (e.g. zds)
  exposes, prefer its type defs (`.d.ts`) / `exports` / docs over grepping the
  compiled bundle. When you must search a minified single-huge-line file, never
  point a backtracking regex at it (it can catastrophically backtrack and hang
  for minutes) — use `grep -F` / ripgrep and scope narrowly. Looking at minified
  output is fine; regex-scanning it is the trap.
- **design-QA: read Figma nodes scoped and once** (`design-qa.md` Step 1). A
  whole-frame node response can be thousands of lines — request the specific
  in-scope node (not its parent tree), pull it once, persist the numbers to the
  policy doc, and reuse them instead of re-fetching across the compare loop.

## 0.5.1 — Local-timezone timestamps in the dashboard (2026-07-18)

- **Dashboard renders ledger timestamps in the viewer's local timezone.** The
  side panel showed the server's raw ISO-8601 UTC strings (e.g.
  `2026-07-18T07:45:37.419Z`), which read 9h off wall-clock for an Asia/Seoul
  viewer. New `shared/lib/formatTs.ts` `formatLocalTs` converts to the browser's
  local time (each viewer sees their own machine's clock) as
  `YYYY-MM-DD HH:mm:ss.SSS`, 24-hour, milliseconds kept so same-second events
  stay distinguishable. The server still stores UTC (canonical) — only the
  display localizes.

## 0.5.0 — Bundle Playwright MCP for design-QA (2026-07-18)

- **Playwright MCP is now bundled with cat-harness** (`.claude-plugin/plugin.json`
  `mcpServers.playwright` → `npx @playwright/mcp@latest`). The design-QA evidence
  lane's required live-capture engine no longer needs a manual `claude mcp add` —
  it's available out of the box (tools under `mcp__plugin_cat-harness_playwright__*`;
  Chromium downloads lazily on first browser action). Always-on when the plugin is
  enabled (Claude Code plugin manifests have no per-server default-off knob); users
  can still disable it in `/mcp`. Figma MCP stays user-connected (Dev Mode is
  environment/auth-bound and can't be self-contained-bundled). `design-qa.md`
  updated: Playwright presented as bundled, the fail-closed connect-prompt now
  points users at Figma rather than Playwright.

## 0.4.0 — Tycoon dashboard, nested-dialogue attribution, design-QA hardening, ghost-floor fix (2026-07-18)

First tagged release since 0.2.0. Bundles the prepared-but-never-tagged 0.3.0
dashboard work with the nested sub-agent dialogue feature, two design-QA
doctrine reinforcements, and the ghost-floor/unregister-feedback fix.

- **Nested sub-agent dialogue attribution (Feature B).** A cat-harness subagent
  that itself dispatches a subagent (e.g. an `executor` dispatching a `critic`)
  is attributed to its PARENT, not the generic leader. Live-confirmed the inner
  `PreToolUse[Agent]` carries the dispatcher's own `agent_type`; the hook threads
  it as the optional `parent_agent_type` (omitted for top-level dispatches, so
  non-nested rows stay byte-identical) and the dashboard renders
  `executor → critic` / `critic → executor` when present.
- **Design-QA fails closed on failed/flaky live capture** (not just missing MCP):
  a connected-but-failed capture is a blocker, never a pass synthesized from the
  spec or source code; retry protocol, then `AskUserQuestion`.
- **Design-QA requires loaded-content capture + a mandatory side-by-side visual
  diff:** image/media surfaces are only valid once content actually loaded
  (`img.complete && naturalWidth>0`) — placeholders/broken mocks are a failed
  capture; prefer the real route with real data over unloaded stories; a
  numeric-only comparison is not a complete design-QA.

A pixel-cat "software tycoon" monitoring dashboard over every registered
cat-harness project's `.cat` state. Additive only — no change to the fixed
4-skill/4-agent surface; the dashboard is out-of-surface infrastructure
(DESIGN.md §1).

- **New `dashboard/server/`** — a global, stateless, singleton Node status
  server (builtins only, no runtime dependency). Auto-discovers every
  registered project's `.cat` tree and serves it over `GET /api/snapshot`
  (full JSON) and `GET /api/stream` (SSE: `snapshot` then per-project
  `delta` events). Disk is the sole source of truth: it rebuilds by
  rescanning on every boot and full-snapshot request, holding no
  authoritative in-memory state.
  - Global runtime directory `~/.cat-harness/` (override `CAT_HARNESS_HOME`):
    `registry.json` (known project roots) + `server.json` (liveness record:
    port, pid, token, boot_nonce, started_at).
  - Fixed default port **9223** (override `CAT_HARNESS_PORT`), chosen
    adjacent to, and to avoid, Chrome DevTools/Playwright's 9222. No
    automatic port fallback — a bind failure is a hard, logged failure.
  - Singleton lifecycle via compare-and-delete on `(pid, boot_nonce)` so an
    old instance's shutdown can never delete a newer instance's discovery
    file.
- **New `dashboard/app/`** — the dashboard UI itself: Vite + React +
  TypeScript in Feature-Sliced Design layers, rendering an office-scene of
  "floors" (projects) and pixel cats (active skills/agents), with a
  side-panel timeline of goals, phases, receipts, and paired agent dialogue.
  This is the **one deliberate build-time npm-dependency exception** in the
  plugin (DESIGN.md §9) — the compiled `dist/` is committed to git so end
  users never run `npm install`/`npm run build`; a drift check
  (`npm run check-dist-drift`) guards the committed `dist/` against staleness.
- **Auto-start, zero manual operation** (`hooks/cat-hook.mjs` router step +
  `dashboard/server/launcher.mjs`): every prompt does a cheap local liveness
  check and, if no healthy server is found, spawns a detached launcher that
  performs the real health probe and starts the server if needed. Operator
  remedy for a stuck/stale record: delete `~/.cat-harness/server.json`.
- **New `SubagentStop` hook event** (G004, a narrow, documented exception to
  "3 hook events" → 4) for passive, disk-only capture of both halves of the
  prose exchanged with cat-harness's own subagents (`state/dialogue-pending.json`
  FIFO + `state/dialogue-excerpts.jsonl` paired dispatch/reply rows,
  `round_trip_id`-linked) — rendered by the dashboard as paired speech
  bubbles / a dialogue timeline. Never a gating decision, never re-injected
  into any LLM prompt.
- New `dialogue append` subcommand on the sanctioned state writer
  (`scripts/cat-state.mjs`) as the CLI-accessible sibling of the hook's own
  inline writes to `state/dialogue-excerpts.jsonl`.
- **Feature B — nested sub-agent dialogue attribution** (additive). A cat-harness
  subagent that itself dispatches a subagent (e.g. an `executor` dispatching a
  `critic`) is now attributed to its PARENT rather than the generic leader. The
  inner `PreToolUse[Agent]` payload's own `agent_type` — live-confirmed to carry
  the dispatcher's identity on a nested dispatch, absent on a top-level one — is
  captured as `parentAgentType` and threaded onto both round-trip lines as the
  optional `parent_agent_type` (OMITTED for top-level dispatches, so non-nested
  rows stay byte-identical). The dashboard's `whoToWhomLabel` renders
  `executor → critic` / `critic → executor` when a parent is present, else
  `Lead → {child}` as before. Hook + snapshot passthrough + UI label + full test
  coverage (3 new hook fixtures, 3 new label cases); dist rebuilt.

- **Ghost-floor self-heal + unregister failure feedback.** A registered project
  whose directory no longer exists on disk (deleted temp dir, moved repo) used to
  linger as an empty dormant floor that "폐업 처리" couldn't remove while the
  status server was down — the unregister request failed and the UI swallowed it
  silently, so nothing appeared to happen. Now the server prunes any root whose
  dir is gone (`registry.mjs`'s `pruneMissingRoots`, on boot / fresh snapshot /
  registry change, broadcasting `removed`), and the client surfaces a failed
  unregister as a transient error banner instead of swallowing it.

**Released** on `main` and tagged `v0.4.0` (2026-07-18). Plugin manifests
(`.claude-plugin/plugin.json`, `marketplace.json`) bumped to 0.4.0.

## 0.2.0

Question register rule: plain-language, glossed-technical-term questions
across the router and skills (see prior commit history for detail).
