/**
 * entities/floor/RoomDecor.tsx — self-authored top-down room dressing for a
 * floor's office room: a tiled floor (pure CSS gradient grid, no image), a
 * bordered rug, a desk, a plant, a bookshelf, and a floor lamp. Purely
 * decorative (`aria-hidden`); dims/desaturates when the floor is dormant so
 * a lit room reads as visibly livelier.
 */
import type { CSSProperties } from 'react'
import { cn } from '@/shared/lib/cn'

export function RoomFloorTiles({ lit }: { lit: boolean }) {
  return (
    <div
      aria-hidden
      className={cn('pointer-events-none absolute inset-0 transition-opacity', lit ? 'opacity-100' : 'opacity-50 grayscale')}
      style={{
        backgroundColor: lit ? '#14151f' : '#0c0d12',
        backgroundImage:
          'repeating-linear-gradient(0deg, rgba(255,255,255,0.05) 0px, rgba(255,255,255,0.05) 1px, transparent 1px, transparent 24px), ' +
          'repeating-linear-gradient(90deg, rgba(255,255,255,0.05) 0px, rgba(255,255,255,0.05) 1px, transparent 1px, transparent 24px)',
      }}
    />
  )
}

/** A rounded, bordered rug with a nested inner border for a woven-pattern look. */
export function RugProp() {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute rounded-md border border-amber-900/50 bg-amber-800/20"
      style={{ left: '10%', top: '58%', width: '26%', height: '32%' }}
    >
      <div className="absolute inset-2 rounded border border-amber-700/40" />
      <div className="absolute inset-4 rounded border border-amber-700/25" />
    </div>
  )
}

/**
 * A worker's desk-with-computer: one is rendered per active non-leader cat,
 * positioned by the caller (entities/floor/ui.tsx, via
 * entities/floor/deskLayout.ts's deterministic per-worker slot) rather than
 * at a single fixed spot, so the room can seat 1-4+ workers tidily instead
 * of showing just one ambient desk.
 */
export function WorkerDeskProp({ style }: { style: CSSProperties }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 16"
      className="pointer-events-none absolute drop-shadow-sm"
      style={{ width: 64, height: 44, ...style }}
    >
      <rect x="0" y="6" width="24" height="4" fill="#7c5a3a" />
      <rect x="1" y="10" width="3" height="5" fill="#5b4128" />
      <rect x="20" y="10" width="3" height="5" fill="#5b4128" />
      <rect x="2" y="1" width="7" height="5" fill="#3f4a63" />
      <rect x="3" y="2" width="5" height="3" fill="#60a5fa" opacity="0.6" />
      <rect x="8" y="7.5" width="8" height="1.4" fill="#111114" opacity="0.5" />
    </svg>
  )
}

export function PlantProp() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 16 20"
      className="pointer-events-none absolute drop-shadow-sm"
      style={{ right: '5%', top: '8%', width: 44, height: 55 }}
    >
      <rect x="5" y="14" width="6" height="6" fill="#7c5a3a" />
      <circle cx="8" cy="9" r="7" fill="#2f6d43" />
      <circle cx="4.5" cy="11" r="4" fill="#3a8451" />
      <circle cx="11.5" cy="11" r="4" fill="#3a8451" />
    </svg>
  )
}

/** A small bookshelf with colorful book spines, near the back wall. */
export function BookshelfProp() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 22 16"
      className="pointer-events-none absolute drop-shadow-sm"
      style={{ left: '45%', top: '6%', width: 55, height: 40 }}
    >
      <rect x="0" y="0" width="22" height="16" fill="#4b3521" />
      <rect x="1" y="1" width="20" height="6.5" fill="#2a1d12" />
      <rect x="1" y="8.5" width="20" height="6.5" fill="#2a1d12" />
      <rect x="2" y="2" width="2" height="5" fill="#ef4444" />
      <rect x="4.5" y="2" width="2" height="5" fill="#60a5fa" />
      <rect x="7" y="2" width="2" height="5" fill="#facc15" />
      <rect x="9.5" y="2" width="2" height="5" fill="#34d399" />
      <rect x="2" y="9.5" width="2" height="5" fill="#a78bfa" />
      <rect x="4.5" y="9.5" width="2" height="5" fill="#fb923c" />
      <rect x="7" y="9.5" width="2" height="5" fill="#f472b6" />
    </svg>
  )
}

/** A small standing lamp, tucked near a corner. */
export function LampProp() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 10 22"
      className="pointer-events-none absolute drop-shadow-sm"
      style={{ left: '90%', top: '20%', width: 26, height: 58 }}
    >
      <rect x="4" y="10" width="2" height="12" fill="#5b4128" />
      <rect x="1" y="20" width="8" height="2" fill="#3f2f1f" />
      <path d="M0 10 L10 10 L8 1 L2 1 Z" fill="#fde68a" opacity="0.9" />
    </svg>
  )
}
