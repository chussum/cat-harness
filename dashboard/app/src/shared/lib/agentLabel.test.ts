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
})
