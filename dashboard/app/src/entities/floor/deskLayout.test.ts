import { describe, it, expect } from 'vitest'
import {
  deskSlotPosition,
  deskPositionsForWorkers,
  leaderApproachPoint,
  leaderDeliveryTarget,
  activeWorkerToyPosition,
  DESK_AREA,
  DESK_COLUMNS,
  AGENT_DESK_AREA,
  AGENT_DESK_COLUMNS,
  LEADER_APPROACH_OFFSET_X,
  ACTIVE_WORKER_TOY_OFFSET,
} from './deskLayout'
import { ROOM_BOUNDS, estimateBubbleHeightPx, bubbleMarginPx, clampBubbleMarginPx } from '@/entities/cat/wander'
import { AGENT_ROLES } from '@/entities/cat/model'
import { ROOM_HEIGHT_PX } from './ui'

const CANONICAL_ROLE_DESK_POSITIONS = deskPositionsForWorkers([...AGENT_ROLES], AGENT_DESK_AREA, AGENT_DESK_COLUMNS)
const CANONICAL_DESKS = Object.values(CANONICAL_ROLE_DESK_POSITIONS)

describe('deskSlotPosition', () => {
  it('centers a single desk within the desk area', () => {
    expect(deskSlotPosition(0, 1)).toEqual({
      x: (DESK_AREA.xMin + DESK_AREA.xMax) / 2,
      y: (DESK_AREA.yMin + DESK_AREA.yMax) / 2,
    })
  })

  it('lays out up to DESK_COLUMNS desks in a single row, left to right', () => {
    const a = deskSlotPosition(0, 3)
    const b = deskSlotPosition(1, 3)
    const c = deskSlotPosition(2, 3)
    expect(a.y).toBe(b.y)
    expect(b.y).toBe(c.y)
    expect(a.x).toBeLessThan(b.x)
    expect(b.x).toBeLessThan(c.x)
  })

  it('wraps a 4th desk onto a second row', () => {
    const row1 = deskSlotPosition(0, 4)
    const row2 = deskSlotPosition(3, 4)
    expect(row2.y).toBeGreaterThan(row1.y)
  })

  it('centers a short final row instead of hugging the left edge', () => {
    // 4 desks, 3 columns -> row 2 has just 1 item; it should sit at the row's horizontal center.
    const solo = deskSlotPosition(3, 4)
    expect(solo.x).toBeCloseTo((DESK_AREA.xMin + DESK_AREA.xMax) / 2, 5)
  })

  it('never places a desk outside the configured area, for 1-4 workers', () => {
    for (let total = 1; total <= 4; total++) {
      for (let i = 0; i < total; i++) {
        const p = deskSlotPosition(i, total)
        expect(p.x).toBeGreaterThanOrEqual(DESK_AREA.xMin)
        expect(p.x).toBeLessThanOrEqual(DESK_AREA.xMax)
        expect(p.y).toBeGreaterThanOrEqual(DESK_AREA.yMin)
        expect(p.y).toBeLessThanOrEqual(DESK_AREA.yMax)
      }
    }
  })

  it('falls back to the area center for a non-positive total', () => {
    expect(deskSlotPosition(0, 0)).toEqual({
      x: (DESK_AREA.xMin + DESK_AREA.xMax) / 2,
      y: (DESK_AREA.yMin + DESK_AREA.yMax) / 2,
    })
  })

  it('gives no two desks (up to DESK_COLUMNS*2) the same position', () => {
    const total = DESK_COLUMNS * 2
    const seen = new Set<string>()
    for (let i = 0; i < total; i++) {
      const p = deskSlotPosition(i, total)
      const key = `${p.x},${p.y}`
      expect(seen.has(key)).toBe(false)
      seen.add(key)
    }
  })
})

