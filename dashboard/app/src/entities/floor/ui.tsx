/**
 * entities/floor/ui.tsx — one office floor rendered as a bounded top-down
 * ROOM (ZEP/Gather-style): a tiled floor with a rug + plant + bookshelf +
 * lamp, a leader (manager) cat every lit floor gets, and worker cats — ALL
 * FOUR canonical cat-harness AGENT roles (planner/architect/critic/executor,
 * entities/cat/model.ts's `canonicalAgentCats`), always, on every lit floor,
 * regardless of whether that project's dialogue actually used all of them —
 * that sit STATIONARY at their own desk (entities/floor/deskLayout.ts's
 * deterministic SINGLE-ROW slot, `AGENT_DESK_COLUMNS`/`AGENT_DESK_AREA`,
 * rendered with entities/floor/RoomDecor.tsx's `WorkerDeskProp`) rather than
 * wandering. All 4 sit in ONE shared row (not a multi-row grid) so no
 * worker is ever directly above another — this is what keeps an active
 * worker's speech bubble (which grows into the empty half of the room, away
 * from the row) from ever covering a *different*, sleeping cat. (Skill-kind
 * cats like the driving orchestrator skill are represented by the roaming
 * leader, not a desk, so they're excluded from the worker set.) The leader
 * is the ONLY cat that moves: it ambles calmly when idle, and is pinned to
 * the active worker's desk (`leaderDeliveryTarget`) while that worker has a
 * fresh conversation, so it visibly walks over to "deliver," standing
 * BESIDE it in the same shared row. The active worker sits "working"
 * (typing, eyes open, playing with a toy — see `activeWorkerToyPosition`
 * below); every OTHER seated worker (a canonical role with no/inactive
 * dialogue) sits "sleeping" (closed eyes, a floating Zzz — see
 * entities/cat/ui.tsx's `sleeping` prop), so idle desks read as napping
 * rather than absent or watching a leaderless void. Ambient toy props
 * (separate from the active worker's own toy) scale with how many cats are
 * active. A DORMANT floor's header also gets a small "폐업 처리"
 * (close/retire) trash-can icon (never shown on a lit floor — see
 * `handleDismissClick`) that asks the server to REALLY unregister the
 * project (a real `POST /api/unregister`, dashboard/server/server.mjs); the
 * thin fetch wiring lives in features/floor-unregister — wired in by
 * pages/dashboard/DashboardPage.tsx, not here. The floor then disappears for
 * every connected client via the SSE `removed` event — no client-side
 * hidden-set involved. Self-authored CSS/SVG, no external assets — see
 * dashboard/app/ASSETS.md.
 *
 * Speech bubbles show only the single CURRENT active exchange (declutter —
 * see `conversants`/`catBubbles` below): the dispatch line floats above the
 * leader cat as it delivers, the reply line above the ACTIVE worker cat
 * (`activeWorkerCatId`) it's delivering to — see `renderCatBubble` below.
 * Every other (sleeping) worker has no bubble entry at all, so at most 2
 * bubbles ever show per floor, never a pile-up. Since the leader stands
 * beside the worker in the SAME row (close together, both near the same
 * y), those two bubbles are forced to grow on OPPOSITE sides of the row
 * (`pairedBubbleDirections`) rather than each independently auto-picking a
 * side — same-side would let them overlap EACH OTHER (they're each up to
 * `BUBBLE_MAX_WIDTH_PX`-wide, far wider than the small gap between the two
 * cats), even though each already clears its own cat's face. WHICH one gets
 * which side is fit-aware (the taller excerpt, by `estimateContentHeightPx`,
 * gets whichever side has more room) — see entities/floor/deskLayout.ts's
 * `AGENT_DESK_AREA` for why the row sits dead-center (equal room both
 * ways). A bubble's
 * body and its pointer tail are each rendered as their OWN room-anchored
 * element (siblings of the cat, not nested inside its wander slot): both
 * use a CSS `left: clamp(halfWidthPx, catX%, calc(100% - halfWidthPx))`
 * (entities/cat/wander.ts's `bubbleBodyLeftCss` / `bubbleTailLeftCss`) so
 * the browser resolves the room's *actual* rendered width at layout time —
 * no ResizeObserver/measurement needed — keeping the (wide) body fully
 * clear of the room's left/right wall while the (much narrower) tail stays
 * glued to the cat's exact x. Vertically, a bubble's direction is either
 * forced (the paired leader/worker case above) or, when it renders alone,
 * the usual `bubbleAnchorDirection` pixel math (against the room's fixed,
 * known ROOM_HEIGHT_PX) that keeps it clear of the top/bottom edge. Both
 * share the same `.bubble-slot` CSS transition duration as the cat's own
 * `.cat-wander-slot`, so even as separate elements they glide in lockstep
 * with the cat as it wanders — driven by the same live position, they can
 * never visually drift apart.
 */
