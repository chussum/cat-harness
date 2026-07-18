import { describe, it, expect } from 'vitest'
import {
  pickWanderTarget,
  facingFromDelta,
  conversationTargets,
  estimateBubbleHeightPx,
  estimateExcerptLines,
  estimateContentHeightPx,
  pairedBubbleDirections,
  bubbleAnchorDirection,
  bubbleMarginPx,
  clampBubbleMarginPx,
  tailOffsetPx,
  bubbleBodyLeftCss,
  bubbleTailLeftCss,
  clampedBodyCenterPx,
  tailOffsetWithinBody,
  BUBBLE_GAP_PX,
  BUBBLE_LANE_GAP_PX,
  BUBBLE_CHARS_PER_LINE_ESTIMATE,
  MIN_BUBBLE_MARGIN_PX,
  TAIL_HALF_WIDTH_PX,
  TAIL_OVERLAP_PX,
  ROOM_BOUNDS,
} from './wander'
import { CAT_SPRITE_HEIGHT_PX, CAT_SPRITE_WITH_HAT_HEIGHT_PX } from './ui'

describe('pickWanderTarget', () => {
  it('places the point at the near corner when rng always returns 0', () => {
    expect(pickWanderTarget(ROOM_BOUNDS, 10, () => 0)).toEqual({ x: 10, y: 10 })
  })

  it('places the point at the far corner (bounds - margin) when rng always returns just under 1', () => {
    const point = pickWanderTarget(ROOM_BOUNDS, 10, () => 0.999999)
    expect(point.x).toBeCloseTo(90, 0)
    expect(point.y).toBeCloseTo(90, 0)
  })

  it('centers when rng returns 0.5', () => {
    expect(pickWanderTarget(ROOM_BOUNDS, 10, () => 0.5)).toEqual({ x: 50, y: 50 })
  })

  it('falls back to the room center when the margin leaves no space to roam', () => {
    expect(pickWanderTarget({ width: 10, height: 10 }, 20, () => 0.7)).toEqual({ x: 10, y: 10 })
  })

  it('never returns a point outside the bounds', () => {
    const rng = () => 1 // out-of-range edge case for a naive implementation
    const point = pickWanderTarget(ROOM_BOUNDS, 5, rng)
    expect(point.x).toBeLessThanOrEqual(ROOM_BOUNDS.width)
    expect(point.y).toBeLessThanOrEqual(ROOM_BOUNDS.height)
  })
})

describe('facingFromDelta', () => {
  it('faces right (1) for a rightward move', () => {
    expect(facingFromDelta(5)).toBe(1)
  })

  it('faces left (-1) for a leftward move', () => {
    expect(facingFromDelta(-5)).toBe(-1)
  })

  it('keeps the previous facing for a negligible delta', () => {
    expect(facingFromDelta(0.1, -1)).toBe(-1)
    expect(facingFromDelta(-0.1, 1)).toBe(1)
  })
})

describe('conversationTargets', () => {
  it('returns two distinct points that stay within the room margins', () => {
    const [a, b] = conversationTargets(ROOM_BOUNDS, 10, () => 0.5)
    expect(a.x).toBeGreaterThanOrEqual(10)
    expect(b.x).toBeLessThanOrEqual(90)
    expect(a.x).not.toBe(b.x)
    expect(a.y).toBe(b.y) // same anchor row, so the two cats read as facing each other
  })

  it('is deterministic for a fixed rng', () => {
    const rng = () => 0.25
    expect(conversationTargets(ROOM_BOUNDS, 10, rng)).toEqual(conversationTargets(ROOM_BOUNDS, 10, rng))
  })
})

describe('estimateBubbleHeightPx', () => {
  it('is taller for a combined (dispatch+reply) bubble than a single-entry one', () => {
    expect(estimateBubbleHeightPx(2)).toBeGreaterThan(estimateBubbleHeightPx(1))
  })

  it('is deterministic', () => {
    expect(estimateBubbleHeightPx(1)).toBe(estimateBubbleHeightPx(1))
  })
})