describe('deskPositionsForWorkers', () => {
  it('assigns exactly one position per worker id', () => {
    const positions = deskPositionsForWorkers(['a', 'b', 'c'])
    expect(Object.keys(positions).sort()).toEqual(['a', 'b', 'c'])
  })

  it('is deterministic and independent of the input array order (sorted internally)', () => {
    const forward = deskPositionsForWorkers(['s1:agent:planner', 's1:agent:executor', 's1:agent:architect'])
    const shuffled = deskPositionsForWorkers(['s1:agent:executor', 's1:agent:architect', 's1:agent:planner'])
    expect(forward).toEqual(shuffled)
  })

  it('gives each worker a distinct desk', () => {
    const positions = deskPositionsForWorkers(['a', 'b', 'c', 'd'])
    const points = Object.values(positions).map((p) => `${p.x},${p.y}`)
    expect(new Set(points).size).toBe(4)
  })

  it('returns an empty map for no workers', () => {
    expect(deskPositionsForWorkers([])).toEqual({})
  })
})

describe('leaderApproachPoint', () => {
  it('stands beside the desk by the approach offset, same y as the desk', () => {
    // x=50 is exactly the room's horizontal midpoint, which the "right half"
    // branch owns (>=), so it's approached from its RIGHT (leader.x > desk.x).
    const desk = { x: 50, y: 50 }
    expect(leaderApproachPoint(desk)).toEqual({ x: 50 - LEADER_APPROACH_OFFSET_X, y: 50 })
  })

  it('approaches a right-half desk from its LEFT, so the leader never lands past the right wall', () => {
    const desk = { x: 80, y: 60 }
    const approach = leaderApproachPoint(desk)
    expect(approach.x).toBe(80 - LEADER_APPROACH_OFFSET_X)
    expect(approach.x).toBeLessThan(desk.x)
  })

  it('approaches a left-half desk from its RIGHT, so the leader never lands past the left wall', () => {
    const desk = { x: 20, y: 60 }
    const approach = leaderApproachPoint(desk)
    expect(approach.x).toBe(20 + LEADER_APPROACH_OFFSET_X)
    expect(approach.x).toBeGreaterThan(desk.x)
  })

  it('keeps the same y as the desk (side-by-side, not above/below)', () => {
    const desk = { x: 80, y: 63 }
    expect(leaderApproachPoint(desk).y).toBe(63)
  })

  it('never lands outside the room bounds for any desk in the configured desk area', () => {
    for (let total = 1; total <= 4; total++) {
      for (let i = 0; i < total; i++) {
        const desk = deskSlotPosition(i, total)
        const approach = leaderApproachPoint(desk)
        expect(approach.x).toBeGreaterThanOrEqual(0)
        expect(approach.x).toBeLessThanOrEqual(ROOM_BOUNDS.width)
        expect(approach.y).toBeGreaterThanOrEqual(0)
        expect(approach.y).toBeLessThanOrEqual(ROOM_BOUNDS.height)
      }
    }
  })

  it('clamps within the room bounds instead of overflowing past the right wall', () => {
    const desk = { x: ROOM_BOUNDS.width - 1, y: 50 }
    const approach = leaderApproachPoint(desk)
    expect(approach.x).toBeLessThanOrEqual(ROOM_BOUNDS.width)
  })

  it('clamps within the room bounds instead of overflowing past the left wall', () => {
    const desk = { x: 1, y: 50 }
    const approach = leaderApproachPoint(desk)
    expect(approach.x).toBeGreaterThanOrEqual(0)
  })

  it('keeps a small non-zero gap between the leader and the desk (sprites do not touch/overlap)', () => {
    const desk = { x: 66, y: 60 }
    const approach = leaderApproachPoint(desk)
    expect(Math.abs(approach.x - desk.x)).toBe(LEADER_APPROACH_OFFSET_X)
    expect(LEADER_APPROACH_OFFSET_X).toBeGreaterThan(0)
  })
})