import { Fragment, useMemo } from 'react'
import { cn } from '@/shared/lib/cn'
import { Badge } from '@/shared/ui/Badge'
import { useI18n } from '@/shared/i18n/LanguageProvider'
import { PixelCat } from '@/entities/cat/ui'
import { SpeechBubble, SpeechBubbleTail } from '@/entities/cat/SpeechBubble'
import { useWander } from '@/entities/cat/useWander'
import { agentRoleFromAgentType, canonicalAgentCats, AGENT_ROLES } from '@/entities/cat/model'
import {
  BUBBLE_MAX_WIDTH_PX,
  TAIL_OVERLAP_PX,
  bubbleAnchorDirection,
  bubbleBodyLeftCss,
  bubbleMarginPx,
  bubbleTailLeftCss,
  clampBubbleMarginPx,
  estimateContentHeightPx,
  pairedBubbleDirections,
  type BubbleDirection,
  type Point,
} from '@/entities/cat/wander'
import { completedExchangesByAgent, latestSingleExchange, type PairedExchange } from '@/entities/project/dialogue'
import { toyCountForCats, layoutToys } from './toys'
import { Toy } from './Toy'
import {
  deskPositionsForWorkers,
  leaderDeliveryTarget,
  activeWorkerToyPosition,
  AGENT_DESK_AREA,
  AGENT_DESK_COLUMNS,
} from './deskLayout'
import { RoomFloorTiles, RugProp, WorkerDeskProp, PlantProp, BookshelfProp, LampProp } from './RoomDecor'
import type { Floor } from './model'
import type { Cat } from '@/entities/cat/model'
import type { DialogueEntry } from '@/shared/api/types'

const WINDOW_COUNT = 6
/** Exported so tests can verify the room's fixed pixel height against entities/floor/deskLayout.ts's `AGENT_DESK_AREA` row `y` — both the leader's and the active worker's bubbles (see `pairedBubbleDirections`) must always fit within it without clipping. Bumped from 300 to 400 for a more balanced, less cramped top-down room; the desk-row `y`, bubble vertical clamp, and toy positions are all room-percent-based (entities/floor/deskLayout.ts), so they scale with this automatically — no separate constant to update. */
export const ROOM_HEIGHT_PX = 400

export interface FloorRowProps {
  floor: Floor
  cats: Cat[]
  selected: boolean
  selectedCatId: string | null
  onSelectFloor: () => void
  onSelectCat: (catId: string) => void
  /** "폐업 처리" (close/retire) this floor — a REAL server-side unregister, see features/floor-unregister. Only ever invoked from the dormant-only trash icon below, after the user confirms. */
  onDismiss: () => void
}

interface CatBubbleContent {
  dispatch: DialogueEntry | null
  reply: DialogueEntry | null
  /** Stacking lane for the collision guard when 2+ bubbles show on the same floor at once (entities/cat/wander.ts's `bubbleMarginPx`). */
  laneIndex: number
}

