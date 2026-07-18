import { describe, it, expect } from 'vitest'
import { sessionsToCats, canonicalAgentCats, AGENT_ROLES } from './model'
import type { SessionSnapshot } from '@/shared/api/types'

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

describe('sessionsToCats', () => {
  it('produces one skill-cat per active skill', () => {
    const s = session({
      skills: {
        ultragoal: { skill: 'ultragoal', active: true, current_phase: 'executing', updated_at: null, hud: { nextAction: 'do G002' } },
        team: { skill: 'team', active: false, current_phase: 'complete', updated_at: null, hud: null },
      },
    })
    const cats = sessionsToCats([s])
    expect(cats).toHaveLength(1)
    expect(cats[0]).toMatchObject({ kind: 'skill', label: 'ultragoal', busy: true, nextAction: 'do G002' })
  })

  it('produces a busy agent-cat for the most recent unpaired dispatch', () => {
    const s = session({
      dialogue: [
        { round_trip_id: 'r1', role: 'dispatch', agent_type: 'cat-harness:executor', excerpt: 'go', ts: 't1', paired: true },
        { round_trip_id: 'r1', role: 'reply', agent_type: 'cat-harness:executor', excerpt: 'done', ts: 't2', paired: true },
        { round_trip_id: 'r2', role: 'dispatch', agent_type: 'cat-harness:planner', excerpt: 'plan', ts: 't3', paired: false },
      ],
    })
    const cats = sessionsToCats([s])
    const executor = cats.find((c) => c.label === 'executor')
    const planner = cats.find((c) => c.label === 'planner')
    expect(executor?.busy).toBe(false)
    expect(planner?.busy).toBe(true)
  })

  it('ignores non-namespaced/unknown agent types', () => {
    const s = session({
      dialogue: [{ round_trip_id: 'r1', role: 'dispatch', agent_type: 'general-purpose', excerpt: 'x', ts: 't1', paired: false }],
    })
    expect(sessionsToCats([s])).toEqual([])
  })

  it('dedupes to the most recent entry per agent role', () => {
    const s = session({
      dialogue: [
        { round_trip_id: 'r1', role: 'dispatch', agent_type: 'cat-harness:critic', excerpt: 'a', ts: 't1', paired: false },
        { round_trip_id: 'r2', role: 'dispatch', agent_type: 'cat-harness:critic', excerpt: 'b', ts: 't2', paired: true },
      ],
    })
    const cats = sessionsToCats([s])
    expect(cats).toHaveLength(1)
    expect(cats[0].busy).toBe(false) // the later entry (paired:true dispatch) wins
  })
})

describe('canonicalAgentCats', () => {
  it('always returns exactly the 4 canonical roles, in AGENT_ROLES order, even with zero real agent-cats', () => {
    const cats = canonicalAgentCats([], 'floor-1')
    expect(cats.map((c) => c.label)).toEqual([...AGENT_ROLES])
    expect(cats).toHaveLength(4)
  })

  it('keeps a real (session-scoped) cat for a role that has dialogue, id unchanged', () => {
    const real = { id: 's1:agent:executor', sessionId: 's1', kind: 'agent' as const, label: 'executor', busy: true, phase: null, nextAction: null }
    const cats = canonicalAgentCats([real], 'floor-1')
    const executor = cats.find((c) => c.label === 'executor')
    expect(executor).toEqual(real)
  })

  it('fills a role with no dialogue with a placeholder idle (not busy) cat', () => {
    const cats = canonicalAgentCats([], 'floor-1')
    const planner = cats.find((c) => c.label === 'planner')!
    expect(planner.busy).toBe(false)
    expect(planner.kind).toBe('agent')
    expect(planner.id).toContain('floor-1')
  })

  it('excludes skill-kind cats from role matching (only agent-kind cats fill a role slot)', () => {
    const skillCat = { id: 's1:skill:ultragoal', sessionId: 's1', kind: 'skill' as const, label: 'planner', busy: true, phase: 'x', nextAction: null }
    const cats = canonicalAgentCats([skillCat], 'floor-1')
    const planner = cats.find((c) => c.label === 'planner')!
    // The skill cat happens to share the string "planner" as its label, but
    // being kind:'skill' it must never be mistaken for the planner agent —
    // the slot should still be a placeholder.
    expect(planner.kind).toBe('agent')
    expect(planner.id).not.toBe('s1:skill:ultragoal')
  })

  it('gives every role a distinct id (no accidental collisions between real and placeholder cats)', () => {
    const cats = canonicalAgentCats([], 'floor-1')
    const ids = new Set(cats.map((c) => c.id))
    expect(ids.size).toBe(4)
  })
})