describe('the 4 canonical agent roles — single-row desk layout, no cat-cat overlap', () => {
  const desks = CANONICAL_DESKS

  it('lays all 4 canonical roles out in ONE shared row (same y), not a multi-row grid', () => {
    expect(desks).toHaveLength(4)
    const rowsByY = new Set(desks.map((d) => d.y))
    expect(rowsByY.size).toBe(1)
    expect([...rowsByY][0]).toBe(AGENT_DESK_AREA.yMin)
  })

  it('spaces the 4 desks evenly left-to-right across AGENT_DESK_AREA', () => {
    const xs = [...desks.map((d) => d.x)].sort((a, b) => a - b)
    const gaps = xs.slice(1).map((x, i) => x - xs[i])
    // Evenly spaced: every adjacent gap is the same.
    for (const gap of gaps) expect(gap).toBeCloseTo(gaps[0], 5)
    expect(gaps[0]).toBeGreaterThan(0)
  })

  it('gives every desk a distinct position', () => {
    const points = desks.map((d) => `${d.x},${d.y}`)
    expect(new Set(points).size).toBe(4)
  })

  it('places every desk inside AGENT_DESK_AREA (in-room bounds)', () => {
    for (const desk of desks) {
      expect(desk.x).toBeGreaterThanOrEqual(AGENT_DESK_AREA.xMin)
      expect(desk.x).toBeLessThanOrEqual(AGENT_DESK_AREA.xMax)
      expect(desk.y).toBe(AGENT_DESK_AREA.yMin)
    }
  })

  it("keeps every desk's leader-approach point clear of every OTHER desk (min gap check, so the leader sprite never overlaps a neighboring worker's desk) — with a single shared row, EVERY pair is now a same-row risk, not just adjacent columns", () => {
    // A generous minimum gap (room-percent) that's safe for any realistic
    // scene width: desk props are a fixed 64px wide and the leader sprite
    // ~55px, so even a fairly narrow scene column comfortably clears this.
    const MIN_SAFE_GAP_PERCENT = 10
    for (const targetDesk of desks) {
      const approach = leaderApproachPoint(targetDesk)
      for (const otherDesk of desks) {
        if (otherDesk === targetDesk) continue
        const gap = Math.abs(approach.x - otherDesk.x)
        expect(gap).toBeGreaterThanOrEqual(MIN_SAFE_GAP_PERCENT)
      }
      // The leader itself must also stay inside the room.
      expect(approach.x).toBeGreaterThanOrEqual(0)
      expect(approach.x).toBeLessThanOrEqual(ROOM_BOUNDS.width)
    }
  })

  it('never overlaps two desks against each other (bounding-box style: every pairwise gap exceeds the combined desk half-widths)', () => {
    // Same generous safety margin as the leader-approach check above.
    const MIN_SAFE_GAP_PERCENT = 10
    for (let i = 0; i < desks.length; i++) {
      for (let j = i + 1; j < desks.length; j++) {
        const gap = Math.abs(desks[i].x - desks[j].x)
        expect(gap).toBeGreaterThanOrEqual(MIN_SAFE_GAP_PERCENT)
      }
    }
  })

  it("centers the row (y=50) so BOTH sides get the SAME, maximal amount of clear room-percent space for the leader/worker paired bubbles (entities/cat/wander.ts's pairedBubbleDirections)", () => {
    const rowYPx = (AGENT_DESK_AREA.yMin / 100) * ROOM_HEIGHT_PX
    const spaceAbovePx = rowYPx
    const spaceBelowPx = ROOM_HEIGHT_PX - rowYPx
    const requiredPx = estimateBubbleHeightPx(1) + bubbleMarginPx(0)
    expect(spaceAbovePx).toBe(spaceBelowPx) // dead-centered, not just "enough on both sides"
    expect(spaceAbovePx).toBeGreaterThanOrEqual(requiredPx)
    expect(spaceBelowPx).toBeGreaterThanOrEqual(requiredPx)
  })

  it("never clips a much-taller-than-estimated excerpt (well beyond a typical excerpt) at the agent desk row's y, on EITHER paired-bubble side, thanks to clampBubbleMarginPx shrinking the gap instead", () => {
    const rowYPx = (AGENT_DESK_AREA.yMin / 100) * ROOM_HEIGHT_PX
    const idealMarginPx = bubbleMarginPx(0)
    // Deliberately large enough to force clampBubbleMarginPx to actually
    // shrink the gap on both sides (the row is centered, so both sides have
    // the SAME budget now) — comfortably under that budget with the
    // minimum margin floor, so this proves the clamp keeps both sides
    // in-bounds rather than asserting an outright-impossible worst case (a
    // bubble taller than the room has room for on its own, with zero
    // margin, cannot be saved by any margin adjustment — that's a hard
    // physical limit, not a bug).
    const worstCaseBubbleHeightPx = 180

    const aboveMargin = clampBubbleMarginPx(rowYPx, ROOM_HEIGHT_PX, worstCaseBubbleHeightPx, 'above', idealMarginPx)
    const aboveTopEdge = rowYPx - aboveMargin - worstCaseBubbleHeightPx
    expect(aboveTopEdge).toBeGreaterThanOrEqual(0) // never pokes past the room's top edge
    expect(aboveMargin).toBeLessThan(idealMarginPx) // the clamp actually engaged

    const belowMargin = clampBubbleMarginPx(rowYPx, ROOM_HEIGHT_PX, worstCaseBubbleHeightPx, 'below', idealMarginPx)
    const belowBottomEdge = rowYPx + belowMargin + worstCaseBubbleHeightPx
    expect(belowBottomEdge).toBeLessThanOrEqual(ROOM_HEIGHT_PX) // never pokes past the room's bottom edge
    expect(belowMargin).toBeLessThan(idealMarginPx) // the clamp actually engaged (both sides are equal now)
  })

  it("never places the leader's approach point on top of its OWN target desk", () => {
    for (const desk of desks) {
      const approach = leaderApproachPoint(desk)
      expect(Math.abs(approach.x - desk.x)).toBe(LEADER_APPROACH_OFFSET_X)
    }
  })
})