describe('estimateExcerptLines', () => {
  it('is at least 1 even for an empty string', () => {
    expect(estimateExcerptLines('')).toBe(1)
  })

  it('is 1 for a short excerpt that fits on one line', () => {
    expect(estimateExcerptLines('short')).toBe(1)
  })

  it('grows with excerpt length', () => {
    const short = estimateExcerptLines('a'.repeat(10))
    const long = estimateExcerptLines('a'.repeat(200))
    expect(long).toBeGreaterThan(short)
  })

  it('matches ceil(length / charsPerLine)', () => {
    expect(estimateExcerptLines('a'.repeat(BUBBLE_CHARS_PER_LINE_ESTIMATE * 3), BUBBLE_CHARS_PER_LINE_ESTIMATE)).toBe(3)
    expect(estimateExcerptLines('a'.repeat(BUBBLE_CHARS_PER_LINE_ESTIMATE * 3 + 1), BUBBLE_CHARS_PER_LINE_ESTIMATE)).toBe(4)
  })

  it('honors a custom charsPerLine', () => {
    expect(estimateExcerptLines('a'.repeat(20), 10)).toBe(2)
  })
})

describe('estimateContentHeightPx (the real, excerpt-length-aware height estimate)', () => {
  it('is taller for a longer excerpt than a shorter one (unlike the old entryCount-only estimate, which could not tell them apart)', () => {
    const short = estimateContentHeightPx('short excerpt', null)
    const long = estimateContentHeightPx('a'.repeat(200), null)
    expect(long).toBeGreaterThan(short)
  })

  it('returns the same base+one-line height for a null excerpt as for a short one (both estimate 1 line)', () => {
    // dispatch-only vs reply-only, same short length -> same estimate regardless of which slot it's in
    expect(estimateContentHeightPx('short', null)).toBe(estimateContentHeightPx(null, 'short'))
  })

  it('is taller when both dispatch and reply are present than either alone', () => {
    const dispatchOnly = estimateContentHeightPx('hello', null)
    const both = estimateContentHeightPx('hello', 'world')
    expect(both).toBeGreaterThan(dispatchOnly)
  })

  it('is 0-line-based (just the base) when neither is present', () => {
    expect(estimateContentHeightPx(null, null)).toBe(estimateContentHeightPx(null, null))
    expect(estimateContentHeightPx(null, null)).toBeLessThan(estimateContentHeightPx('x', null))
  })

  it('is deterministic', () => {
    expect(estimateContentHeightPx('same text', 'other text')).toBe(estimateContentHeightPx('same text', 'other text'))
  })
})

describe('pairedBubbleDirections (fit-aware opposite-side assignment)', () => {
  it('defaults to leader=above, worker=below when both bubbles are the same estimated height', () => {
    expect(pairedBubbleDirections(80, 80, 200, 400)).toEqual({ leader: 'above', worker: 'below' })
  })

  it('defaults to leader=above, worker=below when both are equal AND the room is asymmetric (ties never depend on room shape)', () => {
    expect(pairedBubbleDirections(80, 80, 100, 400)).toEqual({ leader: 'above', worker: 'below' })
  })

  it('always assigns opposite sides, never the same side twice', () => {
    for (const [d, r, y] of [
      [80, 80, 200],
      [200, 80, 200],
      [80, 200, 200],
      [200, 80, 350],
      [80, 200, 350],
    ] as const) {
      const result = pairedBubbleDirections(d, r, y, 400)
      expect(result.leader).not.toBe(result.worker)
    }
  })

  it('gives the TALLER dispatch (leader) bubble the side with MORE room, when the room is centered (both sides equal) it stays the simple default', () => {
    // centered row (y=200 of 400): both sides equal (200/200) -> ties keep the default regardless of height difference direction,
    // since "more room" is itself a tie; the assignment only flips when the SIDES differ.
    expect(pairedBubbleDirections(200, 80, 200, 400)).toEqual({ leader: 'above', worker: 'below' })
  })

  it('keeps the default even when the REPLY is the taller one, as long as the room is centered (a tied room beats a height difference)', () => {
    // This is the gap a naive "taller always wins" rule would get wrong: with
    // a centered row, flipping sides for a taller reply achieves nothing
    // (both sides are equally roomy), so the simple default should win.
    expect(pairedBubbleDirections(80, 200, 200, 400)).toEqual({ leader: 'above', worker: 'below' })
  })

  it('gives the taller dispatch (leader) bubble the BELOW side when below has more room', () => {
    // y=100 of 400 -> spaceAbove=100, spaceBelow=300 (below has more room)
    expect(pairedBubbleDirections(200, 80, 100, 400)).toEqual({ leader: 'below', worker: 'above' })
  })

  it('gives the taller reply (worker) bubble the ABOVE side when above has more room', () => {
    // y=300 of 400 -> spaceAbove=300, spaceBelow=100 (above has more room), reply is taller
    expect(pairedBubbleDirections(80, 200, 300, 400)).toEqual({ leader: 'below', worker: 'above' })
  })

  it('gives the taller reply (worker) bubble the BELOW side when below has more room (matches the simple default)', () => {
    // y=100 of 400 -> spaceAbove=100, spaceBelow=300 (below has more room), reply is taller
    expect(pairedBubbleDirections(80, 200, 100, 400)).toEqual({ leader: 'above', worker: 'below' })
  })
})