function catIdForExchange(exchange: PairedExchange): string | null {
  const role = agentRoleFromAgentType(exchange.dispatch.agent_type)
  return role ? `${exchange.sessionId}:agent:${role}` : null
}

export function FloorRow({ floor, cats, selected, selectedCatId, onSelectFloor, onSelectCat, onDismiss }: FloorRowProps) {
  const { t } = useI18n()

  // A dormant floor can be "폐업 처리"-d (closed/retired for real) — a lit
  // (actively working) floor never gets this affordance, since you can't
  // close an office that's actively working (see the dormant-only trash
  // icon in the header below). A light `window.confirm` — no heavy modal —
  // is enough friction to avoid an accidental click; the actual unregister
  // fetch lives in features/floor-unregister, not here.
  function handleDismissClick() {
    if (window.confirm(t('floor.dismissConfirm', { name: floor.projectName }))) {
      onDismiss()
    }
  }

  // Every lit floor seats ALL FOUR canonical agent roles, always (see
  // entities/cat/model.ts's `canonicalAgentCats`) — a role with no/inactive
  // dialogue gets a placeholder, sleeping desk instead of being absent.
  // Dormant floors get none (no leader, no desks — see the empty-state
  // message below). `cats` also includes skill-kind cats (the driving
  // orchestrator skill, e.g. ultragoal) — those are represented by the
  // roaming LEADER, not a desk worker, so they're excluded from this set,
  // the active-worker pick, and seated/bubble rendering below.
  const workerCats = useMemo(() => (floor.lit ? canonicalAgentCats(cats, floor.id) : []), [cats, floor.lit, floor.id])
  const catIds = useMemo(() => workerCats.map((cat) => cat.id), [workerCats])

  // Every lit floor gets one always-idle "leader" cat (the orchestrator that
  // dispatches subagents — its bubble placement, not a text label, is what
  // shows this: see entities/cat/SpeechBubble.tsx's module doc comment). It
  // is NOT part of `cats` (that list is strictly session-derived
  // skill/agent cats — entities/cat/model.ts), just an ambient manager the
  // worker cats visibly report to.
  const leaderCat = useMemo<Cat | null>(() => {
    if (!floor.lit) return null
    return { id: `${floor.id}:leader`, sessionId: floor.id, kind: 'leader', label: 'leader', busy: false, phase: null, nextAction: null }
  }, [floor.lit, floor.id])

  // The 4 canonical roles' desk slots, in a single tidy row (see
  // entities/floor/deskLayout.ts's `AGENT_DESK_COLUMNS`/`AGENT_DESK_AREA` doc
  // comments for why a single shared row rather than any multi-row grid —
  // it's what keeps a bubble from ever landing on a DIFFERENT cat, and
  // keeps the leader's beside-approach point clear of the next desk over).
  // Keyed by ROLE (not cat id) so the same 4 slots are always in the same
  // spot regardless of which roles happen to have real (session-scoped) ids
  // vs. placeholder ones this render — a fixed, module-stable computation.
  const roleDeskPositions = useMemo(
    () => deskPositionsForWorkers([...AGENT_ROLES], AGENT_DESK_AREA, AGENT_DESK_COLUMNS),
    [],
  )

  // Worker cats (see `workerCats` above) each get their own fixed desk
  // instead of wandering, looked up by their role from `roleDeskPositions`
  // then re-keyed by cat id so the rest of this component (bubble/leader
  // placement, selection) can keep looking desks up by id as before.
  const deskPositions = useMemo(() => {
    const positions: Record<string, Point> = {}
    for (const cat of workerCats) {
      const rolePos = roleDeskPositions[cat.label]
      if (rolePos) positions[cat.id] = rolePos
    }
    return positions
  }, [workerCats, roleDeskPositions])

  // Only the leader cat ever wanders/retargets; workers are stationary at
  // their desk (rendered straight from `deskPositions`, no useWander state).
  const wanderCatIds = useMemo(() => (leaderCat ? [leaderCat.id] : []), [leaderCat])

  // The single CURRENT active exchange (declutter: only one exchange shows a
  // bubble at a time, never a pile-up) — the freshest completed
  // distinct-agent round trip on this floor, or — if nothing has completed
  // yet — the single most recent in-flight dispatch (`fallback` below).
  const conversants = useMemo(() => {
    return completedExchangesByAgent(floor.project)
      .slice(0, 1)
      .map((exchange) => ({ exchange, catId: catIdForExchange(exchange) }))
      .filter((c): c is { exchange: PairedExchange; catId: string } => !!c.catId && catIds.includes(c.catId))
  }, [floor.project, catIds])

  const fallback = useMemo(() => {
    if (conversants.length > 0) return null
    const single = latestSingleExchange(floor.project)
    const role = single ? agentRoleFromAgentType(single.entry.agent_type) : null
    const catId = single && role ? `${single.sessionId}:agent:${role}` : null
    return catId && catIds.includes(catId) ? { entry: single!.entry, catId } : null
  }, [conversants.length, floor.project, catIds])

  // The worker whose desk the leader should walk to right now: the freshest
  // conversation's subagent, or — if nothing has completed yet — the single
  // most recent in-flight dispatch's subagent. Null when nothing is active,
  // in which case the leader just ambles via its own normal wander loop.
  // This same id also decides who's awake: the active worker is shown
  // "working" (see the `seated`/`sleeping` PixelCat props below); every
  // other seated worker naps at its desk instead.
  const activeWorkerCatId = conversants[0]?.catId ?? fallback?.catId ?? null

  const pinnedTargets = useMemo<Record<string, Point>>(() => {
    if (!leaderCat) return {}
    const target = leaderDeliveryTarget(deskPositions, activeWorkerCatId)
    return target ? { [leaderCat.id]: target } : {}
  }, [leaderCat, deskPositions, activeWorkerCatId])

  const wanderState = useWander(wanderCatIds, pinnedTargets)

  const toyCount = toyCountForCats(cats.length)
  const toys = useMemo(() => layoutToys(floor.id, toyCount), [floor.id, toyCount])

  // Per-speaker bubble assignment: which cat (by id) shows which line(s).
  // Only the single active exchange ever gets an entry here — at most 2
  // bubbles per floor (leader's dispatch + the active worker's reply, or one
  // combined bubble on the active worker when there's no leader) — every
  // other seated worker has no entry and so renders no bubble at all (see
  // `renderCatBubble`'s early-return below).
  const catBubbles = useMemo(() => {
    const map = new Map<string, CatBubbleContent>()
    if (conversants.length > 0) {
      const primary = conversants[0]
      if (leaderCat) {
        // Split: the dispatch line is the leader's, the reply line is the subagent's.
        map.set(leaderCat.id, { dispatch: primary.exchange.dispatch, reply: null, laneIndex: 0 })
        map.set(primary.catId, { dispatch: null, reply: primary.exchange.reply, laneIndex: 0 })
      } else {
        map.set(primary.catId, { dispatch: primary.exchange.dispatch, reply: primary.exchange.reply, laneIndex: 0 })
      }
    } else if (fallback) {
      if (leaderCat) {
        if (fallback.entry.role === 'dispatch') {
          map.set(leaderCat.id, { dispatch: fallback.entry, reply: null, laneIndex: 0 })
        } else {
          map.set(fallback.catId, { dispatch: null, reply: fallback.entry, laneIndex: 0 })
        }
      } else {
        map.set(fallback.catId, {
          dispatch: fallback.entry.role === 'dispatch' ? fallback.entry : null,
          reply: fallback.entry.role === 'reply' ? fallback.entry : null,
          laneIndex: 0,
        })
      }
    }
    return map
  }, [conversants, fallback, leaderCat])

  // True exactly when the leader's dispatch bubble and its active worker's
  // reply bubble both render as SEPARATE bubbles at once (`catBubbles` only
  // ever reaches size 2 in that one split-dispatch/reply branch above —
  // every other branch sets at most one entry, either merged onto a single
  // cat or on just the leader/just the worker). Since the leader stands
  // right beside the worker in the same shared row, these two must be
  // forced to opposite sides (`pairedBubbleDirections`) rather than each
  // auto-picking a side — see the module doc comment.
  const pairedBubblesActive = catBubbles.size === 2

  // The fit-aware opposite-side assignment for the paired case above: which
  // of the two (dispatch vs reply) is the taller bubble (by real excerpt
  // length, entities/cat/wander.ts's `estimateContentHeightPx`) decides
  // which side — more room or less — it lands on. Both cats share
  // (approximately) the same y — the worker's own desk position is used
  // here rather than the leader's live wander position, since the worker is
  // always exactly at its desk while the leader may still be mid-transition
  // toward its pinned approach point.
  const pairedDirections = useMemo(() => {
    if (!pairedBubblesActive || !leaderCat || !activeWorkerCatId) return null
    const leaderContent = catBubbles.get(leaderCat.id)
    const workerContent = catBubbles.get(activeWorkerCatId)
    const workerDeskPos = deskPositions[activeWorkerCatId]
    if (!leaderContent || !workerContent || !workerDeskPos) return null
    const catYPx = (workerDeskPos.y / 100) * ROOM_HEIGHT_PX
    const dispatchHeightPx = estimateContentHeightPx(leaderContent.dispatch?.excerpt ?? null, null)
    const replyHeightPx = estimateContentHeightPx(null, workerContent.reply?.excerpt ?? null)
    return pairedBubbleDirections(dispatchHeightPx, replyHeightPx, catYPx, ROOM_HEIGHT_PX)
  }, [pairedBubblesActive, leaderCat, activeWorkerCatId, catBubbles, deskPositions])

  /**
   * Renders a cat's speech bubble (if it has one) as two room-anchored
   * elements: the body (clamped to stay off the left/right wall — see the
   * module doc comment) and the tail (clamped only by its own tiny
   * half-width, so it stays glued to the cat's exact x in every realistic
   * layout). Both recompute from the cat's current position on every
   * render — the leader's live wander position, or a worker's fixed desk
   * position — so they track it if/as it moves. `forcedDirection`, when
   * given, skips the usual per-cat auto-fit (`bubbleAnchorDirection`)
   * entirely — used only for the paired leader/worker case above
   * (`pairedDirections`), where auto-fit would independently pick the SAME
   * side for both; otherwise the side is chosen from the cat's pixel y, the
   * room's actual height, and the bubble's estimated height (now based on
   * the REAL excerpt length via `estimateContentHeightPx`, not just a
   * generic "1 or 2 entries" guess). Either way, the actual cat-to-bubble
   * gap is then run through `clampBubbleMarginPx`, which shrinks it (never
   * below a small floor) if needed to guarantee the box stays fully within
   * the room's top/bottom edge — the real "never clip" guarantee, since a
   * forced direction has no fit check of its own and the height is still
   * only an estimate (a genuinely long excerpt can render taller in
   * practice).
   */
  function renderCatBubble(catId: string, pos: Point, forcedDirection?: BubbleDirection) {
    const content = catBubbles.get(catId)
    if (!content) return null
    const catYPx = (pos.y / 100) * ROOM_HEIGHT_PX
    const bubbleHeightPx = estimateContentHeightPx(content.dispatch?.excerpt ?? null, content.reply?.excerpt ?? null)
    const idealMarginPx = bubbleMarginPx(content.laneIndex)
    // The gap between the cat and the bubble (idealMarginPx) also consumes
    // room space, so it must count toward "does this fit" — otherwise a
    // heavily-stacked lane (a bigger gap) can push an otherwise-fitting
    // bubble just past the room's edge.
    const direction = forcedDirection ?? bubbleAnchorDirection(catYPx, ROOM_HEIGHT_PX, bubbleHeightPx + idealMarginPx)
    const marginPx = clampBubbleMarginPx(catYPx, ROOM_HEIGHT_PX, bubbleHeightPx, direction, idealMarginPx)
    const bodyVerticalPx = direction === 'above' ? ROOM_HEIGHT_PX - catYPx + marginPx : catYPx + marginPx
    const bodyVerticalProp = direction === 'above' ? 'bottom' : 'top'
    const tailVerticalPx = Math.max(0, bodyVerticalPx - TAIL_OVERLAP_PX)

    return (
      <>
        <div
          key={`bubble-body-${catId}`}
          className="bubble-slot pointer-events-none absolute z-20"
          style={{
            // `left` is computed as if this box were the full
            // BUBBLE_MAX_WIDTH_PX wide (conservative — see
            // entities/cat/SpeechBubble.tsx's doc comment), but the box
            // itself now SHRINKS to its content (`max-content`, capped at
            // that same max) so a short excerpt renders as a short, narrow
            // bubble rather than always the full 300px.
            left: bubbleBodyLeftCss(pos.x, BUBBLE_MAX_WIDTH_PX),
            width: 'max-content',
            maxWidth: BUBBLE_MAX_WIDTH_PX,
            [bodyVerticalProp]: `${bodyVerticalPx}px`,
            transform: 'translateX(-50%)',
          }}
        >
          <SpeechBubble dispatch={content.dispatch} reply={content.reply} />
        </div>
        <div
          key={`bubble-tail-${catId}`}
          className="bubble-slot pointer-events-none absolute z-20"
          style={{
            left: bubbleTailLeftCss(pos.x),
            [bodyVerticalProp]: `${tailVerticalPx}px`,
            transform: 'translateX(-50%)',
          }}
        >
          <SpeechBubbleTail pointerSide={direction === 'above' ? 'bottom' : 'top'} />
        </div>
      </>
    )
  }

  const leaderWander = leaderCat ? wanderState[leaderCat.id] : undefined

  return (
    <div
      data-testid={`floor-${floor.id}`}
      className={cn('border-b border-zinc-800 transition-colors', selected && 'ring-1 ring-inset ring-violet-500')}
    >
      <div className="flex items-center gap-4 px-4 pt-3">
        <button
          type="button"
          onClick={onSelectFloor}
          className="flex min-w-40 flex-col items-start gap-1 text-left"
          data-testid={`floor-label-${floor.id}`}
        >
          <span className="text-xs text-zinc-500">{t('floor.label', { n: floor.index + 1 })}</span>
          <span className="truncate text-sm font-semibold text-zinc-100" title={floor.projectRoot}>
            {floor.projectName}
          </span>
          <Badge variant={floor.lit ? 'success' : 'outline'}>{floor.lit ? t('status.lit') : t('status.dormant')}</Badge>
        </button>

        <div className="flex gap-1.5" aria-hidden>
          {Array.from({ length: WINDOW_COUNT }).map((_, i) => (
            <span
              key={i}
              className={cn(
                'h-4 w-3 rounded-[1px] border border-black/40',
                floor.lit ? 'animate-window-flicker bg-amber-300' : 'bg-zinc-800',
              )}
              style={{ animationDelay: `${i * 400}ms` }}
            />
          ))}
        </div>

        {/* "폐업 처리" (close/retire) — DORMANT floors only; you can't close
            an office that's actively working. Self-made inline SVG trash
            can, subtle until hovered. */}
        {!floor.lit && (
          <button
            type="button"
            onClick={handleDismissClick}
            title={t('floor.dismissTooltip')}
            aria-label={t('floor.dismissTooltip')}
            data-testid={`floor-dismiss-${floor.id}`}
            className="ml-auto shrink-0 rounded p-1 text-zinc-600 transition-colors hover:bg-zinc-800 hover:text-red-400"
          >
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
              <path d="M2.5 4.5 H13.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
              <path
                d="M6 4.5 V3.2 a1 1 0 0 1 1-1 h2 a1 1 0 0 1 1 1 V4.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.3"
                strokeLinecap="round"
              />
              <path
                d="M3.6 4.5 L4.2 13 a1 1 0 0 0 1 0.9 h5.6 a1 1 0 0 0 1-0.9 L12.4 4.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.3"
                strokeLinejoin="round"
              />
              <path d="M6.3 6.8 V11.4 M8 6.8 V11.4 M9.7 6.8 V11.4" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
            </svg>
          </button>
        )}
      </div>

      <div
        id={`floor-room-${floor.id}`}
        data-testid={`room-${floor.id}`}
        className="relative mx-4 my-3 overflow-hidden rounded-md border border-zinc-800"
        style={{ height: ROOM_HEIGHT_PX }}
      >
        <RoomFloorTiles lit={floor.lit} />
        <RugProp />
        <PlantProp />
        <BookshelfProp />
        <LampProp />

        {toys.map((toy) => (
          <Toy key={toy.id} toy={toy} title={t('room.toy')} />
        ))}

        {/* The active worker's own toy: sits right beside its desk and
            "plays" (a quicker toy-bat sway — see entities/floor/Toy.tsx's
            `playing` prop) while that worker types, a small "busy
            multitasking" touch distinct from the ambient scattered toys
            above. */}
        {activeWorkerCatId && deskPositions[activeWorkerCatId] && (
          <Toy
            toy={{ id: `${floor.id}:active-toy`, kind: 'mouse', ...activeWorkerToyPosition(deskPositions[activeWorkerCatId]) }}
            title={t('room.toy')}
            playing
          />
        )}

        {workerCats.map((cat) => {
          const deskPos = deskPositions[cat.id]
          if (!deskPos) return null
          return (
            <WorkerDeskProp
              key={`desk-${cat.id}`}
              style={{ left: `${deskPos.x}%`, top: `${deskPos.y}%`, transform: 'translate(-50%, -78%)' }}
            />
          )
        })}

        {leaderCat && leaderWander && (
          <div
            className="cat-wander-slot absolute z-10"
            style={{ left: `${leaderWander.pos.x}%`, top: `${leaderWander.pos.y}%`, transform: 'translate(-50%, -50%)' }}
          >
            <PixelCat cat={leaderCat} facing={leaderWander.facing} />
          </div>
        )}

        {workerCats.map((cat) => {
          const deskPos = deskPositions[cat.id]
          if (!deskPos) return null
          return (
            <div
              key={cat.id}
              className="cat-wander-slot absolute z-10"
              style={{ left: `${deskPos.x}%`, top: `${deskPos.y}%`, transform: 'translate(-50%, -50%)' }}
            >
              <PixelCat
                cat={cat}
                selected={selectedCatId === cat.id}
                onClick={() => onSelectCat(cat.id)}
                seated
                sleeping={cat.id !== activeWorkerCatId}
              />
            </div>
          )
        })}

        {leaderCat && leaderWander && renderCatBubble(leaderCat.id, leaderWander.pos, pairedDirections?.leader)}
        {workerCats.map((cat) => {
          const deskPos = deskPositions[cat.id]
          if (!deskPos) return null
          return (
            <Fragment key={`bubble-wrap-${cat.id}`}>
              {renderCatBubble(cat.id, deskPos, cat.id === activeWorkerCatId ? pairedDirections?.worker : undefined)}
            </Fragment>
          )
        })}

        {/* Only a dormant floor is ever "empty" now — a lit floor always
            seats all 4 canonical roles (see `workerCats` above), even if
            every one of them is sleeping. */}
        {!floor.lit && (
          <span className="pointer-events-none absolute inset-0 flex items-center justify-center text-xs italic text-zinc-600">
            {t('floor.noActiveCats')}
          </span>
        )}
      </div>
    </div>
  )
}