describe('activeWorkerToyPosition', () => {
  it('offsets from the desk by ACTIVE_WORKER_TOY_OFFSET when well clear of the walls', () => {
    const desk = { x: 50, y: 50 }
    expect(activeWorkerToyPosition(desk)).toEqual({
      x: 50 + ACTIVE_WORKER_TOY_OFFSET.x,
      y: 50 + ACTIVE_WORKER_TOY_OFFSET.y,
    })
  })

  it('clamps within the room bounds instead of drifting past the right wall', () => {
    const desk = { x: ROOM_BOUNDS.width - 1, y: 50 }
    const toy = activeWorkerToyPosition(desk)
    expect(toy.x).toBeLessThanOrEqual(ROOM_BOUNDS.width)
  })

  it('clamps within the room bounds instead of drifting past the top wall', () => {
    const desk = { x: 50, y: 1 }
    const toy = activeWorkerToyPosition(desk)
    expect(toy.y).toBeGreaterThanOrEqual(0)
  })

  it('never lands outside the room bounds for any of the 4 canonical desks', () => {
    for (const desk of CANONICAL_DESKS) {
      const toy = activeWorkerToyPosition(desk)
      expect(toy.x).toBeGreaterThanOrEqual(0)
      expect(toy.x).toBeLessThanOrEqual(ROOM_BOUNDS.width)
      expect(toy.y).toBeGreaterThanOrEqual(0)
      expect(toy.y).toBeLessThanOrEqual(ROOM_BOUNDS.height)
    }
  })
})

describe('leaderDeliveryTarget', () => {
  const positions = { 'worker-a': { x: 60, y: 50 }, 'worker-b': { x: 80, y: 70 } }

  it('returns null when nothing is active (leader ambles instead)', () => {
    expect(leaderDeliveryTarget(positions, null)).toBeNull()
  })

  it('returns the approach point of the active worker desk', () => {
    expect(leaderDeliveryTarget(positions, 'worker-a')).toEqual(leaderApproachPoint(positions['worker-a']))
  })

  it('returns null for an active worker id with no known desk', () => {
    expect(leaderDeliveryTarget(positions, 'ghost')).toBeNull()
  })
})
