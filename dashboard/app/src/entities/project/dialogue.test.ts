import { describe, it, expect } from 'vitest'
import { completedExchangesByAgent, latestPairedExchange, latestSingleExchange } from './dialogue'
import type { DialogueEntry, ProjectSnapshot, SessionSnapshot } from '@/shared/api/types'

function project(sessions: ProjectSnapshot['sessions']): ProjectSnapshot {
  return { root: '/p', lit: true, sessions }
}

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

function session(sessionId: string, dialogue: DialogueEntry[]): SessionSnapshot {
  return {
    sessionId,
    lit: true,
    skills: {},
    goals: null,
    ledgerTail: [],
    dialogue,
    hasSpecs: false,
    specs: [],
    hasPlans: false,
    plans: { ralplan: [] },
  }
}

describe('latestPairedExchange', () => {
  it('returns null when no round trip has both a dispatch and a reply', () => {
    const p = project([
      {
        sessionId: 's1',
        lit: true,
        skills: {},
        goals: null,
        ledgerTail: [],
        dialogue: [entry({ round_trip_id: 'r1', role: 'dispatch' })],
        hasSpecs: false,
        specs: [],
        hasPlans: false,
        plans: { ralplan: [] },
      },
    ])
    expect(latestPairedExchange(p)).toBeNull()
  })

  it('returns the most recently completed round trip, with its session id', () => {
    const p = project([
      {
        sessionId: 's1',
        lit: true,
        skills: {},
        goals: null,
        ledgerTail: [],
        dialogue: [
          entry({ round_trip_id: 'r1', role: 'dispatch', agent_type: 'cat-harness:planner', excerpt: 'plan it', ts: 't1' }),
          entry({ round_trip_id: 'r1', role: 'reply', agent_type: 'cat-harness:planner', excerpt: 'planned', ts: 't2' }),
          entry({ round_trip_id: 'r2', role: 'dispatch', agent_type: 'cat-harness:executor', excerpt: 'build it', ts: 't3' }),
          entry({ round_trip_id: 'r2', role: 'reply', agent_type: 'cat-harness:executor', excerpt: 'built', ts: 't4' }),
        ],
        hasSpecs: false,
        specs: [],
        hasPlans: false,
        plans: { ralplan: [] },
      },
    ])
    const pair = latestPairedExchange(p)
    expect(pair?.sessionId).toBe('s1')
    expect(pair?.dispatch.excerpt).toBe('build it')
    expect(pair?.reply.excerpt).toBe('built')
  })

  it('ignores an in-flight dispatch that has no reply yet, even if it is the newest entry', () => {
    const p = project([
      {
        sessionId: 's1',
        lit: true,
        skills: {},
        goals: null,
        ledgerTail: [],
        dialogue: [
          entry({ round_trip_id: 'r1', role: 'dispatch', ts: 't1' }),
          entry({ round_trip_id: 'r1', role: 'reply', ts: 't2' }),
          entry({ round_trip_id: 'r2', role: 'dispatch', ts: 't3' }), // newest, but unpaired
        ],
        hasSpecs: false,
        specs: [],
        hasPlans: false,
        plans: { ralplan: [] },
      },
    ])
    expect(latestPairedExchange(p)?.dispatch.round_trip_id).toBe('r1')
  })
})

describe('completedExchangesByAgent', () => {
  it('returns one entry per distinct (session, agent_type), freshest reply first', () => {
    const p = project([
      session('s1', [
        entry({ round_trip_id: 'r1', role: 'dispatch', agent_type: 'cat-harness:planner', excerpt: 'plan it', ts: 't1' }),
        entry({ round_trip_id: 'r1', role: 'reply', agent_type: 'cat-harness:planner', excerpt: 'planned', ts: 't2' }),
        entry({ round_trip_id: 'r2', role: 'dispatch', agent_type: 'cat-harness:executor', excerpt: 'build it', ts: 't3' }),
        entry({ round_trip_id: 'r2', role: 'reply', agent_type: 'cat-harness:executor', excerpt: 'built', ts: 't4' }),
      ]),
    ])
    const exchanges = completedExchangesByAgent(p)
    expect(exchanges).toHaveLength(2)
    expect(exchanges[0].dispatch.agent_type).toBe('cat-harness:executor') // t4 > t2, freshest first
    expect(exchanges[1].dispatch.agent_type).toBe('cat-harness:planner')
  })

  it('keeps only the latest completed round trip per agent when the same agent has several', () => {
    const p = project([
      session('s1', [
        entry({ round_trip_id: 'r1', role: 'dispatch', agent_type: 'cat-harness:executor', excerpt: 'first task', ts: 't1' }),
        entry({ round_trip_id: 'r1', role: 'reply', agent_type: 'cat-harness:executor', excerpt: 'first done', ts: 't2' }),
        entry({ round_trip_id: 'r2', role: 'dispatch', agent_type: 'cat-harness:executor', excerpt: 'second task', ts: 't3' }),
        entry({ round_trip_id: 'r2', role: 'reply', agent_type: 'cat-harness:executor', excerpt: 'second done', ts: 't4' }),
      ]),
    ])
    expect(completedExchangesByAgent(p)).toHaveLength(1)
    expect(completedExchangesByAgent(p)[0].reply.excerpt).toBe('second done')
  })

  it('returns [] when nothing has completed', () => {
    const p = project([session('s1', [entry({ round_trip_id: 'r1', role: 'dispatch' })])])
    expect(completedExchangesByAgent(p)).toEqual([])
  })
})

describe('latestSingleExchange', () => {
  it('returns the newest entry across sessions along with its session id', () => {
    const p = project([
      {
        sessionId: 's1',
        lit: true,
        skills: {},
        goals: null,
        ledgerTail: [],
        dialogue: [entry({ ts: 't1', excerpt: 'earlier' })],
        hasSpecs: false,
        specs: [],
        hasPlans: false,
        plans: { ralplan: [] },
      },
      {
        sessionId: 's2',
        lit: true,
        skills: {},
        goals: null,
        ledgerTail: [],
        dialogue: [entry({ ts: 't2', excerpt: 'later' })],
        hasSpecs: false,
        specs: [],
        hasPlans: false,
        plans: { ralplan: [] },
      },
    ])
    const result = latestSingleExchange(p)
    expect(result?.sessionId).toBe('s2')
    expect(result?.entry.excerpt).toBe('later')
  })

  it('returns null for no dialogue anywhere', () => {
    expect(latestSingleExchange(project([]))).toBeNull()
  })
})
