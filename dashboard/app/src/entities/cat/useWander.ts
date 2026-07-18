/**
 * entities/cat/useWander.ts — drives each cat's position inside its room
 * with a cheap, gentle random walk: pick a random target, let CSS
 * transitions animate the drift, pause, repeat. No requestAnimationFrame
 * loop — one retarget timer per cat.
 *
 * Respects `prefers-reduced-motion`: cats still get an initial position but
 * never retarget, so the scene reads as static instead of drifting.
 *
 * Pure math lives in ./wander.ts (tested there); this hook is the thin
 * React/timer wiring on top and is intentionally not unit-tested.
 */
import { useEffect, useRef, useState } from 'react'
import { facingFromDelta, pickWanderTarget, ROOM_BOUNDS, type Point } from './wander'

export interface WanderState {
  pos: Point
  facing: 1 | -1
}

const MARGIN = 12
// Slow, calm ambling rather than darting: a longer pause between moves (see
// also the longer .cat-wander-slot CSS transition in index.css, which is
// what actually stretches out each glide).
const RETARGET_MIN_MS = 5200
const RETARGET_MAX_MS = 9000

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
}

/**
 * @param catIds stable ids of the cats currently in this room
 * @param pinnedTargets optional per-cat override target (in room-percent),
 *   e.g. from entities/cat/wander.ts's `conversationTargets` for a
 *   dispatch/reply pair drifting toward each other. Applied immediately
 *   whenever the pinned value for a given cat id changes.
 */
export function useWander(catIds: string[], pinnedTargets: Record<string, Point> = {}): Record<string, WanderState> {
  const [state, setState] = useState<Record<string, WanderState>>({})
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({})
  const catIdsKey = catIds.join(',')
  const pinnedKey = Object.entries(pinnedTargets)
    .map(([id, p]) => `${id}:${p.x.toFixed(1)},${p.y.toFixed(1)}`)
    .sort()
    .join('|')

  // Reconcile cats entering/leaving the room.
  useEffect(() => {
    setState((prev) => {
      const next: Record<string, WanderState> = {}
      for (const id of catIds) {
        next[id] = prev[id] ?? { pos: pickWanderTarget(ROOM_BOUNDS, MARGIN), facing: 1 }
      }
      return next
    })
    for (const id of Object.keys(timers.current)) {
      if (!catIds.includes(id)) {
        clearTimeout(timers.current[id])
        delete timers.current[id]
      }
    }
  }, [catIdsKey])

  // Independent retarget loop per cat (skipped entirely under reduced motion).
  useEffect(() => {
    if (prefersReducedMotion()) return
    let cancelled = false

    catIds.forEach((id) => {
      if (timers.current[id]) return
      const schedule = () => {
        const delay = RETARGET_MIN_MS + Math.random() * (RETARGET_MAX_MS - RETARGET_MIN_MS)
        timers.current[id] = setTimeout(() => {
          if (cancelled) return
          setState((prev) => {
            const current = prev[id]
            if (!current) return prev
            const target = pickWanderTarget(ROOM_BOUNDS, MARGIN)
            const facing = facingFromDelta(target.x - current.pos.x, current.facing)
            return { ...prev, [id]: { pos: target, facing } }
          })
          schedule()
        }, delay)
      }
      schedule()
    })

    return () => {
      cancelled = true
    }
  }, [catIdsKey])

  useEffect(
    () => () => {
      Object.values(timers.current).forEach(clearTimeout)
      timers.current = {}
    },
    [],
  )

  // Apply pinned "converse" targets (e.g. a dispatch/reply pair drifting
  // toward each other) the moment they appear/change, on top of the
  // independent wander loop above.
  useEffect(() => {
    if (Object.keys(pinnedTargets).length === 0) return
    setState((prev) => {
      let changed = false
      const next = { ...prev }
      for (const [id, target] of Object.entries(pinnedTargets)) {
        const current = prev[id]
        if (!current) continue
        changed = true
        next[id] = { pos: target, facing: facingFromDelta(target.x - current.pos.x, current.facing) }
      }
      return changed ? next : prev
    })
  }, [pinnedKey])

  return state
}
