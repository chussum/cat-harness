/**
 * entities/cat/wander.ts — pure position/facing/bubble-placement math for the
 * top-down room scene's wandering cats. Wander positions are expressed as
 * percentages of the room box (0-100 on both axes), so that math works
 * regardless of the room's actual rendered pixel size — no
 * ResizeObserver/measurement needed, the room just renders each cat at
 * `left: x%; top: y%`.
 *
 * Speech-bubble placement, by contrast, is pixel-based: a bubble is nested
 * inside its cat's own wandering slot (see entities/floor/ui.tsx) so it
 * automatically tracks the cat's live position as it drifts, and deciding
 * which side it grows into needs to compare against the room's *actual*
 * pixel height (a fixed, known constant — ROOM_HEIGHT_PX in
 * entities/floor/ui.tsx) so a multi-line bubble never gets clipped by the
 * room's own `overflow-hidden`.
 *
 * No React here; see entities/cat/useWander.ts for the stateful hook that
 * drives a cat's position over time using these helpers.
 */

export interface Point {
  x: number
  y: number
}

export interface RoomBounds {
  width: number
  height: number
}

/** The room scene always lays cats/toys out in a 0-100 percentage space. */
export const ROOM_BOUNDS: RoomBounds = { width: 100, height: 100 }

const FACING_EPSILON = 0.5

function clamp(value: number, min: number, max: number): number {
  if (max < min) return (min + max) / 2
  return Math.min(Math.max(value, min), max)
}

/**
 * Picks a random point inside `bounds`, inset by `margin` on every edge (so
 * a cat's own footprint never clips the room wall). Falls back to the
 * room's center if the margin leaves no room to roam.
 */
export function pickWanderTarget(bounds: RoomBounds, margin: number, rng: () => number = Math.random): Point {
  const availableW = Math.max(0, bounds.width - margin * 2)
  const availableH = Math.max(0, bounds.height - margin * 2)
  return {
    x: clamp(margin + rng() * availableW, 0, bounds.width),
    y: clamp(margin + rng() * availableH, 0, bounds.height),
  }
}

/**
 * Which way a cat should face given its horizontal delta for this step;
 * keeps the previous facing when the move is negligible/near-vertical so it
 * doesn't flip-flop on tiny jitters.
 */
export function facingFromDelta(dx: number, previousFacing: 1 | -1 = 1): 1 | -1 {
  if (dx > FACING_EPSILON) return 1
  if (dx < -FACING_EPSILON) return -1
  return previousFacing
}

/**
 * Two points close together near a shared anchor, so a dispatch/reply pair
 * (the leader cat and the subagent it's talking to) can visibly drift
 * toward each other to "converse" instead of wandering independently.
 */
export function conversationTargets(bounds: RoomBounds, margin: number, rng: () => number = Math.random): [Point, Point] {
  const spread = Math.min(18, Math.max(0, (bounds.width - margin * 2) / 2))
  const anchor = pickWanderTarget(bounds, margin + spread, rng)
  return [
    { x: clamp(anchor.x - spread, margin, bounds.width - margin), y: anchor.y },
    { x: clamp(anchor.x + spread, margin, bounds.width - margin), y: anchor.y },
  ]
}

export type BubbleDirection = 'above' | 'below'

/** The speech bubble's own fixed width — kept in sync with `SpeechBubble.tsx`'s own inline `maxWidth` style (both read this same constant, not a hardcoded Tailwind class, so they can never drift apart) — it must be set explicitly wherever a bubble is positioned, since nesting it inside its (much narrower) cat sprite would otherwise squeeze its shrink-to-fit width down to the cat's width and wildly inflate its wrapped-text height. */
export const BUBBLE_MAX_WIDTH_PX = 300

/** Vertical padding/border/pointer-tail allowance, plus a generous per-entry (dispatch or reply) allowance — excerpts are capped at ~140 chars by the capture pipeline, so at the bubble's real 300px width (`BUBBLE_MAX_WIDTH_PX`) this comfortably covers up to a couple of wrapped lines per entry without underestimating; `clampBubbleMarginPx` (below) is the actual hard guarantee against clipping for anything taller than this estimate. */
const BUBBLE_BASE_PX = 30
const BUBBLE_PER_ENTRY_PX = 46

