import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { OfficeScene } from './OfficeScene'
import { projectsToFloors } from '@/entities/floor/model'
import { translate } from '@/shared/i18n/dictionaries'
import type { ProjectSnapshot } from '@/shared/api/types'

function buildProject(root: string, lit: boolean): ProjectSnapshot {
  return {
    root,
    lit,
    sessions: [
      {
        sessionId: 's-1',
        lit,
        skills: lit
          ? {
              ultragoal: {
                skill: 'ultragoal',
                active: true,
                current_phase: 'executing',
                updated_at: null,
                hud: { nextAction: 'ship it' },
              },
            }
          : {},
        goals: null,
        ledgerTail: [],
        dialogue: lit
          ? [
              {
                round_trip_id: 'rt-1',
                role: 'dispatch',
                agent_type: 'cat-harness:executor',
                excerpt: 'implement the thing',
                ts: '2026-01-01T00:00:00.000Z',
                paired: false,
              },
            ]
          : [],
        hasSpecs: false,
        specs: [],
        hasPlans: false,
        plans: { ralplan: [] },
      },
    ],
  }
}

describe('OfficeScene', () => {
  it('renders one floor per registered project, a cat on the active floor, and a speech bubble', () => {
    const floors = projectsToFloors([buildProject('/projects/alpha', true), buildProject('/projects/beta', false)])
    render(
      <OfficeScene
        floors={floors}
        selectedProjectRoot={null}
        selectedCatId={null}
        onSelectFloor={vi.fn()}
        onSelectCat={vi.fn()}
        onDismissFloor={vi.fn()}
      />,
    )

    const alphaFloor = screen.getByTestId('floor-/projects/alpha')
    const betaFloor = screen.getByTestId('floor-/projects/beta')
    const bubble = screen.getByTestId('speech-bubble')
    expect(alphaFloor).toBeInTheDocument()
    expect(betaFloor).toBeInTheDocument()
    expect(bubble).toHaveTextContent('implement the thing')
    // the lit project has a skill-cat (ultragoal, represented by the roaming
    // leader — not seated) + all 4 canonical agent-role desks (executor from
    // dialogue, plus 3 sleeping placeholders — entities/cat/model.ts's
    // `canonicalAgentCats`); the dormant one has none.
    expect(screen.getAllByTestId(/^cat-/)).toHaveLength(4)

    // regression: the bubble must render clipped WITHIN its own floor's room
    // (entities/floor/ui.tsx's room box is `overflow-hidden`), so it can
    // never bleed into — or read as covering — a neighboring floor.
    expect(alphaFloor.contains(bubble)).toBe(true)
    expect(betaFloor.contains(bubble)).toBe(false)
  })

  it('renders an empty-building message when there are no registered projects', () => {
    render(
      <OfficeScene
        floors={[]}
        selectedProjectRoot={null}
        selectedCatId={null}
        onSelectFloor={vi.fn()}
        onSelectCat={vi.fn()}
        onDismissFloor={vi.fn()}
      />,
    )
    // no wrapping LanguageProvider here -> renders with the default (Korean) i18n context
    expect(screen.getByText(translate('ko', 'office.noProjects'))).toBeInTheDocument()
  })
})
