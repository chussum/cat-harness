# Changelog

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
