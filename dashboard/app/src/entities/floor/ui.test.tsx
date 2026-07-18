import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { FloorRow } from './ui'
import { projectsToFloors } from './model'
import { sessionsToCats } from '@/entities/cat/model'
import type { DialogueEntry, ProjectSnapshot, SessionSnapshot } from '@/shared/api/types'

function entry(overrides: Partial<DialogueEntry>): DialogueEntry {
  return {
    round_trip_id: 'r1',
    role: 'dispatch',
    agent_type: 'cat-harness:executor',
    excerpt: 'x',
    ts: 't1',
    paired: true,
    ...overrides,
  }
}

function session(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    sessionId: 's1',
    lit: true,
    skills: {},
    goals: null,
    ledgerTail: [],
    dialogue: [],
    hasSpecs: false,
    specs: [],
    hasPlans: false,
    plans: { ralplan: [] },
    ...overrides,
  }
}

function renderFloor(sessions: SessionSnapshot[], opts: { lit?: boolean; onDismiss?: () => void } = {}) {
  const project: ProjectSnapshot = { root: '/p', lit: opts.lit ?? true, sessions }
  const floor = projectsToFloors([project])[0]
  render(
    <FloorRow
      floor={floor}
      cats={sessionsToCats(sessions)}
      selected={false}
      selectedCatId={null}
      onSelectFloor={vi.fn()}
      onSelectCat={vi.fn()}
      onDismiss={opts.onDismiss ?? vi.fn()}
    />,
  )
}

describe('FloorRow — active-exchange-only bubbles (declutter)', () => {
  it('shows exactly 2 bubbles (leader dispatch + active-worker reply) for the single freshest completed exchange, none for an older stale worker', () => {
    renderFloor([
      session({
        dialogue: [
          entry({ round_trip_id: 'r1', role: 'dispatch', agent_type: 'cat-harness:planner', excerpt: 'plan it', ts: 't1' }),
          entry({ round_trip_id: 'r1', role: 'reply', agent_type: 'cat-harness:planner', excerpt: 'planned', ts: 't2' }),
          entry({ round_trip_id: 'r2', role: 'dispatch', agent_type: 'cat-harness:executor', excerpt: 'build it', ts: 't3' }),
          entry({ round_trip_id: 'r2', role: 'reply', agent_type: 'cat-harness:executor', excerpt: 'built', ts: 't4' }),
        ],
      }),
    ])

    // Only the freshest (executor) round trip's two lines render — never a
    // pile-up with the older (planner) exchange's own bubble too.
    const bubbles = screen.getAllByTestId('speech-bubble')
    expect(bubbles).toHaveLength(2)
    const bubbleText = bubbles.map((b) => b.textContent).join(' ')
    expect(bubbleText).toContain('build it')
    expect(bubbleText).toContain('built')
    expect(bubbleText).not.toContain('plan it')
    expect(bubbleText).not.toContain('planned')

    // The active worker (executor) sits working; the stale worker (planner)
    // sits sleeping with no bubble of its own.
    expect(screen.getByTestId('cat-s1:agent:executor')).toHaveAttribute('data-sleeping', 'false')
    expect(screen.getByTestId('cat-s1:agent:planner')).toHaveAttribute('data-sleeping', 'true')
  })
})

describe('FloorRow — active-worker selection among the fixed 4 canonical desks', () => {
  it('wakes only the role with the active dialogue; the other 3 canonical roles (including ones with zero dialogue ever) stay asleep', () => {
    renderFloor([
      session({
        dialogue: [entry({ round_trip_id: 'r1', role: 'dispatch', agent_type: 'cat-harness:architect', excerpt: 'design it', ts: 't1', paired: false })],
      }),
    ])

    // All 4 canonical roles are seated regardless of dialogue.
    const cats = screen.getAllByTestId(/^cat-/)
    expect(cats).toHaveLength(4)

    // Only the architect (the one with in-flight dialogue) is awake/typing;
    // planner/critic/executor never had any dialogue at all (placeholder,
    // floor-scoped ids rather than architect's real session-scoped id) yet
    // still each get a (sleeping) desk.
    const byRole = (role: string) => cats.find((c) => c.title?.startsWith(`${role} (`))!
    expect(byRole('architect')).toHaveAttribute('data-sleeping', 'false')
    expect(byRole('planner')).toHaveAttribute('data-sleeping', 'true')
    expect(byRole('critic')).toHaveAttribute('data-sleeping', 'true')
    expect(byRole('executor')).toHaveAttribute('data-sleeping', 'true')

    // The active worker gets its "playing with a toy" prop; it's the only one.
    expect(screen.getAllByTestId('active-worker-toy')).toHaveLength(1)
  })

  it('every canonical role stays asleep (and no active-worker toy renders) when a lit floor has no dialogue at all', () => {
    renderFloor([session({ dialogue: [] })])

    const cats = screen.getAllByTestId(/^cat-/)
    expect(cats).toHaveLength(4)
    for (const cat of cats) {
      expect(cat).toHaveAttribute('data-sleeping', 'true')
    }
    expect(screen.queryByTestId('active-worker-toy')).not.toBeInTheDocument()
  })
})

