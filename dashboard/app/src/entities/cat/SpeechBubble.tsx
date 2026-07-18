/**
 * entities/cat/SpeechBubble.tsx — a cat's speech bubble: a dispatch line's
 * excerpt, then, once it lands, a reply line's excerpt underneath. Unlike
 * the side panel's dialogue timeline (widgets/side-panel/SidePanel.tsx),
 * this bubble does NOT prefix each line with a who->whom label ("Lead →
 * planner: ..." / "planner → Lead: ...") — in the room, the bubble's own
 * placement already says who's speaking (entities/floor/ui.tsx renders the
 * dispatch bubble above the LEADER cat and the reply bubble above/below the
 * ACTIVE WORKER cat, each with its pointer tail glued to that exact cat), so
 * a text label would just repeat what the pointer already shows. The side
 * panel has no cats to point at, so it keeps the label (see
 * `shared/lib/agentLabel.ts`'s `whoToWhomLabel`, still used there). A round
 * trip is one agent's own dispatch -> reply lifecycle
 * (dispatch.agent_type === reply.agent_type), so both lines belong to the
 * same cat — see entities/project/dialogue.ts.
 *
 * Lives at the entities layer (not widgets) so entities/floor's room can
 * render it without an entities -> widgets layering violation.
 *
 * This is just the bubble's content box. The pointer tail is a SEPARATE
 * component (`SpeechBubbleTail`, below) rather than nested inside this box:
 * entities/floor/ui.tsx positions the box and the tail as independent
 * room-anchored elements (each with its own CSS `clamp()` — see
 * entities/cat/wander.ts's `bubbleBodyLeftCss`/`bubbleTailLeftCss`) so the
 * box can shift to stay clear of the room's left/right wall while the tail
 * keeps tracking the cat's exact position — nesting the tail inside the box
 * would tie its position to the box's own (possibly-shifted) coordinate
 * space instead.
 */
import { cn } from '@/shared/lib/cn'
import { BUBBLE_MAX_WIDTH_PX } from './wander'
import type { DialogueEntry } from '@/shared/api/types'

export interface SpeechBubbleProps {
  dispatch: DialogueEntry | null
  reply: DialogueEntry | null
}

/**
 * `maxWidth` reads `BUBBLE_MAX_WIDTH_PX` directly (rather than a hardcoded
 * Tailwind "max width" utility class, 320px, used previously) so this box's
 * real width can never drift out of sync with the same constant entities/floor/ui.tsx uses
 * for its positioning math (the wrapper div's own `width`, the horizontal
 * clamp helpers' half-width, etc.) — one number, one source of truth.
 * `width: 'max-content'` makes the box SHRINK to fit its actual text — a
 * short excerpt gets a short, narrow bubble instead of always rendering at
 * the full 300px — while `maxWidth` still caps it there once the content
 * would otherwise be wider, at which point it wraps instead of growing
 * further (the positioning math in entities/floor/ui.tsx stays computed on
 * the 300px MAX regardless — conservative, since an actually-narrower box
 * centered at that same safe point only has MORE clearance from the room's
 * walls, never less). `overflowWrap: 'anywhere'` + `wordBreak: 'break-word'`
 * make sure even a single very long unbroken token (e.g. a URL in an
 * excerpt) wraps inside that width instead of overflowing it; normal
 * multi-word text already wraps at word boundaries by default and grows the
 * box downward (into the room's tall vertical clearance — see
 * entities/floor/ui.tsx's `ROOM_HEIGHT_PX`) rather than overflowing
 * sideways. The FULL excerpt always renders — no truncation/ellipsis here;
 * that's a deliberate choice (unlike a max-line clamp) so the room bubble
 * never hides part of what was actually said. entities/floor/ui.tsx's
 * fit-aware side assignment (`pairedBubbleDirections`) plus
 * `clampBubbleMarginPx`'s position safety net are what keep even a long,
 * multi-line excerpt from ever clipping the room's edge instead.
 */
export function SpeechBubble({ dispatch, reply }: SpeechBubbleProps) {
  return (
    <div
      data-testid="speech-bubble"
      className="animate-bubble-in rounded-lg border border-zinc-700 bg-zinc-100 px-3 py-2 text-xs text-zinc-900 shadow-lg"
      style={{ width: 'max-content', maxWidth: BUBBLE_MAX_WIDTH_PX, overflowWrap: 'anywhere', wordBreak: 'break-word' }}
    >
      {dispatch && <p className="text-zinc-600">{dispatch.excerpt}</p>}
      {reply && <p className={cn('text-emerald-700', dispatch && 'mt-1')}>{reply.excerpt}</p>}
    </div>
  )
}

export interface SpeechBubbleTailProps {
  /** Which edge this tail is drawn on: 'bottom' when the bubble box sits above its cat (tail points down), 'top' when the box was flipped below instead (tail points up). */
  pointerSide: 'top' | 'bottom'
}

/** The little pointer triangle, positioned independently of the bubble box by the caller (entities/floor/ui.tsx) so it can stay anchored to the cat's exact x even if the box itself shifted to clamp within the room. */
export function SpeechBubbleTail({ pointerSide }: SpeechBubbleTailProps) {
  return (
    <span
      data-testid="speech-bubble-tail"
      className={cn(
        'block h-3 w-3 bg-zinc-100',
        pointerSide === 'bottom' ? 'border-b border-r border-zinc-700' : 'border-l border-t border-zinc-700',
      )}
      style={{ transform: 'rotate(45deg)' }}
    />
  )
}
