/**
 * entities/cat/ui.tsx — PixelCat: a small self-authored pixel-art cat rendered
 * as inline SVG <rect> cells (no external image assets — see dashboard/app/ASSETS.md).
 * Drawn top-down (pointed ears, a face with blush cheeks, and an asymmetric
 * tail) so it reads as a cat wandering a room rather than a static badge.
 * Body color varies by cat kind/role; `busy` cats get a quick in-place
 * scurry, idle cats a slow bob. `facing` flips the sprite only (never its
 * label) to face its current wander direction — see entities/cat/useWander.ts.
 * A `leader` cat (the always-idle manager every lit floor gets — see
 * entities/floor/ui.tsx) additionally wears a small cap so it reads as
 * visually distinct from the subagent cats.
 *
 * `seated` marks a worker cat sitting at its own desk (entities/floor/ui.tsx
 * — every non-leader cat, now stationary rather than wandering): it swaps
 * the wandering busy/idle animations for a subtler in-place "typing" twitch
 * since a seated cat should read as working at its desk, not roaming.
 *
 * `sleeping` is for a seated worker that ISN'T the one the leader is
 * currently delivering to (entities/floor/ui.tsx's `activeWorkerCatId`): its
 * eyes render closed (a thin lid line instead of the open eye dot) and a
 * small floating "Zzz" mark appears above its head, both with a slow
 * breathing bob — so an idle desk clearly reads as a napping cat rather
 * than a working one. `sleeping` always wins over `seated`'s busy/idle
 * typing animation.
 */
import { cn } from '@/shared/lib/cn'
import { useI18n } from '@/shared/i18n/LanguageProvider'
import type { Cat } from './model'

const CELL = 5
// 11 x 9 top-down grid: ' ' transparent, 'B' body, 'E' eye, 'N' nose,
// 'C' cheek blush, 'T' tail. The tail sits back-left in this default pose so
// it trails behind the cat when it's moving right (facing=1); flipping the
// sprite for a leftward move puts it trailing on the right, same idea
// either way.
const CAT_GRID = [
  '   B   B   ',
  '  BBB BBB  ',
  '  BBBBBBB  ',
  ' BBBBBBBBB ',
  ' BBEBBBEBB ',
  ' BBBBNBBBB ',
  ' BCBBBBBCB ',
  '  BBBBBBB  ',
  ' TTTBBB    ',
]

// A small 2-row cap drawn above the head for the leader cat only, same
// width as CAT_GRID so it lines up with the ears beneath it.
const LEADER_HAT_GRID = ['   HHHHH   ', '  HHHHHHH  ']
const HAT_COLOR = '#1e293b'
const HAT_BAND_COLOR = '#facc15'

/** A plain cat sprite's rendered pixel height (no hat). Exported so bubble-placement geometry (entities/cat/wander.ts's `BUBBLE_GAP_PX`) can be verified against the sprite it must clear — see wander.test.ts. */
export const CAT_SPRITE_HEIGHT_PX = CAT_GRID.length * CELL

/** The TALLEST sprite's rendered pixel height: a leader cat, with its cap stacked above the ears. This is the one bubble-placement clearance must cover, since the leader can also carry a speech bubble. */
export const CAT_SPRITE_WITH_HAT_HEIGHT_PX = (CAT_GRID.length + LEADER_HAT_GRID.length) * CELL

const KIND_COLORS: Record<string, string> = {
  'skill:deep-interview': '#f472b6',
  'skill:ralplan': '#60a5fa',
  'skill:ultragoal': '#facc15',
  'skill:team': '#34d399',
  'agent:planner': '#60a5fa',
  'agent:architect': '#a78bfa',
  'agent:critic': '#fb923c',
  'agent:executor': '#34d399',
  'leader:leader': '#e2e8f0',
}

function catColor(cat: Cat): string {
  return KIND_COLORS[`${cat.kind}:${cat.label}`] ?? '#e4e4e7'
}

/** A darker shade of the body color for the tail, so it reads as a separate shape. */
function tailShade(hex: string): string {
  const n = parseInt(hex.slice(1), 16)
  if (Number.isNaN(n)) return hex
  const r = Math.max(0, ((n >> 16) & 0xff) - 40)
  const g = Math.max(0, ((n >> 8) & 0xff) - 40)
  const b = Math.max(0, (n & 0xff) - 40)
  return `rgb(${r}, ${g}, ${b})`
}

