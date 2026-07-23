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

Distinguish two cases before deciding to skip:
- **No design source was ever provided** (nothing in the spec's `design_source`, nothing in the plan,
  and the one AskUserQuestion returns none) → SKIP the lane, set `qa.evidence` to
  "design verification not applicable (no design source)". This is the ONLY legitimate skip.
- **A design source WAS provided** (a Figma/design URL or policy doc exists in the spec, the plan, or
  the request) → the lane is IN SCOPE and MUST run to a verdict. If you cannot reach or read that
  source, that is a missing-capability BLOCKER (next section), NOT a skip. Never silently treat a
  provided-but-unreachable design source as "no source".

## Environment checks — FAIL CLOSED when a design source is present (do NOT auto-degrade)

A provided design source means design verification is REQUIRED. If the capability needed to verify it
is not connected, you may NOT quietly drop to a lower fidelity and pass — that is exactly the silent
pass this gate exists to prevent. Instead, drive the user to connect it, or get an explicit waiver.

- **Live capture — Playwright MCP (required for screenshots + computed-style measurement).** This is
  BUNDLED with cat-harness (`.claude-plugin/plugin.json`'s `mcpServers.playwright`), so it is normally
  already present — no manual `claude mcp add` needed. Its tools surface under the plugin-scoped prefix
  `mcp__plugin_cat-harness_playwright__*` (e.g. `browser_navigate`, `browser_resize`, `browser_evaluate`,
  `browser_snapshot`). Confirm a `browser_navigate` tool is available; the first use downloads Chromium
  (deferred, one-time). If it is somehow absent (the user disabled cat-harness's bundled MCP), that is a
  missing-capability BLOCKER below, not a reason to degrade.
- **Design-side extraction (first available wins):** Figma MCP Dev Mode preferred — no token needed
  (`get_metadata`, `get_design_context`, `get_variable_defs`, `get_screenshot`). Else Figma REST API
  with a user-supplied `figd_` token (`/v1/files/{key}/nodes`, `/v1/images`). Else the logged-in Chrome
  session via the **claude-in-chrome** skill (navigate the Figma frame + the running app and capture
  both) as an alternative live path. Else user-provided design screenshots as a last resort.

**If the required capability for a PRESENT design source is missing, STOP and ask the user via
AskUserQuestion — do not proceed to a verdict on your own.** Offer, in the user's language, exactly
these outcomes and nudge toward installing the tool:
1. **Connect the MCP (recommended)** — give the concrete step. Playwright is BUNDLED with cat-harness,
   so normally it is already there; only if the user disabled it, re-enable cat-harness's bundled MCP in
   `/mcp` (or add `npx @playwright/mcp@latest` to `~/.claude.json` `mcpServers`). Figma MCP is the piece
   the user usually needs to connect: Dev Mode (enable in the Figma desktop app) or add to
   `~/.claude.json` `mcpServers`. Then wait for connection and run the full lane.
2. **Use the logged-in Chrome (claude-in-chrome)** — capture the Figma frame and the rendered app in
   the already-authenticated browser, no MCP install needed.
3. **Waive design verification for this goal (explicit)** — only if the user deliberately chooses it.
   Record a loud waiver line in `qa.evidence` ("design source X provided but verification WAIVED by
   user — visual design NOT verified"), and set the design dimension `qa.status` to not-verified.

Until the user picks 1 or 2 (capability becomes available) or explicitly waives via 3, the design
dimension is a **blocker** — emit a `qa.blockers` entry ("design source provided but the verification
capability (Figma/Playwright MCP) is not connected; awaiting user setup or explicit waiver") and the
goal CANNOT checkpoint `complete` on design grounds. There is no automatic inspection-only pass.
Every real fidelity fallback actually used (REST instead of MCP, chrome instead of Playwright,
screenshots-only) is still recorded as one line in `qa.evidence`.

## Capture-integrity gate — NO verdict without a verified live render (fail closed on capture failure)

The environment check above catches a MISSING capability. This gate catches the sibling hole: the
capability is connected, but the actual capture **failed, was flaky, or was skipped at runtime** (the
browser/extension crashed or timed out, navigation never settled, the screenshot came back blank or on
an error page, the MCP dropped mid-run). A shaky capture is NOT a reason to fall back to the design
spec and pass — it is a blocker, exactly like a missing capability. This is the exact failure this
gate exists to stop: *"I had the Figma spec and read the implementation source, the render was hard to
capture, so I concluded from those."* That is a silent pass, and it is forbidden.

**Two hard rules:**
1. **A design verdict REQUIRES a real, live implementation render.** Reading the implementation SOURCE
   CODE, or reasoning from the design spec/numbers alone, is NEVER a substitute for capturing the
   rendered pixels. Code tells you what was written; only the live capture tells you what the user
   sees. A `passed` design dimension is impossible without an on-disk, validated, visually-inspected
   AS-IS render of the actual running component.
2. **Capture failure ⇒ blocker, never a pass.** If, after the retry protocol below, you still cannot
   obtain a trustworthy live render, STOP and ask the user via AskUserQuestion (same three outcomes as
   the environment check: fix/retry the capture path, use claude-in-chrome as an alternate live path,
   or explicitly waive). Emit a `qa.blockers` entry ("design source provided and capability connected,
   but the live capture failed/was unreliable (<reason>); render NOT verified — awaiting a working
   capture or explicit waiver"). Do NOT synthesize a verdict from the design source in the meantime.

**Retry / robustness protocol (before declaring capture failure):**
- Retry a failed navigate/resize/screenshot up to **3×** — re-navigate, re-open the component
  (drawer/modal/tab), and wait for load/network-idle before capturing. Browser flakiness is expected;
  one failed call is not capture failure, three are.
- Treat as a FAILED capture (not a success), and retry or block accordingly: a navigation timeout, a
  blank/near-blank screenshot, a screenshot of an error boundary / 404 / loading spinner, an
  MCP/extension disconnect, or an element screenshot whose target selector was not found.
- **A ≥4096-byte PNG is necessary but NOT sufficient** — a blank white or error-page PNG easily clears
  the byte floor. Before listing an implementation screenshot as evidence, confirm it actually shows
  the intended component (the mapped root selector rendered with content), not a blank/error/loading
  frame. If unsure it is the real component, it is a failed capture.
- **Loaded content, not placeholders (the exact recurring miss).** If the surface has images/thumbnails/
  media/async data, the capture is only valid once that content has ACTUALLY LOADED. A gray placeholder,
  a broken-image icon, a skeleton, or an unresolved mock image is a FAILED capture, not something to
  "compare as-is" — you cannot verify a thumbnail's aspect-ratio/object-fit/radius/gap against the
  design when the image never rendered. Before accepting the screenshot, assert with `browser_evaluate`
  that every in-scope `<img>` is loaded (`img.complete === true && img.naturalWidth > 0`) and any
  background-image/canvas actually painted; poll/wait and retry until they are, or block. Never verify
  an image-dependent component against placeholder boxes.

**Capture surface — verify what SHIPS, with real content:**
- For a component that depends on real data or images (thumbnails, media cards, lists, avatars), prefer
  capturing it in the **running app on its real route with real or seeded data** over a Storybook/mock
  story whose fixtures don't load. A story that renders gray placeholder images is NOT a valid design-QA
  surface for those elements — it verifies a broken render. If you must use a story, use one whose images
  actually resolve (real fixture URLs), and apply the loaded-content assertion above.
- Note in `qa.evidence` which surface was captured (real route vs story) and that its content was loaded.

**claude-in-chrome / Playwright stabilization (flaky browser is expected — stabilize, don't skip):**
- Before every screenshot: navigate, then wait for `load`/network-idle AND poll until the target
  selector exists and its images report loaded (above). Only then capture. Do not screenshot mid-load.
- If the browser/extension is unstable (disconnects, hangs, returns blank), retry per the protocol, then
  switch capture paths (claude-in-chrome ⇄ Playwright MCP). Persistent instability with no clean capture
  is a blocker (ask the user) — it is NEVER a reason to conclude from the spec + source code.

**Mandatory side-by-side visual diff (catches what numbers can't).** Computed-style numbers alone missed
real gaps (header alignment, badge shape, thumbnail imagery) in past runs. After capturing, you MUST open
the AS-IS render and the TO-BE design export together and do an explicit visual comparison, producing a
**visual-gap list** (alignment, proportion, shape, imagery, overall composition) SEPARATE from the numeric
diff. A numeric-only pass is not a pass. Treat any visual gap you can see but can't yet put a number to as
a finding to measure, not something to wave through.

**Pre-verdict self-check (all must be TRUE, or the design dimension is a blocker, not a pass):**
- [ ] I navigated to the live route and the target component actually rendered (not blank / error / loading).
- [ ] All in-scope images/media/async content actually LOADED in the capture (verified `img.complete && naturalWidth>0`), not gray placeholders.
- [ ] I captured the AS-IS implementation render on disk and confirmed the PNG shows the real component with real content.
- [ ] I exported the mapped TO-BE Figma frame/node on disk (or used the provided design image in fallback mode).
- [ ] I opened BOTH images and did an explicit side-by-side comparison, AND `cat-state.mjs design visual` was run over the saved TO-BE export and AS-IS screenshot and its result (`qa.design.visual[]`) is present and passes — the mechanical pixel-diff result, not a self-attested checkbox, is what the checkpoint gate actually enforces (see "Mechanical visual enforcement" below).
- [ ] Every numeric claim in the findings came from `browser_evaluate` on the LIVE DOM — none from reading source code or from the design guide alone.
- [ ] I enumerated EVERY explicitly-sized design node (no sampling) — including small fixed-size elements (pill/badge/label/chip/thumbnail/counter/avatar) — and each has a row; none was dropped.
- [ ] Every finding holds BOTH numbers (two-numbers rule): `figma_expected` from the design source AND `impl_actual` from the live DOM, on the same element and the same property — no impressionistic ("looks/seems") claim, no proxy value stood in for the design's own property.
- [ ] `cat-state.mjs design diff` was run over the `--figma` inventory and `--impl` measurements and exits 0 (no `unmeasured`/`malformed`); its `rows` back the matrix below.
- [ ] `cat-state.mjs design visual --figma <TO-BE export> --impl <AS-IS screenshot>` was run for EVERY declared surface and its output (`raw_diff_ratio`, `diff_ratio`, `severity`) was folded into `qa.design.visual[]` — see "Mechanical visual enforcement" below.

If any box is unchecked, the design dimension is `not-verified` and a `qa.blockers` entry is emitted —
never a `passed`.

## Measurement doctrine — the two-numbers rule & no sampling (read BEFORE measuring anything)

Two recurring misses share ONE root cause and ONE cure. Both are failures of measurement discipline, not
of eyesight:

- **The omission miss (pill-type).** You measured the big, obvious elements — section titles, card widths,
  colors — and skipped the small fixed-size elements packed inside (pills, badges, labels, chips,
  thumbnails, counters, avatars). The gate did not catch it because the gate recomputes the severity of the
  rows you *submit* — it does not know what elements the surface actually renders, so a row you never write
  is a gap it can never see (this is the disclosed per-element coverage residual). Completeness is on YOU.
- **The guess miss (40px-type).** You declared a mismatch — or "fixed" one — from an impression ("looks too
  big", "seems off") or from the WRONG proxy value. Classic case: the design gives the vertical rhythm via a
  frame's bottom padding, the implementation gives it via `flex` `gap`, and you compared the section-box
  `gap` (a proxy) instead of the actual element-bottom→next-title distance the design specifies — then
  "corrected" a value that was never wrong.

**The two-numbers rule (mandatory).** Before you assert a mismatch, write a finding, or change a single
value, you MUST hold BOTH numbers in hand:
- `figma_expected` — the exact number pulled from the design source (`get_design_context` /
  `get_variable_defs` / REST node JSON), for THAT element, for THAT property.
- `impl_actual` — the computed value measured with `browser_evaluate` on the LIVE DOM, on THAT same
  element, for THAT same property.

If either number is missing, you do NOT have a finding — you have an unmeasured node. Go measure it. Never
emit or act on a comparison with only one number.

- **No impressionistic language, ever.** "같아 보인다 / 커 보인다 / looks aligned / seems off / roughly" are
  banned in findings. A finding is two numbers and their diff. If you cannot put a number to a visual gap
  you can see, it is a node *to measure*, not a verdict to state (measure it, then classify).
- **Compare the design's OWN property, never a proxy.** Measure the exact property the design defines on
  that exact node. If the design spaces two blocks with a 40px bottom padding, measure the implementation's
  effective bottom-of-element→top-of-next-title distance — not a container's `gap`, not a parent's margin,
  not a "section box" that merely looks related. A proxy that happens to be nearby is not the value; if the
  design and the implementation express the same visual spacing through different CSS mechanisms
  (padding vs gap vs margin), measure the RESULTING geometry, not one side's mechanism.

**No sampling — enumerate every explicitly-sized node.** From `get_design_context`, extract EVERY node that
carries an explicit size or spacing directive — `w-[N]`, `h-[N]`, `min-width`/`max-width`, `gap-N`, `px-N`,
`py-N`, `p-N`, `m-N`, fixed `font-size`/`line-height`, `rounded-[N]` — not just the large or obvious ones.
Each such node comes back with a `data-node-id` and its exact CSS; map each one to its rendered counterpart
by text/structure and measure it 1:1. **Prioritize the small fixed-width elements first** (pill / badge /
label / chip / thumbnail / counter / avatar) — those are exactly the ones sampling drops. Every
explicitly-sized node becomes a `qa.design` row; a node you extracted from the design but did not measure is
an omission, not an optional skip.

### Mechanical enforcement — `cat-state.mjs design diff` (use it; don't hand-diff)

To take judgment out of the loop, the two manifests above are diffed by a sanctioned CLI command instead of
by eye. It shares the EXACT severity math of the checkpoint gate, so the diff and the gate can never
disagree:

```
node "{helper}" design diff --session {sid} --figma <path|-> --impl <path|->
```

- `--figma` — a JSON array of the extracted design inventory: one entry per explicitly-sized node,
  `{ "surface", "element", "property", "figma_expected" }` (extra keys like a Figma node id are ignored).
  This IS your no-sampling enumeration, written down.
- `--impl` — a JSON array of the live-DOM measurements: `{ "surface", "element", "property", "impl_actual" }`,
  each value straight from `browser_evaluate` computed styles. Use the SAME `surface`/`element`/`property`
  labels as the `--figma` side so they join.

The command joins by `(surface, element, property)` and:
- emits gate-ready `qa.design.rows` (with CLI-computed `severity`) ONLY for pairs that have BOTH numbers and
  parse cleanly — mechanizing the two-numbers rule: no row exists without both values;
- lists `unmeasured` — nodes on the `--figma` inventory with no `--impl` counterpart. This is the
  pill-omission and the 40px-guess made impossible: a node you extracted but did not measure keeps the diff
  **red** (`ok:false`, exit 2) until you measure it. You cannot pass by dropping the row;
- lists `malformed` (a pair whose value does not parse — a would-be guess) and `unexpected` (an impl node
  with no design spec — informational, non-blocking);
- exits **2** while any `unmeasured` or `malformed` entry remains, **0** once every extracted node carries a
  well-formed measured counterpart. A real Critical/Major gap on a well-formed pair is NOT a tool error — it
  is a legitimate finding (`ok:true`, surfaced in `summary.blocking`) that you then route to fix/waive.

Run it until it is green (exit 0), then fold its `rows` straight into the `qa.design` matrix below. Its
green state means "every node I extracted was measured with two real numbers" — it does NOT by itself mean
"no gaps"; gaps are the rows it emits with Major/Critical severity, which you still fix. This does not
replace the mandatory side-by-side visual pass (numbers still miss shape/alignment/imagery) — run both.

### Mechanical visual enforcement — `cat-state.mjs design visual` (the side-by-side pass, mechanized)

The mandatory side-by-side visual pass above (composition/alignment/proportion/imagery) used to be a
self-attested checkbox. It no longer is: the checkpoint gate now REQUIRES one `qa.design.visual[]` entry
per declared surface, computed by the sanctioned CLI from the two saved PNGs — a pure-Node pixel diff, no
self-report. Run it for every surface after saving both images (Step 3 below):

```
node "{helper}" design visual --session {sid} --figma <TO-BE export path> --impl <AS-IS screenshot path>
```

- Both paths MUST be real PNGs (the decoder is PNG-only — JPEG is rejected even though `qa.artifacts`
  otherwise accepts it), already saved under `.cat/_session-{sid}/ultragoal/artifacts/` and referenced in
  `qa.artifacts`. The CLI decodes both, letterboxes+downscales them onto a common canvas, and computes a
  pixel-diff ratio.
- Output includes `raw_diff_ratio` (before any `exclude_regions`), `diff_ratio` (after), and `severity`
  (`None` / `Major` / `Blocking`). Fold `surface`, `figma_export`, `impl_screenshot`, `raw_diff_ratio`,
  `diff_ratio`, `severity`, and `exclude_regions` (default `[]`) straight into `qa.design.visual[]` below —
  the checkpoint gate recomputes both ratios and the severity from the actual files regardless of what you
  submit (recompute-authoritative, exactly like the numeric rows), so there is nothing to hand-tune here.
- **`Blocking` is decided from `raw_diff_ratio` ALONE and is decided PRE any `exclude_regions`** —
  `exclude_regions` can only ever move a surface between `Major` and `None` (for a surface whose raw ratio
  is already below the block threshold); it can NEVER pull a `Blocking` surface down to `Major` or `None`,
  at any configured threshold. A `Blocking` result means a grossly mismatched render (wrong page, broken or
  near-blank render, totally different layout) — it is NEVER waivable, exactly like a computed numeric
  Critical: fix the render (or the capture), there is no waiver path. A `Major` result IS waivable, exactly
  like a numeric Major (`qa.design.waived`, user-acknowledged only).
- `exclude_regions` (optional, `[{ "x", "y", "w", "h" }]`, each normalized 0..1) lets you exclude a
  known-noisy region (e.g. a live data widget) from the diff — bounded to at most 15% of the frame in
  total; an attempt to exclude more is dropped entirely and the diff is recomputed on the full frame.
- `raw_diff_ratio` tracks gross RAW mismatch only — it is a coarse pixel-magnitude signal (default
  thresholds are intentionally loose, PROVISIONAL pre-calibration), not a substitute for the side-by-side
  eyeball pass above or the numeric matrix below; a passing `qa.design.visual[]` does not by itself mean
  "no visual gap", only "no gross mismatch".

## Step 1 — Extract the design policy (scoped to THIS goal)

Extract only policies that govern the current goal's surfaces — do not map the whole Figma file.
Pull, per surface: layout/grid, typography (family/size/weight/line-height/letter-spacing), color
tokens (effective hex, not token names alone), spacing (4-side padding/margin/gap), component states
(hover / focus / disabled / empty / error), and responsive breakpoints the design defines.

Rule: extract NUMBERS from the design source, never eyeball a screenshot. Use `get_metadata` for
node size/position and `get_design_context` (or REST node JSON) for CSS values; `get_variable_defs`
for color/type tokens. Screenshots are for visual cross-check only, not the basis of a numeric verdict.

Efficiency: a Figma node response for a whole frame can run to thousands of lines. Request the SPECIFIC
in-scope node (the mapped component/frame), not its parent tree, and pull it ONCE — persist the numbers
you need into the policy doc below and reuse them, rather than re-fetching the same node repeatedly
across the compare loop. Scope every `get_metadata`/`get_design_context` call to the target node id.

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

**Surface enumeration (mandatory, per-variant).** If the design defines conditional variants or states
for a component — e.g. a card's 1-thumbnail vs 2-thumbnail layout, empty vs populated, hover/focus/
disabled — enumerate EACH design-defined variant/state as its OWN surface in the mapping table and in
`qa.design.surfaces` (below), not as a single collapsed surface. Render and measure that variant's own
geometry (at minimum width, border-radius, gap) rather than assuming it matches a sibling variant. The
mandatory-row coverage in the qa.design schema applies **per rendered variant surface**: a component
with three design-defined states in scope needs three surfaces' worth of mandatory rows, not one.

## Step 3 — Capture & compare (per mapped surface, per breakpoint)

1. `browser_navigate` to the route, then `browser_resize` to the breakpoint width (match the design
   frame width 1:1 — do not capture at another width and resize after). Then **wait for the surface to
   fully settle before capturing**: `load`/network-idle, the root selector present, and every in-scope
   `<img>` loaded (`browser_evaluate`: `img.complete && img.naturalWidth > 0`) — poll/retry until true.
   Capturing mid-load or with placeholder images is a failed capture (Capture-integrity gate), not a
   basis for comparison.
2. Screenshot the surface and save under `.cat/_session-{sid}/ultragoal/artifacts/` as PNG, named
   e.g. `design-{goal}-{surface}-{bp}.png`. Capture at ≥2x (put `zoom:2` on the target element and
   take an element screenshot with the viewport unchanged) so the image is crisp AND clears the gate's
   4096-byte floor. Verify each saved file is real PNG/JPEG and ≥4096 bytes before listing it — the
   sanctioned CLI rejects the checkpoint otherwise. Per the Capture-integrity gate, ALSO confirm the
   image shows the real rendered component (not a blank / error / loading frame) — a byte count is not
   proof of a real capture. If the capture fails or looks blank, follow the retry protocol; if it still
   fails, that is a blocker, not a reason to proceed from the design spec.
3. Export the matching DESIGN frame image and save it beside the implementation screenshot as
   `design-{goal}-{surface}-{bp}-figma.png`: Figma MCP `get_screenshot` on the mapped node, or REST
   `GET /v1/images/{file_key}?ids={node}&format=png&scale=2`. Export the node in its frame context at
   the same width as the capture breakpoint (1:1 size principle — never an isolated sample node).
   Reference BOTH files in the findings-table row so a human can eyeball the AS-IS | TO-BE pair — two
   files side by side, no image compositing, no Pillow. In screenshots-only fallback mode the
   user-provided design image plays this role.
4. Measure the implemented values with `browser_evaluate` computed styles — NOT pixel-diffing alone.
   Measure exhaustively per the no-sampling doctrine above — every explicitly-sized node, not one
   representative value: container + parent wrapper (4-side padding, margin, border, radius, background),
   each text node (size/weight/line-height/letter-spacing/color), child gaps and left content inset,
   icons/checkboxes (measure the drawn element, not a 0px `<input>`), dividers, container chrome for
   drawers/modals (header title copy + color, close button, footer CTA), **and every small fixed-size
   element inside — pill / badge / label / chip / thumbnail / counter / avatar (measure its own
   `width`/`height`/`min-width`/`border-radius`/`gap`, not the banner it sits in)**. Convert
   alpha-composited colors to their effective hex before comparing. Every value here goes into the
   `--impl` manifest for `design diff`; every design number goes into `--figma` — hold BOTH before you
   call anything a mismatch (two-numbers rule), and measure the design's own property, not a proxy.
5. Use screenshot pixels only to cross-check what computed styles cannot settle: element offsets/
   alignment, icon asset shape/stroke, and near-black effective colors.
6. Diff each measured value against the Step 1 expected value and classify by the table below. Do this
   with `cat-state.mjs design diff` (Measurement doctrine above), not by eye: assemble the `--figma`
   inventory and the `--impl` measurements and run it until it exits 0 (no `unmeasured`/`malformed` left),
   then take its emitted `rows` as the basis of the matrix below. A row without BOTH numbers is not a
   finding — it is a node still to measure.
7. **Side-by-side visual pass (required, not optional).** Open the AS-IS render and the TO-BE design
   export together and compare them directly, producing a **visual-gap list** distinct from the numeric
   diff: overall composition/alignment (is the header/badge/row on the same line and edge as the
   design?), element proportion and shape, and — for image/thumbnail/media surfaces — the actual
   rendered imagery (aspect ratio, object-fit/crop, corner radius, inter-tile gap, overlay gradient).
   These are exactly the gaps computed styles miss. Any visual difference you can see becomes a finding:
   measure it to assign severity, but never wave it through because the numbers happened to match. A
   numeric-only comparison is NOT a complete design-QA.

## Severity classification (ported from the source's priority vocabulary)

| Gap category | Tolerance | Severity | Blocking? |
|---|---|---|---|
| Color (bg / text / border), effective hex | exact match | **Critical** | yes |
| border-radius | ±2px | **Major** | yes |
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
  recorded in the findings table but are NOT blockers and do NOT enter `qa.blockers`. A missing
  capability (environment check) or a failed/unreliable live capture (Capture-integrity gate) is ALSO
  a `qa.blockers` entry with `qa.status` `not-verified` — the design dimension cannot be `passed` from
  the design source alone.

### `qa.design` measurement matrix (mandatory, mechanically validated)

Alongside the findings table above, assemble the machine-readable `qa.design` object the leader folds
into the goal's `qa{}` quality-gate JSON. This is EXACTLY the shape the sanctioned CLI (`cat-state.mjs`)
parses and validates — do not rename keys or invent fields:

```json
{
  "source": "<the design/Figma URL or doc used>",
  "surfaces": [
    { "name": "<surface name, one per rendered variant — see Surface enumeration above>", "no_text": false }
  ],
  "rows": [
    {
      "surface": "<matches a surfaces[].name>",
      "element": "<element/node measured>",
      "property": "<one of the property enum below>",
      "figma_expected": "<value from the design source>",
      "impl_actual": "<value measured via browser_evaluate on the live DOM>",
      "severity": "<one of the severity enum below>"
    }
  ],
  "visual": [
    {
      "surface": "<matches a surfaces[].name — exactly ONE entry per declared surface, mandatory>",
      "figma_export": "<path to the saved TO-BE PNG, registered in qa.artifacts>",
      "impl_screenshot": "<path to the saved AS-IS PNG, registered in qa.artifacts>",
      "raw_diff_ratio": "<from `design visual` — pre-exclude_regions pixel-diff ratio>",
      "diff_ratio": "<from `design visual` — post-exclude_regions pixel-diff ratio>",
      "severity": "<None | Major | Blocking — see Mechanical visual enforcement above>",
      "exclude_regions": []
    }
  ],
  "waived": null,
  "not_applicable": null
}
```

- `property` enum (exact strings; the CLI rejects anything else): `font-size`, `line-height`,
  `font-weight`, `letter-spacing`, `font-family`, `color`, `width`, `height`, `padding-top`,
  `padding-right`, `padding-bottom`, `padding-left`, `margin-top`, `margin-right`, `margin-bottom`,
  `margin-left`, `gap`, `border-radius`. The aggregate forms `padding` and `margin` are also
  accepted by the CLI (use per-side keys when the design specifies different values per side).
- `severity` enum for `rows[]` (exact strings): `Critical`, `Major`, `Minor`, `Trivial`, `None`.
- `visual[]` is mandatory whenever `surfaces` is non-empty — see "Mechanical visual enforcement" above for
  how to produce each entry (`node "{helper}" design visual --figma ... --impl ...`). `severity` for
  `visual[]` entries uses a SEPARATE, 3-value enum: `None` / `Major` (waivable, same `qa.design.waived` as
  numeric Major) / `Blocking` (never waivable — decided from `raw_diff_ratio` alone, before
  `exclude_regions` is applied, so `exclude_regions` can never pull a `Blocking` surface down to `Major` or
  `None`). `raw_diff_ratio` and `diff_ratio` are identical whenever `exclude_regions` is empty.
- Per surface (unless that surface is `no_text:true`), MANDATORY rows cover `font-size`, `line-height`,
  `font-weight` for every in-scope text element, plus at least one of padding/margin/gap for spacing.
  This coverage is **per rendered variant surface** (see Surface enumeration above), not per component.
- Beyond that mandatory floor, include a row for EVERY explicitly-sized node you enumerated (no
  sampling — see the Measurement doctrine), especially each small fixed-size element (pill/badge/label/
  chip/thumbnail/counter/avatar) with its `width`/`height`/`min-width`/`border-radius`/`gap`. The gate's
  mandatory floor is per-surface, so it cannot by itself force a missing element's row — the `design diff`
  tool is what mechanically keeps every extracted node from being dropped; run it green before assembling
  this matrix and fold in its `rows`.
- `waived` is `null`, or `{"reason": "<substantive reason>", "surfaces": ["<surface names covered>"],
  "user_acknowledged": true}` — see [R18] Blocker handling below; **Major only, never Critical**.
- `not_applicable` is `null`, or `{"reason": "<substantive reason the design-sourced goal is non-UI>"}`
  — valid ONLY when no screenshot artifact exists in `qa.artifacts` AND the goal's top-level
  `architect_review.design_not_applicable_acknowledged` (boolean, nested inside `architect_review`,
  NOT inside `qa.design`) is `true`. Both the reason and the architect ack are required; a
  design-sourced goal that DOES have a screenshot cannot use `not_applicable`.

**The CLI recomputes severity — do not rely on a self-labeled value.** Every submitted `rows[].severity` is
independently recomputed by the sanctioned CLI from `figma_expected`/`impl_actual` against the existing
severity table above (`design-qa.md` severity classification); a submitted severity more lenient than
the recomputed one is rejected outright, and the checkpoint is refused if any recomputed severity is
Critical or Major and no valid hatch (`waived` or `not_applicable`) covers it. Because of this recompute,
measuring per-text `font-size`/`line-height`/`font-weight` and per-surface spacing is **mandatory, not
optional** — an incomplete or unmeasured matrix fails the gate exactly like a measured-and-wrong one; you
cannot skip a row to avoid a bad number. The SAME recompute-authoritative rule applies to `visual[]`: the
CLI always recomputes `raw_diff_ratio`/`diff_ratio`/`severity` from the actual PNGs, never trusting a
submitted value, and the checkpoint is refused if any surface computes `Blocking`, or computes `Major`
with no valid `waived` hatch covering it.

Design-dimension `qa.status` is `passed` only when BOTH: (a) the Capture-integrity gate's pre-verdict
self-check is fully satisfied (a real live render was captured, both AS-IS/TO-BE images exist and were
eyeballed, and every number came from the live DOM), AND (b) no unresolved Critical/Major gap remains AND
no `visual[]` surface computes `Blocking` (never waivable) or an unwaived `Major`.
A capture that failed or was skipped is `not-verified` with a `qa.blockers` entry — never `passed`. The leader
folds this into the goal's overall quality-gate JSON (`{architect_review, qa:{status, commands,
evidence, artifacts, blockers}}`) and runs `goal checkpoint --status complete --quality-gate-json`; the
CLI enforces the gate fail-closed (screenshots must be PNG/JPEG magic and ≥4096 bytes).

## Blocker handling

A goal with an unresolved Critical/Major design gap CANNOT checkpoint `complete`. Per the ultragoal
blocker flow, the leader either fixes it within the current goal (spawn an `executor` with the specific
gap + fix hint, then rerun this lane on the affected surfaces — full re-audit of the component, not a
narrow re-check of the one value) or spawns a new blocker goal (record-review-blockers) carrying the
findings. Never downgrade a real gap to advisory to pass the gate; a few pixels off spec is still Major.

**Actually apply the fix — do not stop at reporting the gap.** When the leader fixes within the goal,
the spawned `executor` MUST run the bundled **`design-qa` skill** (`cat-harness:design-qa`, invoke it
by name) as its fix procedure: overlay the Figma export and the implementation render at the SAME
pixel size, measure the ink (non-background) offset, edit the code, then re-capture and judge by eye
on the overlay — looping until the two match. This lane's job is measurement and gating; the
`design-qa` skill's job is the hands-on overlay-and-fix loop (with its `references/` measure/overlay
templates). Reporting a gap without running that loop is exactly the "screenshots but no fix applied"
failure this wiring exists to close.

**[R18] A Critical is NEVER waivable — fix it, full stop.** There is no path that clears a computed
Critical other than making the implementation match the design; `qa.design.waived` cannot cover a
Critical row and the CLI rejects it regardless of `user_acknowledged`. The same applies to a `visual[]`
surface that computes `Blocking`: it is decided from `raw_diff_ratio` alone (before `exclude_regions`) and
is never waivable — re-capture/fix the render, or re-verify the capture matches the intended surface.

**[R18] A remaining Major may be waived, but only by the USER, never by the agent.** The default is
still "resolve everything." If, after a genuine attempt to fix it, a Major gap cannot be resolved within
the goal, the leader MUST STOP and use AskUserQuestion to SURFACE the specific Major to the user —
showing the affected surface, the `property`, and the `figma_expected`/`impl_actual` values — before
doing anything else with it. The leader may record `qa.design.waived.user_acknowledged: true` ONLY after
the user has explicitly approved waiving that specific gap in that turn; the agent may NOT self-waive, may
NOT infer approval from silence or from a general "looks good," and may NOT set `user_acknowledged` in
anticipation of asking. If the user instead chooses to keep fixing, treat it exactly like any other
unresolved Major: fix-and-rerun or spawn a blocker goal, per the paragraph above.

## Out of scope (explicit)

This lane produces design-verification EVIDENCE ONLY. It does NOT do test-case generation, Excel/report
generation, Jira ticket creation, multilingual copy review, or project-profile management. For the full
QA pipeline (test design, reporting, ticketing), the standalone Zigzag_web_QA skill exists separately —
do not reimplement it here and do not invoke it from inside ultragoal.

## Language

All questions, progress, and results shown to the user mirror the user's language. The policy doc and
findings artifacts are written in the user's language (they are user-facing evidence). Only state JSON
(`goals.json`, `ledger.jsonl`, `state/**`, quality-gate field values) stays English.
