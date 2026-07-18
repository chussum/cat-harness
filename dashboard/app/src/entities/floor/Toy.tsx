/**
 * entities/floor/Toy.tsx — a small pixel toy prop (ball / yarn-ball / mouse
 * toy / feather) scattered around a room, self-authored inline SVG. Purely
 * decorative; how many appear and where is decided in ./toys.ts.
 *
 * `playing` marks the ONE toy placed beside the active (typing) worker's
 * desk (entities/floor/ui.tsx, positioned via
 * entities/floor/deskLayout.ts's `activeWorkerToyPosition`) — it swaps the
 * ambient `toy-sway` drift for a quicker `toy-bat` paw-swat motion so it
 * reads as the busy cat multitasking with the toy while it works, rather
 * than the toy just idly swaying like the other scattered ones.
 */
import { cn } from '@/shared/lib/cn'
import type { ToySpec } from './toys'

const TOY_COLORS: Record<ToySpec['kind'], string> = {
  ball: '#f87171',
  yarn: '#facc15',
  mouse: '#a1a1aa',
  feather: '#38bdf8',
}

export interface ToyProps {
  toy: ToySpec
  title: string
  /** True for the active worker's "playing with a toy while it works" prop — see the module doc comment. */
  playing?: boolean
}

export function Toy({ toy, title, playing = false }: ToyProps) {
  const color = TOY_COLORS[toy.kind]
  return (
    <div
      className={cn('pointer-events-none absolute', playing ? 'animate-toy-bat' : 'animate-toy-sway')}
      style={{ left: `${toy.x}%`, top: `${toy.y}%`, transform: 'translate(-50%, -50%)' }}
      title={title}
      data-testid={playing ? 'active-worker-toy' : undefined}
      aria-hidden
    >
      {toy.kind === 'ball' && (
        <svg viewBox="0 0 10 10" width="11" height="11">
          <circle cx="5" cy="5" r="4.5" fill={color} />
          <path d="M5 0.5 A4.5 4.5 0 0 1 5 9.5" stroke="#00000030" strokeWidth="1" fill="none" />
        </svg>
      )}
      {toy.kind === 'yarn' && (
        <svg viewBox="0 0 10 10" width="11" height="11">
          <circle cx="5" cy="5" r="4.5" fill={color} />
          <path d="M1 5 Q5 1 9 5 Q5 9 1 5" stroke="#00000035" strokeWidth="0.8" fill="none" />
          <path d="M5 0.5 Q3 5 5 9.5" stroke="#00000035" strokeWidth="0.6" fill="none" />
        </svg>
      )}
      {toy.kind === 'mouse' && (
        <svg viewBox="0 0 12 8" width="13" height="9">
          <ellipse cx="6" cy="5" rx="5" ry="3" fill={color} />
          <path d="M11 5 Q13 3 12 1" stroke={color} strokeWidth="1" fill="none" />
          <circle cx="2.5" cy="3.5" r="0.6" fill="#111114" />
        </svg>
      )}
      {toy.kind === 'feather' && (
        <svg viewBox="0 0 6 14" width="8" height="16">
          <path d="M3 0 L5 5 L3 10 L1 5 Z" fill={color} />
          <line x1="3" y1="0" x2="3" y2="13" stroke="#78716c" strokeWidth="0.8" />
        </svg>
      )}
    </div>
  )
}
