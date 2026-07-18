import { describe, it, expect } from 'vitest'
import { displayAgentType, whoToWhomLabel } from './agentLabel'

describe('displayAgentType', () => {
  it('strips a leading cat-harness: prefix', () => {
    expect(displayAgentType('cat-harness:executor')).toBe('executor')
  })

  it('leaves agent types without the prefix untouched', () => {
    expect(displayAgentType('planner')).toBe('planner')
  })

  it('only strips a leading occurrence of the prefix, not one appearing mid-string', () => {
    expect(displayAgentType('sub:cat-harness:executor')).toBe('sub:cat-harness:executor')
  })
})

describe('whoToWhomLabel', () => {
  it('renders a dispatch as leader -> subagent', () => {
    expect(whoToWhomLabel('Lead', 'cat-harness:planner', 'dispatch')).toBe('Lead → planner')
  })

  it('renders a reply as subagent -> leader', () => {
    expect(whoToWhomLabel('Lead', 'cat-harness:planner', 'reply')).toBe('planner → Lead')
  })

  it('uses the given leader label verbatim (e.g. Korean)', () => {
    expect(whoToWhomLabel('리더', 'cat-harness:executor', 'dispatch')).toBe('리더 → executor')
    expect(whoToWhomLabel('리더', 'cat-harness:executor', 'reply')).toBe('executor → 리더')
  })

  it('still strips the cat-harness: prefix from the subagent side', () => {
    expect(whoToWhomLabel('Lead', 'critic', 'reply')).toBe('critic → Lead')
  })

  it('Feature B: with a parent, names the parent role instead of the leader (dispatch)', () => {
    expect(whoToWhomLabel('Lead', 'cat-harness:critic', 'dispatch', 'cat-harness:executor')).toBe('executor → critic')
  })

  it('Feature B: with a parent, names the parent role instead of the leader (reply)', () => {
    expect(whoToWhomLabel('Lead', 'cat-harness:critic', 'reply', 'cat-harness:executor')).toBe('critic → executor')
  })

  it('Feature B: a null/undefined parent falls back to the leader label (top-level dispatch unchanged)', () => {
    expect(whoToWhomLabel('Lead', 'cat-harness:planner', 'dispatch', null)).toBe('Lead → planner')
    expect(whoToWhomLabel('Lead', 'cat-harness:planner', 'dispatch', undefined)).toBe('Lead → planner')
  })
})