/**
 * Estimated worst-case pixel height of a speech bubble showing `entryCount`
 * lines (1 = dispatch-only or reply-only, 2 = both) — used to decide
 * whether it fits above/below a cat without measuring the real DOM (which
 * would need a ref + ResizeObserver; this is a deliberately generous
 * over-estimate instead, cheap and good enough to avoid clipping).
 */
export function estimateBubbleHeightPx(entryCount: 1 | 2): number {
  return BUBBLE_BASE_PX + entryCount * BUBBLE_PER_ENTRY_PX
}

/**
 * Rough characters-per-line at the bubble's own text-xs (12px) font and
 * (up to) `BUBBLE_MAX_WIDTH_PX`-wide box — deliberately conservative
 * (fewer chars/line than plain-Latin text would actually wrap at, closer to
 * worst-case CJK/full-width glyphs) so `estimateExcerptLines` below never
 * UNDER-counts how many lines a real excerpt will wrap to. Calibrated
 * against real rendered measurements of the ~140-190 char Korean+URL
 * fixture excerpts this app ships (see wander.test.ts).
 */
export const BUBBLE_CHARS_PER_LINE_ESTIMATE = 28

/** Pixel height of one wrapped line at the bubble's text-xs size (Tailwind's default 12px/16px font-size/line-height pairing). */
export const BUBBLE_LINE_HEIGHT_PX = 16

/** Extra pixel gap between the dispatch and reply lines when a single bubble shows both (the `mt-1` Tailwind margin in SpeechBubble.tsx). */
export const BUBBLE_ENTRY_GAP_PX = 4

/** Estimated wrapped-line count for one excerpt string at the bubble's real (up to `BUBBLE_MAX_WIDTH_PX`-wide) box — at least 1 even for an empty/short string. */
export function estimateExcerptLines(excerpt: string, charsPerLine = BUBBLE_CHARS_PER_LINE_ESTIMATE): number {
  return Math.max(1, Math.ceil(excerpt.length / charsPerLine))
}

/**
 * Estimated worst-case pixel height of a bubble holding `dispatch` and/or
 * `reply` excerpt text (whichever are non-null) — a REAL, content-length-aware
 * replacement for the coarse `estimateBubbleHeightPx(entryCount)` estimate
 * above (which only knows "1 or 2 lines shown," not how long either one
 * actually is). Each present excerpt contributes its own estimated wrapped
 * line count (`estimateExcerptLines`) at `BUBBLE_LINE_HEIGHT_PX` per line,
 * plus `BUBBLE_BASE_PX` padding/border/tail allowance and `BUBBLE_ENTRY_GAP_PX`
 * when both are shown. Still just an estimate (no real DOM
 * measurement/ResizeObserver) — `clampBubbleMarginPx` remains the actual
 * hard guarantee against clipping for anything taller than this predicts —
 * but it now scales with the excerpt's real length, which is what makes the
 * fit-aware side assignment below (`pairedBubbleDirections`) meaningful: two
 * bubbles that are both "1 entry" by the old measure can still differ a lot
 * in real height.
 */
export function estimateContentHeightPx(dispatch: string | null, reply: string | null): number {
  let lines = 0
  if (dispatch) lines += estimateExcerptLines(dispatch)
  if (reply) lines += estimateExcerptLines(reply)
  const gapPx = dispatch && reply ? BUBBLE_ENTRY_GAP_PX : 0
  return BUBBLE_BASE_PX + lines * BUBBLE_LINE_HEIGHT_PX + gapPx
}

/**
 * Decide whether a bubble should grow 'above' or 'below' its cat, given the
 * cat's pixel position within the room, the room's actual pixel height, and
 * the bubble's estimated height — NOT a fixed 50% midpoint — so a bubble
 * always fits fully inside the room's clip box instead of getting clipped
 * when the cat is near an edge. Prefers whichever side actually fits; if
 * (for a very short room) neither side fully fits, picks whichever side has
 * more room, to minimize clipping rather than eliminate it.
 */