describe('bubbleAnchorDirection', () => {
  it('grows above when there is enough room above the cat', () => {
    // room 300px tall, cat 200px from the top -> 200px of room above, 100px below
    expect(bubbleAnchorDirection(200, 300, 84)).toBe('above')
  })

  it('flips below when the cat is too close to the top for the bubble to fit above (the clipping bug)', () => {
    // cat only 20px from the room's top edge -> an "above" bubble would get clipped; must grow down
    expect(bubbleAnchorDirection(20, 300, 84)).toBe('below')
  })

  it('flips above when the cat is too close to the bottom for the bubble to fit below', () => {
    expect(bubbleAnchorDirection(290, 300, 84)).toBe('above')
  })

  it('accounts for a taller (combined) bubble needing more clearance than a shorter one', () => {
    // 90px of room above the cat: enough for a 1-entry bubble, not enough for a 2-entry one
    const oneEntry = estimateBubbleHeightPx(1)
    const twoEntry = estimateBubbleHeightPx(2)
    expect(bubbleAnchorDirection(90, 300, oneEntry)).toBe('above')
    expect(bubbleAnchorDirection(90, 300, twoEntry)).toBe('below')
  })

  it('picks the side with more room when neither fully fits (a very short room) — minimizes clipping instead of eliminating it', () => {
    expect(bubbleAnchorDirection(20, 60, 200)).toBe('below') // 20px above, 40px below
    expect(bubbleAnchorDirection(45, 60, 200)).toBe('above') // 45px above, 15px below
  })
})

describe('bubbleMarginPx', () => {
  it('defaults to the base gap for lane 0', () => {
    expect(bubbleMarginPx(0)).toBe(BUBBLE_GAP_PX)
    expect(bubbleMarginPx()).toBe(BUBBLE_GAP_PX)
  })

  it('adds one lane gap per additional stacked bubble, guaranteeing separation', () => {
    expect(bubbleMarginPx(1)).toBe(BUBBLE_GAP_PX + BUBBLE_LANE_GAP_PX)
    expect(bubbleMarginPx(2)).toBe(BUBBLE_GAP_PX + 2 * BUBBLE_LANE_GAP_PX)
  })

  it('honors custom base/lane pixel overrides', () => {
    expect(bubbleMarginPx(2, 5, 10)).toBe(25)
  })
})

