# cat-harness tycoon dashboard (`dashboard/app`)

A pixel-cat "software tycoon" office-scene UI for the cat-harness status server
(`dashboard/server`). Built with Vite + React + TypeScript, Feature-Sliced
Design (FSD) layers, Tailwind CSS, and shadcn/ui-style copy-in components.

This is the **one sanctioned npm-dependency surface** in the repo (build-time
only, drift-checked against the committed `dist/`) — the runtime status server
stays zero-dep.

## Layout (Feature-Sliced Design)

```
src/
  shared/api/    SSE client (sseClient.ts, useSse.ts) + TS types mirroring the
                 server's snapshot shape (types.ts)
  shared/lib/    cn() class-merge helper
  shared/ui/     shadcn/ui-style primitives (Button, Badge, Card)
  entities/      building blocks: project, floor, cat — pure snapshot -> model
                 mappings (model.ts) + presentational rendering (ui.tsx)
  features/      floor-inspect (select a floor), cat-inspect (select a cat),
                 scene-controls (connection badge, legend)
  widgets/       office-scene (the building + cats + speech bubbles),
                 side-panel (goals/phases/receipts/dialogue timeline),
                 floor-list (quick-jump nav)
  pages/         dashboard (composition root)
```

## Develop

```sh
npm install
npm run dev          # Vite dev server
npm run build         # tsc -b && vite build -> dist/
npm test              # vitest run (unit + component tests)
```

## Committed prebuilt `dist/` + drift check

`dist/` is **committed to git** (not gitignored) so the status server can serve
the dashboard UI with zero build step for end users
(`dashboard/server/server.mjs`'s static file serving falls back to `dist/`).

Whenever you change anything under `src/` (or `public/`, `index.html`,
`vite.config.ts`, …), you must rebuild and recommit `dist/`:

```sh
npm run build
git add dist
```

To verify the committed `dist/` isn't stale (CI/pre-merge check), run:

```sh
node scripts/check-dist-drift.mjs
# or: npm run check-dist-drift
```

It rebuilds the app into a scratch temp directory with the same
`tsc -b && vite build` command, then byte-for-byte diffs it against the
committed `dist/`. Any difference (missing file, extra file, changed content —
including a changed content-hashed filename) is drift and the script exits
non-zero with the specific files that differ. Node builtins only — no new
dependency was added to run the check itself.

## Assets

See [`ASSETS.md`](./ASSETS.md) — every visual (pixel cats, office windows,
speech bubbles, favicon) is self-authored inline SVG/CSS, no external image or
font files, so there is nothing to license-track beyond the npm packages
themselves.

## Server contract

The app talks to `dashboard/server` over:
- `GET /api/snapshot` — full JSON snapshot (used as a cold-start fallback if ever needed).
- `GET /api/stream` — SSE: `event: snapshot` (full) then `event: delta` (one
  changed project) — consumed by `src/shared/api/sseClient.ts`.

See `dashboard/server/snapshot.mjs` for the authoritative on-the-wire shape;
`src/shared/api/types.ts` mirrors it and must be kept in lockstep.