export function bubbleAnchorDirection(catYPx: number, roomHeightPx: number, bubbleHeightPx: number): BubbleDirection {
  const spaceAbove = catYPx
  const spaceBelow = roomHeightPx - catYPx
  if (spaceAbove >= bubbleHeightPx) return 'above'
  if (spaceBelow >= bubbleHeightPx) return 'below'
  return spaceAbove >= spaceBelow ? 'above' : 'below'
}

/**
 * When a leader's dispatch bubble and its active worker's reply bubble
 * render SIMULTANEOUSLY (entities/floor/ui.tsx — the leader stands beside
 * the worker, so the two cats always share almost the same y and sit only
 * `LEADER_APPROACH_OFFSET_X` apart horizontally), `bubbleAnchorDirection`'s
 * normal per-cat auto-fit would independently pick the SAME side for both
 * (since both cats are at the same y, the fit calculation is identical) —
 * and because `BUBBLE_MAX_WIDTH_PX` (300px) is far wider than the two cats'
 * horizontal gap, two same-side bubbles would overlap each other even
 * though each individually clears its own cat's face. So they're always
 * forced to OPPOSITE sides — disjoint vertical bands, one strictly above
 * the shared row, one strictly below it — which makes them unable to
 * overlap each other regardless of how close the two cats stand, while each
 * still keeps the same `BUBBLE_GAP_PX` face-clearance on its own side.
 *
 * WHICH one gets which side is fit-aware, using `estimateContentHeightPx`
 * (real excerpt length, not just "1 or 2 entries"): the TALLER of the two
 * bubbles goes to whichever side currently has MORE available room, so a
 * long excerpt lands where it's least likely to need `clampBubbleMarginPx`
 * to shrink its gap. With a vertically CENTERED desk row
 * (`entities/floor/deskLayout.ts`'s `AGENT_DESK_AREA`) both sides start out
 * equal, so ties (including the common case where both are short) keep the
 * simple, predictable default: leader's dispatch above, worker's reply
 * below.
 */
export function pairedBubbleDirections(
  dispatchHeightPx: number,
  replyHeightPx: number,
  catYPx: number,
  roomHeightPx: number,
): { leader: BubbleDirection; worker: BubbleDirection } {
  const DEFAULT = { leader: 'above', worker: 'below' } as const
  const FLIPPED = { leader: 'below', worker: 'above' } as const

  const spaceAbove = catYPx
  const spaceBelow = roomHeightPx - catYPx

  // A tie on EITHER dimension means flipping would change nothing (tied
  // room) or would flip for no real reason (tied height) — keep the
  // simple, predictable default in both cases. In particular, with a
  // vertically CENTERED desk row (the normal case — space is tied), the
  // default holds regardless of which excerpt happens to be longer: fit-
  // awareness only kicks in once the two sides genuinely differ.
  if (spaceAbove === spaceBelow || dispatchHeightPx === replyHeightPx) return DEFAULT

  const aboveHasMoreRoom = spaceAbove > spaceBelow
  const dispatchIsTaller = dispatchHeightPx > replyHeightPx

  // The taller bubble must land on whichever side has more room. DEFAULT
  // already puts the dispatch (leader) above and the reply (worker) below,
  // so DEFAULT satisfies that rule exactly when "dispatch is taller"
  // agrees with "above has more room" (both true, or both false) —
  // otherwise the rule needs the flipped assignment instead.
  const defaultSatisfiesFit = dispatchIsTaller === aboveHasMoreRoom
  return defaultSatisfiesFit ? DEFAULT : FLIPPED
}

/**
 * Base pixel gap between a cat and its speech bubble (the bubble is nested
 * inside the cat's own wandering slot, so it automatically tracks the cat's
 * live position as it drifts — entities/floor/ui.tsx). Large enough to clear
 * a full cat sprite's half-height PLUS the leader's cap (the tallest sprite,
 * entities/cat/ui.tsx's `CAT_GRID`+`LEADER_HAT_GRID`, ~55px tall, so ~27.5px
 * half-height) even after `TAIL_OVERLAP_PX` eats into it below, with a few
 * px to spare — so the bubble's body (and its tail, the closest point to the
 * cat) never sits low enough to cover the cat's face/head, whichever side
 * (above or below) it grows on.
 */
export const BUBBLE_GAP_PX = 40