describe('clampBubbleMarginPx (the "never clip" safety net)', () => {
  it('returns the ideal margin unchanged when the room has plenty of room (the common case)', () => {
    // 300px room, cat at y=200 (200px of space above) — a small 76px bubble
    // with the default 40px margin fits easily above.
    expect(clampBubbleMarginPx(200, 300, 76, 'above', 40)).toBe(40)
  })

  it('shrinks the margin, never below minMarginPx, when the ideal margin would push the box past the room TOP edge', () => {
    // Only 100px of space above the cat; a 76px bubble + a 40px ideal margin
    // (116px total) would poke 16px past the top. The clamped margin should
    // land exactly at the boundary: box top edge = catY - margin - height = 0.
    const margin = clampBubbleMarginPx(100, 300, 76, 'above', 40)
    expect(margin).toBe(24) // 100 - 76
    expect(100 - margin - 76).toBe(0) // box top edge sits exactly at the room's top edge, not past it
  })

  it('shrinks the margin, never below minMarginPx, when the ideal margin would push the box past the room BOTTOM edge', () => {
    // Room height 300, cat at y=200 -> only 100px below; same 76px bubble.
    const margin = clampBubbleMarginPx(200, 300, 76, 'below', 40)
    expect(margin).toBe(24) // 300 - 200 - 76
    expect(200 + margin + 76).toBe(300) // box bottom edge sits exactly at the room's bottom edge
  })

  it('never shrinks below minMarginPx even when the room is too short to fit at all (best-effort, not zero/negative)', () => {
    // Only 20px above the cat, but the bubble alone needs 76px — even a
    // zero-margin box would already overflow. The function still returns a
    // small positive floor rather than 0 or a negative value.
    const margin = clampBubbleMarginPx(20, 300, 76, 'above', 40, MIN_BUBBLE_MARGIN_PX)
    expect(margin).toBe(MIN_BUBBLE_MARGIN_PX)
    expect(margin).toBeGreaterThan(0)
  })

  it('honors a custom minMarginPx floor', () => {
    const margin = clampBubbleMarginPx(50, 300, 76, 'above', 40, 15)
    expect(margin).toBe(15)
  })
})

describe('bubble face-clearance (a bubble must never cover the cat\'s face/head)', () => {
  it('keeps the tail (the closest point to the cat) at least the tallest sprite\'s half-height away from the cat\'s own center, for lane 0', () => {
    // The bubble/tail vertical position is `marginPx` (>= BUBBLE_GAP_PX) away
    // from the cat's own center coordinate, minus TAIL_OVERLAP_PX for the
    // tail's own poke-toward-the-cat. That must still clear the tallest
    // sprite (the leader, with its cap) rendered centered via
    // `translate(-50%, -50%)` — i.e. at least half its full height above
    // the cat's own head, on whichever side (above/below) it grows.
    const tailNearEdgeGapPx = bubbleMarginPx(0) - TAIL_OVERLAP_PX
    expect(tailNearEdgeGapPx).toBeGreaterThanOrEqual(CAT_SPRITE_WITH_HAT_HEIGHT_PX / 2)
  })

  it('clears a non-leader (hat-less) sprite with even more room to spare', () => {
    const tailNearEdgeGapPx = bubbleMarginPx(0) - TAIL_OVERLAP_PX
    expect(tailNearEdgeGapPx).toBeGreaterThan(CAT_SPRITE_HEIGHT_PX / 2)
  })

  it('every stacked lane only ever grows the gap, never shrinks it below lane 0\'s clearance', () => {
    for (const lane of [0, 1, 2]) {
      expect(bubbleMarginPx(lane)).toBeGreaterThanOrEqual(BUBBLE_GAP_PX)
    }
  })
})

describe('tailOffsetPx', () => {
  it('tracks the cat exactly when the cat sits well within the body (the common case: body centered on the cat)', () => {
    // a 320px-wide body centered on the cat -> the cat sits at dead center, 160px from the left edge
    expect(tailOffsetPx(160, 320)).toBe(160)
  })

  it('tracks the cat as it wanders to a different offset within the body', () => {
    expect(tailOffsetPx(100, 320)).toBe(100)
    expect(tailOffsetPx(220, 320)).toBe(220)
  })

  it('clamps to the left edge (plus half the tail width) instead of letting the tail detach past the corner', () => {
    expect(tailOffsetPx(-50, 320)).toBe(TAIL_HALF_WIDTH_PX)
    expect(tailOffsetPx(0, 320)).toBe(TAIL_HALF_WIDTH_PX)
  })

  it('clamps to the right edge (minus half the tail width) the same way', () => {
    expect(tailOffsetPx(400, 320)).toBe(320 - TAIL_HALF_WIDTH_PX)
    expect(tailOffsetPx(320, 320)).toBe(320 - TAIL_HALF_WIDTH_PX)
  })

  it('is direction-agnostic — the same x is correct whether the bubble grows above or below (only the edge the caller draws it on differs)', () => {
    // bubbleAnchorDirection only decides top vs bottom; the tail's x formula doesn't change either way
    expect(tailOffsetPx(90, 320)).toBe(tailOffsetPx(90, 320))
  })

  it('honors a custom tail half-width', () => {
    expect(tailOffsetPx(2, 320, 10)).toBe(10)
    expect(tailOffsetPx(318, 320, 10)).toBe(310)
  })
})