describe('FloorRow — seated workers are the 4 canonical agent roles, always', () => {
  it('excludes a skill-kind cat from the seated worker set (only agent-role cats get a desk)', () => {
    renderFloor([
      session({
        skills: {
          ultragoal: { skill: 'ultragoal', active: true, current_phase: 'executing', updated_at: null, hud: { nextAction: 'ship it' } },
        },
        dialogue: [entry({ round_trip_id: 'r1', role: 'dispatch', agent_type: 'cat-harness:executor', excerpt: 'go', ts: 't1', paired: false })],
      }),
    ])

    // The skill cat (ultragoal) never gets a seat. All 4 canonical roles are
    // seated (see entities/cat/model.ts's `canonicalAgentCats`) — the
    // dialogue-derived executor plus 3 placeholder (sleeping) desks for the
    // roles with no dialogue.
    expect(screen.queryByTestId('cat-s1:skill:ultragoal')).not.toBeInTheDocument()
    expect(screen.getByTestId('cat-s1:agent:executor')).toBeInTheDocument()
    expect(screen.getAllByTestId(/^cat-/)).toHaveLength(4)
  })

  it('seats all 4 canonical roles (all sleeping) plus the roaming leader when a lit floor has an active skill but zero agent-role dialogue', () => {
    renderFloor([
      session({
        skills: {
          ultragoal: { skill: 'ultragoal', active: true, current_phase: 'executing', updated_at: null, hud: { nextAction: 'ship it' } },
        },
        dialogue: [],
      }),
    ])

    const cats = screen.getAllByTestId(/^cat-/)
    expect(cats).toHaveLength(4)
    for (const cat of cats) {
      expect(cat).toHaveAttribute('data-sleeping', 'true')
    }
    expect(screen.getByTestId('leader-/p:leader')).toBeInTheDocument()
  })
})

describe('FloorRow — "폐업 처리" (close/retire) is DORMANT-only', () => {
  it('shows the dismiss (trash) icon on a dormant floor', () => {
    renderFloor([session({ dialogue: [] })], { lit: false })
    expect(screen.getByTestId('floor-dismiss-/p')).toBeInTheDocument()
  })

  it('never shows the dismiss icon on a lit (actively working) floor', () => {
    renderFloor([session({ dialogue: [] })], { lit: true })
    expect(screen.queryByTestId('floor-dismiss-/p')).not.toBeInTheDocument()
  })

  it('calls onDismiss after the user confirms', () => {
    const onDismiss = vi.fn()
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    renderFloor([session({ dialogue: [] })], { lit: false, onDismiss })

    fireEvent.click(screen.getByTestId('floor-dismiss-/p'))

    expect(confirmSpy).toHaveBeenCalledTimes(1)
    expect(onDismiss).toHaveBeenCalledTimes(1)
    confirmSpy.mockRestore()
  })

  it('does NOT call onDismiss when the user cancels the confirm', () => {
    const onDismiss = vi.fn()
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    renderFloor([session({ dialogue: [] })], { lit: false, onDismiss })

    fireEvent.click(screen.getByTestId('floor-dismiss-/p'))

    expect(confirmSpy).toHaveBeenCalledTimes(1)
    expect(onDismiss).not.toHaveBeenCalled()
    confirmSpy.mockRestore()
  })
})