/** Extra pixel gap per stacked "lane" so two+ simultaneous bubbles on the same floor stay visually separated even if their cats happen to wander close together. */
export const BUBBLE_LANE_GAP_PX = 42

/** How far the tail pokes out past the bubble body's near edge, toward the cat, so it still visually connects to the cat even after `BUBBLE_GAP_PX`'s generous clearance (matches the old nested `-bottom-1.5`/`-top-1.5` look). Kept well under `BUBBLE_GAP_PX` so the tail's own near edge still clears the cat's head. */
export const TAIL_OVERLAP_PX = 6

/** The pixel margin (from the cat) a bubble in stacking "lane" `laneIndex` (0, 1, 2, ...) should use. */
export function bubbleMarginPx(laneIndex = 0, basePx = BUBBLE_GAP_PX, lanePx = BUBBLE_LANE_GAP_PX): number {
  return basePx + laneIndex * lanePx
}

/**
 * Absolute floor for the cat-to-bubble gap: even when `clampBubbleMarginPx`
 * must shrink the gap to keep a bubble from clipping the room's edge, it
 * never shrinks all the way to (or past) zero — the bubble/tail would then
 * touch or cross the cat's own sprite instead of just sitting closer to it.
 */
export const MIN_BUBBLE_MARGIN_PX = 6

/**
 * Shrinks a bubble's ideal cat-to-bubble margin (e.g. `bubbleMarginPx`'s
 * usual per-lane gap) just enough to keep a `bubbleHeightPx`-tall box fully
 * within `roomHeightPx` on the given `direction` — never below
 * `minMarginPx`. `estimateBubbleHeightPx` is a deliberately generous but
 * still static estimate; a genuinely long excerpt (dialogue excerpts are
 * capped at ~140 chars, which can still wrap to several lines at the
 * bubble's fixed width) can exceed it in practice, and a FORCED bubble
 * direction (`PAIRED_BUBBLE_DIRECTIONS`, entities/floor/ui.tsx) skips
 * `bubbleAnchorDirection`'s own fit check entirely — so this is the actual
 * hard guarantee against clipping, not just the sizing estimate: prefer
 * shrinking the gap over ever letting the box poke past the room's
 * top/bottom edge. Returns `idealMarginPx` unchanged whenever the room
 * already has enough room for it (the common case).
 */
export function clampBubbleMarginPx(
  catYPx: number,
  roomHeightPx: number,
  bubbleHeightPx: number,
  direction: BubbleDirection,
  idealMarginPx: number,
  minMarginPx = MIN_BUBBLE_MARGIN_PX,
): number {
  const available = direction === 'above' ? catYPx - bubbleHeightPx : roomHeightPx - catYPx - bubbleHeightPx
  if (available >= idealMarginPx) return idealMarginPx
  return Math.max(minMarginPx, available)
}

/** Half the pointer tail's own width (it's a 12px square rotated 45°), so it can be centered on a point without spilling past the bubble body's edge. */
export const TAIL_HALF_WIDTH_PX = 6

/**
 * Where (in px, from the bubble body's own left edge) the pointer tail
 * should sit so it always points at the cat's head — decoupled from the
 * bubble body's own horizontal position, which may shift (e.g. to clamp
 * within the room's edges) independently of the cat. `catOffsetFromBodyLeftPx`
 * is the cat's x position minus the body's current left edge; clamped so
 * the tail can never detach past the body's own corner. Direction-agnostic:
 * the same x lands the tail whether the bubble grows 'above' (tail on the
 * bottom edge, pointing down at the cat) or 'below' (tail on the top edge,
 * pointing up at the cat) — only which edge it's drawn on differs, handled
 * by the caller (SpeechBubble's `pointerSide`).
 */
export function tailOffsetPx(catOffsetFromBodyLeftPx: number, bodyWidthPx: number, tailHalfWidthPx = TAIL_HALF_WIDTH_PX): number {
  return clamp(catOffsetFromBodyLeftPx, tailHalfWidthPx, bodyWidthPx - tailHalfWidthPx)
}