describe('clampedBodyCenterPx (horizontal body clamp)', () => {
  const ROOM_W = 800
  const BODY_W = 320 // half = 160

  it('stays exactly on the cat when it is well clear of both walls', () => {
    expect(clampedBodyCenterPx(50, ROOM_W, BODY_W)).toBe(400) // 50% of 800 = 400, within [160, 640]
  })

  it('clamps to the left wall (half-width in) when the cat is near the left edge', () => {
    // 2% of 800 = 16px raw -> less than half (160) -> clamped
    expect(clampedBodyCenterPx(2, ROOM_W, BODY_W)).toBe(160)
  })

  it('clamps to the right wall (half-width in) when the cat is near the right edge', () => {
    // 98% of 800 = 784px raw -> more than roomWidth-half (640) -> clamped
    expect(clampedBodyCenterPx(98, ROOM_W, BODY_W)).toBe(640)
  })
})

describe('bubbleBodyLeftCss', () => {
  it('emits a CSS clamp() mixing the fixed pixel half-width and the room-relative percent', () => {
    expect(bubbleBodyLeftCss(45, 320)).toBe('clamp(160px, 45%, calc(100% - 160px))')
  })
})

describe('bubbleTailLeftCss', () => {
  it('emits a CSS clamp() using the (much smaller) tail half-width', () => {
    expect(bubbleTailLeftCss(45)).toBe(`clamp(${TAIL_HALF_WIDTH_PX}px, 45%, calc(100% - ${TAIL_HALF_WIDTH_PX}px))`)
  })

  it('honors a custom tail half-width', () => {
    expect(bubbleTailLeftCss(12, 10)).toBe('clamp(10px, 12%, calc(100% - 10px))')
  })
})

describe('tailOffsetWithinBody (the tail "compensates" as the body clamps)', () => {
  const ROOM_W = 800
  const BODY_W = 320 // half = 160

  it('sits dead center when the body is unclamped (cat well clear of both walls)', () => {
    expect(tailOffsetWithinBody(50, ROOM_W, BODY_W)).toBe(BODY_W / 2)
  })

  it('shifts toward the LEFT edge of the body when the cat is near the left wall (body clamped there)', () => {
    // cat at 2% (16px): body clamps to center=160 (left edge at 0), so the
    // tail — still tracking the cat's true 16px position — sits only 16px
    // from the body's own left edge, near that corner, not centered.
    const offset = tailOffsetWithinBody(2, ROOM_W, BODY_W)
    expect(offset).toBe(16)
    expect(offset).toBeLessThan(BODY_W / 2)
  })

  it('shifts toward the RIGHT edge of the body when the cat is near the right wall (body clamped there)', () => {
    // cat at 98% (784px): body clamps to center=640 (left edge at 480), so
    // the tail sits at 784-480=304px from the body's own left edge, near
    // that corner.
    const offset = tailOffsetWithinBody(98, ROOM_W, BODY_W)
    expect(offset).toBe(304)
    expect(offset).toBeGreaterThan(BODY_W / 2)
  })

  it('never exceeds the body bounds (still clamped within it via tailOffsetPx)', () => {
    expect(tailOffsetWithinBody(0, ROOM_W, BODY_W)).toBeGreaterThanOrEqual(TAIL_HALF_WIDTH_PX)
    expect(tailOffsetWithinBody(100, ROOM_W, BODY_W)).toBeLessThanOrEqual(BODY_W - TAIL_HALF_WIDTH_PX)
  })
})