export interface PixelCatProps {
  cat: Cat
  selected?: boolean
  onClick?: () => void
  /** 1 = default pose, -1 = mirrored to face the opposite way. Defaults to facing right. */
  facing?: 1 | -1
  /** True for a worker cat sitting at its own desk (see the module doc comment) — NOT wandering, so it gets a subtler in-place animation instead of the roaming busy/idle poses. */
  seated?: boolean
  /** True for a seated worker that's currently napping rather than working (see the module doc comment) — closed eyes, a floating "Zzz," and a slow breathing bob; overrides `seated`'s typing animation. */
  sleeping?: boolean
}

export function PixelCat({ cat, selected, onClick, facing = 1, seated = false, sleeping = false }: PixelCatProps) {
  const { t } = useI18n()
  const isLeader = cat.kind === 'leader'
  const hatRows = isLeader ? LEADER_HAT_GRID.length : 0
  const width = CAT_GRID[0].length * CELL
  const height = (CAT_GRID.length + hatRows) * CELL
  const body = catColor(cat)
  const tail = tailShade(body)
  // The leader's own identity isn't a piece of session data — it's a
  // synthetic UI concept — so (unlike role labels like "planner", which
  // stay untranslated data) its hover label is translated for display; the
  // stable `cat.label` ("leader") is still what keys the color map above.
  const displayLabel = isLeader ? t('dialogue.leader') : cat.label
  const statusLabel = sleeping ? t('cat.resting') : cat.busy ? t('cat.busy') : t('cat.idle')

  return (
    <button
      type="button"
      data-testid={isLeader ? `leader-${cat.id}` : `cat-${cat.id}`}
      data-busy={cat.busy}
      data-sleeping={sleeping}
      onClick={onClick}
      title={`${displayLabel} (${cat.kind}) — ${statusLabel}`}
      className="group relative flex flex-col items-center bg-transparent p-0"
    >
      <span className="inline-block" style={{ transform: `scaleX(${facing})` }}>
        <svg
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label={`pixel cat: ${displayLabel}`}
          className={cn(
            'drop-shadow-md transition-transform',
            sleeping ? 'animate-cat-bob' : seated ? 'animate-cat-type' : cat.busy ? 'animate-cat-scurry' : 'animate-cat-bob',
            selected && 'scale-125',
          )}
        >
          {isLeader &&
            LEADER_HAT_GRID.flatMap((row, y) =>
              [...row].map((char, x) => {
                if (char === ' ') return null
                const fill = y === 0 ? HAT_BAND_COLOR : HAT_COLOR
                return <rect key={`hat-${x}-${y}`} x={x * CELL} y={y * CELL} width={CELL} height={CELL} fill={fill} />
              }),
            )}
          {CAT_GRID.flatMap((row, y) =>
            [...row].map((char, x) => {
              if (char === ' ') return null
              // Sleeping closes the eyes: a thin lid line (a third the cell's
              // height, vertically centered) instead of the normal open-eye
              // square dot, same dark fill either way.
              if (sleeping && char === 'E') {
                return (
                  <rect
                    key={`${x}-${y}`}
                    x={x * CELL}
                    y={(y + hatRows) * CELL + CELL / 3}
                    width={CELL}
                    height={CELL / 3}
                    fill="#111114"
                  />
                )
              }
              const fill =
                char === 'E' ? '#111114' : char === 'N' ? '#f9a8d4' : char === 'C' ? '#fbcfe8' : char === 'T' ? tail : body
              return (
                <rect key={`${x}-${y}`} x={x * CELL} y={(y + hatRows) * CELL} width={CELL} height={CELL} fill={fill} />
              )
            }),
          )}
        </svg>
      </span>
      {sleeping && (
        <span
          aria-hidden
          className="animate-zzz-float pointer-events-none absolute -top-2 right-0 text-[9px] font-bold leading-none text-zinc-200/80"
        >
          Zzz
        </span>
      )}
      <span
        className={cn(
          'mt-0.5 rounded bg-black/60 px-1.5 py-0.5 text-[10px] leading-tight text-zinc-200 opacity-0 group-hover:opacity-100',
          selected && 'opacity-100',
        )}
      >
        {displayLabel}
      </span>
    </button>
  )
}
