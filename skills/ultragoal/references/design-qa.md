# Ultragoal Design QA Evidence Lane Fragment

You are the design-verification evidence lane for the ultragoal completion gate. This is an internal
cat-harness reference fragment (`skills/ultragoal/references/design-qa.md`), loaded on demand by the
ultragoal leader and run either inline by the leader or by an `executor`/generic subagent it spawns
for this lane. It is never user-facing: not a plugin skill, not a plugin agent, not slash-command
discoverable.

You produce design-verification EVIDENCE only. You capture the implemented UI, compare it against the
design source, classify gaps, and hand the leader a findings table plus artifact list for the quality
gate's `qa{}` object. You do NOT run `goal checkpoint`, mutate `goals.json`/`ledger.jsonl`/`state/**`
(those are G1-protected — only the leader via `cat-state.mjs`), or spawn nested workflows. You MAY use
Playwright MCP for live capture and MAY write screenshots and the policy/findings markdown ONLY under
`.cat/_session-{sid}/ultragoal/artifacts/` (not a G1-protected path; markdown bodies use the normal
Write tool). Fixes are the leader's to schedule (fix within the goal, or spawn a blocker goal).

## Trigger

Run this lane during a goal's completion sweep (alongside `references/ai-slop-cleaner.md`, before the
leader assembles the quality gate) ONLY when BOTH hold:

1. The goal's surface is web UI (a route, screen, component, or drawer/modal is changed or added).
2. A design source is available: a Figma URL or a design-policy doc — taken from the deep-interview
   spec's `design_source` field, the plan, or asked from the user ONCE via AskUserQuestion.

If no design source resolves after asking once, SKIP the lane and set
`qa.evidence` to note "design verification not applicable (no design source)". Do not block on it.

## Environment checks (degrade explicitly, record every degradation in `qa.evidence`)

- **Live capture — Playwright MCP (required for screenshots + computed-style measurement).** Confirm a
  `browser_navigate` tool is available. If absent, tell the user to connect it (`/mcp`, or add to
  `~/.claude.json` `mcpServers`: `npx @playwright/mcp@latest`) and either wait for connection, or
  degrade to inspection-only (compare design spec against source code / prior screenshots) with an
  explicit `qa.evidence` note that live capture was unavailable.
- **Design-side extraction (first available wins):** Figma MCP Dev Mode preferred — no token needed
  (`get_metadata`, `get_design_context`, `get_variable_defs`, `get_screenshot`). Else Figma REST API
  with a user-supplied `figd_` token (`/v1/files/{key}/nodes`, `/v1/images`). Else user-provided design
  screenshots as a last resort (numeric spec then comes only from what the design-policy doc states).
- Each fallback taken (inspection-only, REST instead of MCP, screenshots-only) is one line in
  `qa.evidence`. Never silently proceed at a lower fidelity than the caller expects.

## Step 1 — Extract the design policy (scoped to THIS goal)

Extract only policies that govern the current goal's surfaces — do not map the whole Figma file.
Pull, per surface: layout/grid, typography (family/size/weight/line-height/letter-spacing), color
tokens (effective hex, not token names alone), spacing (4-side padding/margin/gap), component states
(hover / focus / disabled / empty / error), and responsive breakpoints the design defines.

Rule: extract NUMBERS from the design source, never eyeball a screenshot. Use `get_metadata` for
node size/position and `get_design_context` (or REST node JSON) for CSS values; `get_variable_defs`
for color/type tokens. Screenshots are for visual cross-check only, not the basis of a numeric verdict.

Persist a compact policy doc at `.cat/_session-{sid}/ultragoal/artifacts/design-policy-{goal}.md`
(written in the user's language — it is user-facing evidence). Keep it to the surfaces in scope: a
short table per surface of `element | property | expected value | figma node`. If a policy doc already
exists for this project, extend it rather than overwrite.

## Step 2 — Map Figma → implementation (before comparing anything)

For each in-scope design frame/component, establish where it lives in the running app so measurements
target the right element:

- Navigate the app (`browser_navigate` + `browser_snapshot`), identify the route/URL and the root CSS
  selector that captures the component (use `closest()` to disambiguate when a class repeats across
  contexts; measure only the visible, open instance).
- Record breakpoint(s) to test from the design's own view frames (e.g. mobile 390 / tablet 768 /
  desktop 1280 — only those the design actually specifies).
- Emit a mapping table: `figma frame/node → route → root selector → breakpoint(s)`. Flag any frame
  with no implemented counterpart, or implemented surface with no design frame, as an evidence note.

## Step 3 — Capture & compare (per mapped surface, per breakpoint)

1. `browser_navigate` to the route, then `browser_resize` to the breakpoint width (match the design
   frame width 1:1 — do not capture at another width and resize after).
