import { describe, it, expect } from 'vitest'
import { buildDialogueTimeline, buildProjectPanelData, latestDialogueEntry } from './model'
import type { DialogueEntry, ProjectSnapshot } from '@/shared/api/types'

describe('buildDialogueTimeline', () => {
  it('pairs a dispatch and reply sharing a round_trip_id', () => {
    const dialogue: DialogueEntry[] = [
      { round_trip_id: 'r1', role: 'dispatch', agent_type: 'cat-harness:executor', excerpt: 'do it', ts: 't1', paired: true },
      { round_trip_id: 'r1', role: 'reply', agent_type: 'cat-harness:executor', excerpt: 'done', ts: 't2', paired: true },
    ]
    const timeline = buildDialogueTimeline(dialogue)
    expect(timeline).toHaveLength(1)
    expect(timeline[0].dispatch?.excerpt).toBe('do it')
    expect(timeline[0].reply?.excerpt).toBe('done')
  })

  it('keeps first-seen order across multiple round trips', () => {
    const dialogue: DialogueEntry[] = [
      { round_trip_id: 'r2', role: 'reply', agent_type: 'cat-harness:executor', excerpt: 'unpaired', ts: 't1', paired: false },
      { round_trip_id: 'r1', role: 'dispatch', agent_type: 'cat-harness:planner', excerpt: 'plan', ts: 't2', paired: false },
    ]
    const timeline = buildDialogueTimeline(dialogue)
    expect(timeline.map((t) => t.roundTripId)).toEqual(['r2', 'r1'])
    expect(timeline[0].dispatch).toBeNull()
    expect(timeline[1].reply).toBeNull()
  })

  it('returns [] for no dialogue', () => {
    expect(buildDialogueTimeline([])).toEqual([])
  })
})

describe('buildProjectPanelData', () => {
  it('derives per-session active skills, goals, ledger, and timeline', () => {
    const project: ProjectSnapshot = {
      root: '/p',
      lit: true,
      sessions: [
        {
          sessionId: 's1',
          lit: true,
          skills: {
            ultragoal: { skill: 'ultragoal', active: true, current_phase: 'executing', updated_at: null, hud: null },
            team: { skill: 'team', active: false, current_phase: 'complete', updated_at: null, hud: null },
          },
          goals: { version: 1, goals: [{ id: 'G001', title: 't', status: 'active' }] },
          ledgerTail: [{ event: 'goal_started', event_id: 'e1', ts: 't1' }],
          dialogue: [],
          hasSpecs: false,
          specs: [],
          hasPlans: false,
          plans: { ralplan: [] },
        },
      ],
    }
    const [panel] = buildProjectPanelData(project)
    expect(panel.activeSkills).toHaveLength(1)
    expect(panel.activeSkills[0].skill).toBe('ultragoal')
    expect(panel.goals).toEqual([{ id: 'G001', title: 't', status: 'active' }])
    expect(panel.ledgerTail).toHaveLength(1)
    expect(panel.timeline).toEqual([])
  })
})

describe('latestDialogueEntry', () => {
  it('returns the entry with the greatest ts across all sessions', () => {
    const project: ProjectSnapshot = {
      root: '/p',
      lit: true,
      sessions: [
        {
          sessionId: 's1',
          lit: true,
          skills: {},
          goals: null,
          ledgerTail: [],
          dialogue: [
            { round_trip_id: 'r1', role: 'dispatch', agent_type: 'cat-harness:executor', excerpt: 'earlier', ts: '2026-01-01T00:00:00.000Z', paired: true },
            { round_trip_id: 'r1', role: 'reply', agent_type: 'cat-harness:executor', excerpt: 'later', ts: '2026-01-01T00:05:00.000Z', paired: true },
          ],
          hasSpecs: false,
          specs: [],
          hasPlans: false,
          plans: { ralplan: [] },
        },
      ],
    }
    expect(latestDialogueEntry(project)?.excerpt).toBe('later')
  })

  it('returns null when there is no dialogue anywhere', () => {
    const project: ProjectSnapshot = { root: '/p', lit: false, sessions: [] }
    expect(latestDialogueEntry(project)).toBeNull()
  })
})
