# cat-harness dashboard

A pixel-cat "software tycoon" monitoring UI over every registered cat-harness
project's `.cat` state. It is **out-of-surface infrastructure** (DESIGN.md
§1) — not a 5th skill or agent. It never gates, blocks, or mutates a
workflow; it only reads disk and renders it.

```
dashboard/
├── server/   zero-dependency Node status server + SSE (see DESIGN.md §10)
└── app/      Vite/React/FSD dashboard UI — the one build-time npm-dep surface
```

## It auto-starts — there is no manual operation

You never run `dashboard/server` by hand. Every `UserPromptSubmit` in any
project running cat-harness does a cheap, synchronous liveness check
(`hooks/cat-hook.mjs`'s router step) against `~/.cat-harness/server.json`. If
no healthy server is found, the hook spawns `dashboard/server/launcher.mjs`
detached and returns immediately; the launcher does the actual health probe
and, if needed, starts the server in-process. One server instance serves
**every** registered project, discovered from `~/.cat-harness/registry.json`.

There is no `npm start`, no port to remember to open, no process to babysit.
If a dashboard window is useful to you, open `http://127.0.0.1:9223` (or
whatever `CAT_HARNESS_PORT` you've set) in a browser at any time — the server
is either already running (auto-started by the hook) or will be by the next
prompt.

## Port

Fixed default **9223**, override with the `CAT_HARNESS_PORT` environment
variable. 9223 was chosen adjacent to, and specifically to avoid, port 9222
(Chrome DevTools / Playwright / agent-browser remote debugging) — see
`dashboard/server/constants.mjs`. There is deliberately no automatic port
fallback: a bind failure is a hard, logged failure, not a silent retry on the
next port.

## Operator remedy

If the dashboard seems stuck, unreachable, or you suspect a stale server
record (e.g. after a crash or an OS pid reuse): delete
`~/.cat-harness/server.json`. The next cat-harness hook invocation (the next
prompt in any registered project) detects the missing discovery file and
relaunches cleanly. This is always safe — the server holds no authoritative
in-memory state; it rebuilds everything by rescanning disk on boot.

## Rebuilding the UI (`dashboard/app`)

The compiled `dist/` is committed to git so the server can serve the
dashboard with zero build step for end users — `npm install`/`npm run build`
is never required just to use cat-harness. If you change anything under
`dashboard/app/src/` (or `public/`, `index.html`, `vite.config.ts`, ...),
rebuild and recommit `dist/`:

```sh
cd dashboard/app
npm run build
git add dist
```

Verify the committed `dist/` isn't stale (rebuilds into a scratch temp dir
and byte-diffs against the committed one; Node builtins only, no new
dependency needed to run the check):

```sh
cd dashboard/app
npm run check-dist-drift
```

> Rebuild and run the drift check with **Node ≥ 20.19** (or the repo's pinned
> toolchain) — Vite 8 expects it, and an older Node can produce a
> byte-different bundle and thus a drift false-positive. End users are
> unaffected: they only serve the committed static `dist/`, never rebuild.

See `dashboard/app/README.md` for the full Feature-Sliced Design layout and
`dashboard/server/` source files for the status-server contract (also
documented in the repo's `DESIGN.md` §10).
