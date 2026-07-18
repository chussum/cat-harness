/**
 * entities/floor/deskLayout.ts — pure layout math for the room's worker
 * desks and the leader's delivery target.
 *
 * Worker cats (every non-leader cat on a lit floor — see entities/floor/ui.tsx)
 * no longer wander; each gets its OWN desk at a fixed, deterministic spot so
 * it reads as "sitting at its desk working" instead of drifting around the
 * room. `deskPositionsForWorkers` assigns a stable desk-grid slot per worker
 * id (sorted, so the same set of active worker ids always yields the same
 * assignment regardless of the order they arrived in the snapshot — stable
 * across re-renders and SSE ticks); `deskSlotPosition` is the tidy
 * row/grid math itself, wrapping into a new row once a row fills up and
 * centering a short final row instead of hugging the left edge.
 *
 * The room's only mobile cat is the leader, which still uses
 * entities/cat/useWander.ts's normal wander loop when idle, but is PINNED to
 * a worker's desk (via `leaderDeliveryTarget`/`leaderApproachPoint`) while
 * that worker has an active conversation, so it reads as walking over to
 * deliver rather than orbiting randomly. The approach point sits BESIDE the
 * desk (a horizontal offset, same y as the worker) rather than below it —
 * standing below would vertically overlap the worker's own sprite (and its
 * speech bubble, which grows upward from roughly the same x) and obscure it;
 * standing beside instead reads as the two cats facing each other, each with
 * its own clearly separated bubble. No React here.
 */
import { ROOM_BOUNDS, type Point, type RoomBounds } from '@/entities/cat/wander'

/** How many desks fit in one row before wrapping to a new one below. */
export const DESK_COLUMNS = 3

/**
 * Every lit floor now always seats exactly the 4 canonical agent roles
 * (planner/architect/critic/executor — see entities/cat/model.ts's
 * `canonicalAgentCats`), and entities/floor/ui.tsx lays them out in a
 * SINGLE horizontal row (`AGENT_DESK_COLUMNS` = 4, all 4 in row 0 — see
 * `deskSlotPosition`'s wrap-at-`columns` math) rather than any multi-row
 * grid. A single shared row means no worker ever sits directly ABOVE
 * another, so an active worker's speech bubble — which always grows
 * vertically away from the row, into the empty half of the room — can
 * never end up covering a *different*, sleeping cat the way it could when
 * a 2-row grid put one desk directly above another (the bug this replaced;
 * see deskLayout.test.ts's cat-cat/bubble-cat overlap checks). Desks are
 * still spaced widely enough (`AGENT_DESK_AREA`) that the leader's
 * beside-approach point (`leaderApproachPoint`, offset
 * `LEADER_APPROACH_OFFSET_X` from its target desk) never lands close enough
 * to the NEXT desk over to visually overlap it.
 */
export const AGENT_DESK_COLUMNS = 4

/**
 * The room-percent rectangle desks are laid out inside — hand-picked to
 * clear every other decor prop in entities/floor/RoomDecor.tsx: the rug
 * (left 10-36%, top 58-90%), the bookshelf (top ~6-19%), the plant (top
 * ~8-26%, hugging the right edge) and the floor lamp (left ~90-93%, top
 * ~20-39%) — see entities/floor/ui.tsx for where each is rendered.
 */
export const DESK_AREA = { xMin: 40, xMax: 92, yMin: 42, yMax: 84 }

/**
 * The single-row area the 4 canonical agent desks (`AGENT_DESK_COLUMNS`)
 * are laid out inside — a single fixed `y` (a degenerate `yMin === yMax`
 * "row band") rather than `DESK_AREA`'s multi-row range, and a much wider
 * `x` span than `DESK_AREA` since a single shared row has no other row to
 * leave vertical room for. `y: 50` — dead center — sits in the "clear
 * corridor" between the bookshelf/plant/lamp (which all end by ~y40) and
 * the rug (which starts at y58) — see the props above — so this row clears
 * every decor prop at ANY x from 0-100, letting it use nearly the full room
 * width (had the row sat AT/BELOW the rug's y58 start instead, the desks
 * would need `xMin >= ~38` to clear the rug's own x10-36 span, shrinking the
 * usable width enough that 4 evenly-spaced desks could no longer keep
 * `LEADER_APPROACH_OFFSET_X` clear of a neighboring desk — see
 * deskLayout.test.ts's overlap check). Centering (rather than favoring one
 * side) gives the leader's dispatch bubble and the active worker's reply
 * bubble — forced to OPPOSITE sides, see `pairedBubbleDirections`
 * (entities/cat/wander.ts) — the maximum, EQUAL amount of room each: at
 * `ROOM_HEIGHT_PX = 400`, `ROOM_HEIGHT_PX * 0.5` = 200px clear on both
 * sides. `pairedBubbleDirections` is fit-aware (the taller of the two
 * bubbles, by real excerpt length via `estimateContentHeightPx`, gets
 * whichever side has more room) — with a centered row that only matters
 * when the two excerpts differ enough in length to tip an otherwise-tied
 * comparison; `clampBubbleMarginPx` remains the hard safety net that
 * shrinks the cat-to-bubble gap rather than ever letting a box clip the
 * room's top/bottom edge — see entities/floor/ui.tsx's `renderCatBubble`.
 */