/**
 * Horizontal clamping, the sequel to the vertical (top/bottom) clamping
 * above: a bubble whose body is centered on a cat near the room's LEFT or
 * RIGHT wall overflows that wall and gets clipped by the room's
 * `overflow-hidden`, same failure mode as the vertical case but sideways.
 *
 * There is no fixed room-*width* constant the way ROOM_HEIGHT_PX is a fixed
 * height (the room column is a responsive flex child), so — unlike the
 * vertical fix — this can't be resolved with plain pixel arithmetic in JS
 * without measuring the real DOM (ResizeObserver), which this whole feature
 * deliberately avoids. Instead, both the bubble body and its tail are
 * positioned via a native CSS `clamp()` (see `bubbleBodyLeftCss` /
 * `bubbleTailLeftCss`) that mixes room-relative `%` with the bubble's fixed
 * pixel width: the *browser* resolves the room's actual width at layout
 * time, so it clamps correctly for whatever width the room really has, with
 * zero JS-side measurement.
 *
 * The two numeric functions below (`clampedBodyCenterPx`,
 * `tailOffsetWithinBody`) model exactly the same math for a *given*,
 * explicit room width — they exist so the clamp/compensate relationship is
 * unit-testable without a real browser layout; the shipped renderer never
 * calls them with a real pixel width (it doesn't have one).
 */

/**
 * The bubble body's CSS `left` value: room-relative `%` clamped by the
 * bubble's own fixed pixel half-width, letting the browser keep a
 * `bodyWidthPx`-wide box fully inside the room regardless of the room's
 * actual (responsive) rendered width. Pair with `transform: translateX(-50%)`.
 */
export function bubbleBodyLeftCss(catXPercent: number, bodyWidthPx: number): string {
  const half = bodyWidthPx / 2
  return `clamp(${half}px, ${catXPercent}%, calc(100% - ${half}px))`
}

/**
 * The tail's own CSS `left` value — the same room-relative clamp as
 * `bubbleBodyLeftCss`, but with the tail's own tiny half-width instead of
 * the body's. Because the wander system already keeps every cat at least
 * `MARGIN` (12%) clear of each wall (entities/cat/useWander.ts), this
 * resolves to (for all intents, exactly) the cat's own position in every
 * realistic room width — the tail only needs its own clamp as a hard
 * guarantee, not because it's expected to engage in practice.
 */
export function bubbleTailLeftCss(catXPercent: number, tailHalfWidthPx = TAIL_HALF_WIDTH_PX): string {
  return `clamp(${tailHalfWidthPx}px, ${catXPercent}%, calc(100% - ${tailHalfWidthPx}px))`
}

/**
 * Numeric model of what `bubbleBodyLeftCss` resolves to for a *specific*
 * room width — the bubble body's horizontal center in px from the room's
 * left edge, clamped so a `bodyWidthPx`-wide box never crosses either wall.
 * For tests only; see the module doc comment above.
 */
export function clampedBodyCenterPx(catXPercent: number, roomWidthPx: number, bodyWidthPx: number): number {
  const half = bodyWidthPx / 2
  const rawPx = (catXPercent / 100) * roomWidthPx
  return clamp(rawPx, half, roomWidthPx - half)
}

/**
 * Numeric model of the "tail compensates as the body clamps" relationship
 * for a *specific* room width: the cat's true pixel position minus the
 * body's clamped left edge (via `clampedBodyCenterPx`), then clamped within
 * the body via `tailOffsetPx`. When the body is unclamped (cat well clear of
 * both walls) this is always exactly the body's half-width (dead center).
 * When the body has clamped to a wall, this shifts toward that same wall,
 * proving the tail keeps tracking the cat instead of staying centered on a
 * body that's no longer centered on the cat. For tests only.
 */
export function tailOffsetWithinBody(
  catXPercent: number,
  roomWidthPx: number,
  bodyWidthPx: number,
  tailHalfWidthPx = TAIL_HALF_WIDTH_PX,
): number {
  const catXPx = (catXPercent / 100) * roomWidthPx
  const bodyLeftEdgePx = clampedBodyCenterPx(catXPercent, roomWidthPx, bodyWidthPx) - bodyWidthPx / 2
  return tailOffsetPx(catXPx - bodyLeftEdgePx, bodyWidthPx, tailHalfWidthPx)
}