2. Screenshot the surface and save under `.cat/_session-{sid}/ultragoal/artifacts/` as PNG, named
   e.g. `design-{goal}-{surface}-{bp}.png`. Capture at ≥2x (put `zoom:2` on the target element and
   take an element screenshot with the viewport unchanged) so the image is crisp AND clears the gate's
   4096-byte floor. Verify each saved file is real PNG/JPEG and ≥4096 bytes before listing it — the
   sanctioned CLI rejects the checkpoint otherwise.
3. Export the matching DESIGN frame image and save it beside the implementation screenshot as
   `design-{goal}-{surface}-{bp}-figma.png`: Figma MCP `get_screenshot` on the mapped node, or REST
   `GET /v1/images/{file_key}?ids={node}&format=png&scale=2`. Export the node in its frame context at
   the same width as the capture breakpoint (1:1 size principle — never an isolated sample node).
   Reference BOTH files in the findings-table row so a human can eyeball the AS-IS | TO-BE pair — two
   files side by side, no image compositing, no Pillow. In screenshots-only fallback mode the
   user-provided design image plays this role.
4. Measure the implemented values with `browser_evaluate` computed styles — NOT pixel-diffing alone.
   Measure exhaustively, not one representative value: container + parent wrapper (4-side padding,
   margin, border, radius, background), each text node (size/weight/line-height/letter-spacing/color),
   child gaps and left content inset, icons/checkboxes (measure the drawn element, not a 0px `<input>`),
   dividers, and container chrome for drawers/modals (header title copy + color, close button, footer
   CTA). Convert alpha-composited colors to their effective hex before comparing.
5. Use screenshot pixels only to cross-check what computed styles cannot settle: element offsets/
   alignment, icon asset shape/stroke, and near-black effective colors.
6. Diff each measured value against the Step 1 expected value and classify by the table below.

## Severity classification (ported from the source's priority vocabulary)

| Gap category | Tolerance | Severity | Blocking? |
|---|---|---|---|
| Color (bg / text / border), effective hex | exact match | **Critical** | yes |
| border-radius category (pill/lg/md/sm/none, by radius÷height) | category match | **Critical** | yes |
| width / height | ±2px | **Major** | yes |
| padding / margin / gap | ±2px | **Major** | yes |
| font-size | exact | **Major** | yes |
| font-weight category (400/500/700) | category match | **Major** | yes |
| font-family | exact | **Minor** | no |
| line-height / letter-spacing | ±1px / ±0.5px | **Trivial** | no |

Severity criteria mirror the source's user-impact scale: **Critical** = surface unusable or visibly
wrong (broken color/shape); **Major** = a primary use of the surface reads wrong (size/spacing/weight
off); **Minor** = functional but degraded; **Trivial** = most users would not notice. Also raise
**Critical** for a mapped surface that fails to render or whose root selector is not found.

## Evidence output contract

Return to the leader (do not paste artifact bodies — reference paths):

- A **findings table**: `surface | expected (per design) | actual (measured) | severity | evidence files (impl screenshot + figma export)`.
- The **artifact list** (implementation screenshots + Figma frame exports + `design-policy-{goal}.md` + findings doc) → feeds `qa.artifacts`.
  Write the findings doc in the user's language under `.cat/_session-{sid}/ultragoal/artifacts/`.
- A **one-paragraph `qa.evidence` summary**: design source used, any degradations, counts by severity.
- The Playwright actions used (navigate/resize/screenshot/evaluate) → `qa.commands`.
- **Blockers**: every unresolved Critical/Major gap → one `qa.blockers` entry. Minor/Trivial gaps are
  recorded in the findings table but are NOT blockers and do NOT enter `qa.blockers`.

Design-dimension `qa.status` is `passed` only when no unresolved Critical/Major gap remains. The leader
folds this into the goal's overall quality-gate JSON (`{architect_review, qa:{status, commands,
evidence, artifacts, blockers}}`) and runs `goal checkpoint --status complete --quality-gate-json`; the
CLI enforces the gate fail-closed (screenshots must be PNG/JPEG magic and ≥4096 bytes).

## Blocker handling

A goal with an unresolved Critical/Major design gap CANNOT checkpoint `complete`. Per the ultragoal
blocker flow, the leader either fixes it within the current goal (spawn an `executor` with the specific
gap + fix hint, then rerun this lane on the affected surfaces — full re-audit of the component, not a
narrow re-check of the one value) or spawns a new blocker goal (record-review-blockers) carrying the
findings. Never downgrade a real gap to advisory to pass the gate; a few pixels off spec is still Major.

## Out of scope (explicit)

This lane produces design-verification EVIDENCE ONLY. It does NOT do test-case generation, Excel/report
generation, Jira ticket creation, multilingual copy review, or project-profile management. For the full
QA pipeline (test design, reporting, ticketing), the standalone Zigzag_web_QA skill exists separately —
do not reimplement it here and do not invoke it from inside ultragoal.

## Language

All questions, progress, and results shown to the user mirror the user's language. The policy doc and
findings artifacts are written in the user's language (they are user-facing evidence). Only state JSON
(`goals.json`, `ledger.jsonl`, `state/**`, quality-gate field values) stays English.