export const AGENT_DESK_AREA = { xMin: 5, xMax: 95, yMin: 50, yMax: 50 }

/** How far (in room-percent) the leader stands off a worker's desk, horizontally, while "delivering" — a small gap so the two sprites read as side-by-side rather than touching/overlapping. */
export const LEADER_APPROACH_OFFSET_X = 12

function clamp(value: number, min: number, max: number): number {
  if (max < min) return (min + max) / 2
  return Math.min(Math.max(value, min), max)
}

/**
 * The room-percent position of desk slot `index` out of `total` desks,
 * wrapping at `columns` per row within `area`. A final row with fewer than
 * `columns` items is centered rather than left-hugging, so 1-4 (or any N)
 * workers always read as a tidy, intentional layout instead of a partial
 * grid trailing off.
 */
export function deskSlotPosition(index: number, total: number, area = DESK_AREA, columns = DESK_COLUMNS): Point {
  if (total <= 0) return { x: (area.xMin + area.xMax) / 2, y: (area.yMin + area.yMax) / 2 }
  const cols = Math.min(columns, total)
  const rows = Math.ceil(total / cols)
  const row = Math.floor(index / cols)
  const col = index % cols
  const itemsInRow = row === rows - 1 ? total - row * cols : cols
  const colWidth = (area.xMax - area.xMin) / cols
  const rowOffset = ((cols - itemsInRow) * colWidth) / 2
  const rowHeight = (area.yMax - area.yMin) / rows
  return {
    x: area.xMin + rowOffset + colWidth * (col + 0.5),
    y: area.yMin + rowHeight * (row + 0.5),
  }
}

/**
 * Desk position per worker cat id, keyed by id so a lookup (`positions[cat.id]`)
 * is stable regardless of the incoming array's order — the ids are sorted
 * before assigning slot indices, so the same active worker set always
 * produces the same layout across renders and SSE ticks.
 */
export function deskPositionsForWorkers(
  workerIds: string[],
  area = DESK_AREA,
  columns = DESK_COLUMNS,
): Record<string, Point> {
  const sorted = [...workerIds].sort()
  const positions: Record<string, Point> = {}
  sorted.forEach((id, index) => {
    positions[id] = deskSlotPosition(index, sorted.length, area, columns)
  })
  return positions
}

/**
 * Where the leader stands to "deliver" at a given desk: BESIDE it (a small
 * horizontal gap, same y as the worker) rather than below it, so the two
 * cats sit side-by-side — clearly visible, reading as facing each other —
 * instead of vertically overlapping. Picks whichever side keeps the leader
 * inside the room: a desk in the right half is approached from its LEFT
 * (leader.x < desk.x), a desk in the left half (or exactly centered) from
 * its RIGHT (leader.x > desk.x), so the leader never lands past a wall.
 */
export function leaderApproachPoint(deskPos: Point, bounds: RoomBounds = ROOM_BOUNDS, offsetX = LEADER_APPROACH_OFFSET_X): Point {
  const roomMidX = bounds.width / 2
  const side = deskPos.x >= roomMidX ? -1 : 1
  return { x: clamp(deskPos.x + side * offsetX, 0, bounds.width), y: clamp(deskPos.y, 0, bounds.height) }
}

/**
 * The leader's pinned wander target while delivering: the approach point of
 * the currently-active worker's desk, or `null` when nothing is active (in
 * which case the leader just ambles via its normal wander loop instead —
 * see entities/floor/ui.tsx's `pinnedTargets`).
 */
export function leaderDeliveryTarget(
  deskPositions: Record<string, Point>,
  activeWorkerCatId: string | null,
  bounds: RoomBounds = ROOM_BOUNDS,
): Point | null {
  if (!activeWorkerCatId) return null
  const deskPos = deskPositions[activeWorkerCatId]
  if (!deskPos) return null
  return leaderApproachPoint(deskPos, bounds)
}

/** Offset (room-percent) of the active worker's toy prop from its own desk (entities/floor/ui.tsx) — small, up and to the side, so it reads as sitting right beside the desk (within paw's reach) without covering the cat itself or its speech bubble growing above it. */
export const ACTIVE_WORKER_TOY_OFFSET: Point = { x: 8, y: -4 }

/**
 * Where the active (typing) worker's toy prop sits while it "plays" with it
 * during work (entities/floor/Toy.tsx's `playing` prop): a small fixed
 * offset from its desk, clamped inside the room so it can never drift past
 * a wall for a desk near the edge of `DESK_AREA`.
 */
export function activeWorkerToyPosition(
  deskPos: Point,
  bounds: RoomBounds = ROOM_BOUNDS,
  offset: Point = ACTIVE_WORKER_TOY_OFFSET,
): Point {
  return {
    x: clamp(deskPos.x + offset.x, 0, bounds.width),
    y: clamp(deskPos.y + offset.y, 0, bounds.height),
  }
}
