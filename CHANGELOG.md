# Changelog

## 0.3.0 — Tycoon dashboard (unreleased, prepared but not pushed/tagged)

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

**Not pushed or tagged.** Per the release protocol, publishing (git tag +
push) is a separate, user-confirmed follow-up step.

## 0.2.0

Question register rule: plain-language, glossed-technical-term questions
across the router and skills (see prior commit history for detail).
