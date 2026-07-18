/**
 * entities/floor/toys.ts — pure helpers for the room's scattered toy props
 * (ball / yarn-ball / mouse toy / feather). No React.
 *
 * Toy count scales 1:1 with the number of cats currently on the floor
 * (skill-cats + agent-cats from entities/cat/model.ts's `sessionsToCats`) —
 * the same "how much is happening here" signal the lit/dormant window strip
 * already uses — capped at MAX_TOYS so a busy floor doesn't turn into
 * clutter. (The alternative signal considered was the dialogue round-trip
 * count, but that spikes/drops on every SSE tick and would make the room
 * flicker with toys appearing/disappearing; cat count is stable between
 * snapshots of the same activity.)
 */
import { rngFromKey } from '@/shared/lib/prng'
import { ROOM_BOUNDS, type RoomBounds } from '@/entities/cat/wander'

export type ToyKind = 'ball' | 'yarn' | 'mouse' | 'feather'

export const TOY_KINDS: readonly ToyKind[] = ['ball', 'yarn', 'mouse', 'feather']

export const MAX_TOYS = 6

export function toyCountForCats(activeCatCount: number): number {
  return Math.max(0, Math.min(activeCatCount, MAX_TOYS))
}

export interface ToySpec {
  id: string
  kind: ToyKind
  x: number
  y: number
}

/**
 * A deterministic scatter of `count` toys inside `bounds` (room-percent
 * space, see entities/cat/wander.ts), seeded from `seedKey` (the floor id)
 * so the same floor always lays its toys out the same way — stable across
 * re-renders, different from floor to floor.
 */
export function layoutToys(seedKey: string, count: number, bounds: RoomBounds = ROOM_BOUNDS, margin = 14): ToySpec[] {
  const rng = rngFromKey(seedKey)
  const availableW = Math.max(0, bounds.width - margin * 2)
  const availableH = Math.max(0, bounds.height - margin * 2)
  const toys: ToySpec[] = []
  for (let i = 0; i < count; i++) {
    toys.push({
      id: `${seedKey}:toy:${i}`,
      kind: TOY_KINDS[i % TOY_KINDS.length],
      x: margin + rng() * availableW,
      y: margin + rng() * availableH,
    })
  }
  return toys
}
