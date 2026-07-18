import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { SidePanel } from './SidePanel'
import type { ProjectSnapshot } from '@/shared/api/types'

describe('SidePanel', () => {
  it('shows a placeholder when no project is selected', () => {
    render(<SidePanel project={null} onClose={vi.fn()} />)
    expect(screen.getByTestId('side-panel-empty')).toBeInTheDocument()
  })

  it('renders goals, phases, receipts, and a paired dialogue timeline entry for the selected project', () => {
    const project: ProjectSnapshot = {
      root: '/projects/alpha',
      lit: true,
      sessions: [
        {
          sessionId: 'session-one',
          lit: true,
          skills: {
            ultragoal: { skill: 'ultragoal', active: true, current_phase: 'executing', updated_at: null, hud: null },
          },
          goals: { version: 1, goals: [{ id: 'G001', title: 'ship the dashboard', status: 'active' }] },
          ledgerTail: [{ event: 'goal_started', event_id: 'e1', ts: '2026-01-01T00:00:00.000Z', goal: 'G001' }],
          dialogue: [
            { round_trip_id: 'rt-1', role: 'dispatch', agent_type: 'cat-harness:executor', excerpt: 'build it', ts: 't1', paired: true },
            { round_trip_id: 'rt-1', role: 'reply', agent_type: 'cat-harness:executor', excerpt: 'built it', ts: 't2', paired: true },
          ],
          hasSpecs: false,
          specs: [],
          hasPlans: false,
          plans: { ralplan: [] },
        },
      ],
    }

    render(<SidePanel project={project} onClose={vi.fn()} />)

    expect(screen.getByText('alpha')).toBeInTheDocument()
    expect(screen.getByText('ultragoal')).toBeInTheDocument()
    expect(screen.getByText(/G001 — ship the dashboard/)).toBeInTheDocument()
    expect(screen.getByTestId('timeline-entry-rt-1')).toHaveTextContent('build it')
    expect(screen.getByTestId('timeline-entry-rt-1')).toHaveTextContent('built it')
  })

  it('drills into a goal-scoped view on click, scoping ledger events and dialogue to that goal, then returns via back', () => {
    const project: ProjectSnapshot = {
      root: '/projects/alpha',
      lit: true,
      sessions: [
        {
          sessionId: 'session-one',
          lit: true,
          skills: {},
          goals: {
            version: 1,
            goals: [
              { id: 'G001', title: 'ship the dashboard', status: 'complete' },
              { id: 'G002', title: 'add dark mode', status: 'active' },
            ],
          },
          ledgerTail: [
            { event: 'goal_started', event_id: 'e1', ts: '2026-01-01T00:00:00.000Z', goal: 'G001' },
            { event: 'goal_completed', event_id: 'e2', ts: '2026-01-01T01:00:00.000Z', goal_id: 'G001' },
            { event: 'goal_started', event_id: 'e3', ts: '2026-01-01T01:00:00.000Z', goal: 'G002' },
          ],
          dialogue: [
            {
              round_trip_id: 'rt-1',
              role: 'dispatch',
              agent_type: 'cat-harness:executor',
              excerpt: 'g001 dispatch',
              ts: '2026-01-01T00:30:00.000Z',
              paired: true,
            },
            {
              round_trip_id: 'rt-1',
              role: 'reply',
              agent_type: 'cat-harness:executor',
              excerpt: 'g001 reply',
              ts: '2026-01-01T00:45:00.000Z',
              paired: true,
            },
            {
              round_trip_id: 'rt-2',
              role: 'dispatch',
              agent_type: 'cat-harness:planner',
              excerpt: 'g002 dispatch',
              ts: '2026-01-01T01:30:00.000Z',
              paired: false,
            },
          ],
          hasSpecs: false,
          specs: [],
          hasPlans: false,
          plans: { ralplan: [] },
        },
      ],
    }

    render(<SidePanel project={project} onClose={vi.fn()} />)

    fireEvent.click(screen.getByTestId('goal-G001'))

    const detail = screen.getByTestId('goal-detail-G001')
    expect(detail).toHaveTextContent('ship the dashboard')
    // reliable ledger section: only G001's events, not G002's
    expect(detail).toHaveTextContent('goal_started')
    expect(detail).toHaveTextContent('goal_completed')
    expect(detail).not.toHaveTextContent('G002')
    // approximate dialogue section: only the round trip inside G001's [00:00, 01:00] window
    expect(screen.getByTestId('timeline-entry-rt-1')).toHaveTextContent('g001 dispatch')
    expect(screen.queryByTestId('timeline-entry-rt-2')).not.toBeInTheDocument()
    // the full-session view (phases/receipts/other goal) is hidden while a goal is drilled into
    expect(screen.queryByTestId('goal-G002')).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId('goal-detail-back'))

    // back to the full view: both goals listed again, detail view gone
    expect(screen.getByTestId('goal-G001')).toBeInTheDocument()
    expect(screen.getByTestId('goal-G002')).toBeInTheDocument()
    expect(screen.queryByTestId('goal-detail-G001')).not.toBeInTheDocument()
  })

  it('gives a long goal title truncation (min-w-0 + flex-1 + truncate) and the status badge nowrap+shrink-0, so a long title can never squish/wrap the badge', () => {
    const project: ProjectSnapshot = {
      root: '/projects/alpha',
      lit: true,
      sessions: [
        {
          sessionId: 'session-one',
          lit: true,
          skills: {},
          goals: {
            version: 1,
            goals: [
              {
                id: 'G005',
                title: 'A very long goal title that should truncate with an ellipsis instead of wrapping or squishing the status badge next to it',
                status: 'active',
              },
            ],
          },
          ledgerTail: [],
          dialogue: [],
          hasSpecs: false,
          specs: [],
          hasPlans: false,
          plans: { ralplan: [] },
        },
      ],
    }

    render(<SidePanel project={project} onClose={vi.fn()} />)

    const goalButton = screen.getByTestId('goal-G005')
    const title = goalButton.querySelector('span')!
    expect(title.className).toContain('truncate')
    expect(title.className).toContain('min-w-0')
    expect(title.className).toContain('flex-1')

    const badge = screen.getByText('진행 중')
    expect(badge.className).toContain('shrink-0')
    expect(badge.className).toContain('whitespace-nowrap')

    // drill into the goal-detail header, which shows the same title+badge shape
    fireEvent.click(goalButton)
    const detail = screen.getByTestId('goal-detail-G005')
    const detailBadge = detail.querySelector('span.shrink-0')
    expect(detailBadge).not.toBeNull()
    expect(detailBadge!.className).toContain('whitespace-nowrap')
  })

  it('wraps a long unbroken token (a URL) in the dialogue timeline instead of overflowing the panel, and keeps the FULL text (no truncation)', () => {
    const longUrl = 'https://internal.example.com/incident/2026-07-18-billing-timeout-root-cause-analysis-and-remediation-plan'
    const project: ProjectSnapshot = {
      root: '/projects/alpha',
      lit: true,
      sessions: [
        {
          sessionId: 'session-one',
          lit: true,
          skills: {},
          goals: null,
          ledgerTail: [],
          dialogue: [
            {
              round_trip_id: 'rt-url',
              role: 'dispatch',
              agent_type: 'cat-harness:architect',
              excerpt: `check this out: ${longUrl} thanks`,
              ts: 't1',
              paired: false,
            },
          ],
          hasSpecs: false,
          specs: [],
          hasPlans: false,
          plans: { ralplan: [] },
        },
      ],
    }

    render(<SidePanel project={project} onClose={vi.fn()} />)

    const entry = screen.getByTestId('timeline-entry-rt-url')
    // full, untruncated text (unlike the room bubble's shrink-to-fit box, the panel never truncates)
    expect(entry).toHaveTextContent(longUrl)
    const excerptParagraph = entry.querySelector('p')!
    expect(excerptParagraph.style.overflowWrap).toBe('anywhere')
    expect(excerptParagraph.style.wordBreak).toBe('break-word')
  })
})
