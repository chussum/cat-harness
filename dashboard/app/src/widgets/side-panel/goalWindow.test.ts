import { describe, it, expect } from 'vitest'
import { ledgerForGoal, goalWindows, dialogueInWindow } from './goalWindow'
import type { DialogueEntry, Goal, LedgerEntry } from '@/shared/api/types'

function ledgerEntry(overrides: Partial<LedgerEntry>): LedgerEntry {
  return { event: 'goal_started', event_id: 'e', ts: 't0', ...overrides }
}

function dialogueEntry(overrides: Partial<DialogueEntry>): DialogueEntry {
  return { round_trip_id: 'r', role: 'dispatch', agent_type: 'cat-harness:executor', excerpt: 'x', ts: 't0', paired: true, ...overrides }
}

describe('ledgerForGoal', () => {
  it('matches goal_started entries via the `goal` field', () => {
    const ledger = [ledgerEntry({ event: 'goal_started', goal: 'G001', ts: 't1' })]
    expect(ledgerForGoal(ledger, 'G001')).toHaveLength(1)
  })

  it('matches goal_checkpointed/goal_completed entries via the `goal_id` field', () => {
    const ledger = [
      ledgerEntry({ event: 'goal_checkpointed', goal_id: 'G001', ts: 't2' }),
      ledgerEntry({ event: 'goal_completed', goal_id: 'G001', ts: 't3' }),
    ]
    expect(ledgerForGoal(ledger, 'G001')).toHaveLength(2)
  })

  it('excludes entries for other goals and goal-less entries (e.g. plan_created)', () => {
    const ledger = [
      ledgerEntry({ event: 'goal_started', goal: 'G001', ts: 't1' }),
      ledgerEntry({ event: 'goal_started', goal: 'G002', ts: 't2' }),
      ledgerEntry({ event: 'plan_created', ts: 't0' }),
    ]
    expect(ledgerForGoal(ledger, 'G001').map((e) => e.event)).toEqual(['goal_started'])
  })

  it('returns entries in time order regardless of ledger order', () => {
    const ledger = [
      ledgerEntry({ event: 'goal_completed', goal_id: 'G001', ts: 't3' }),
      ledgerEntry({ event: 'goal_started', goal: 'G001', ts: 't1' }),
      ledgerEntry({ event: 'goal_checkpointed', goal_id: 'G001', ts: 't2' }),
    ]
    expect(ledgerForGoal(ledger, 'G001').map((e) => e.ts)).toEqual(['t1', 't2', 't3'])
  })

  it('returns [] when the goal has no events in the (tail of the) ledger', () => {
    expect(ledgerForGoal([ledgerEntry({ event: 'goal_started', goal: 'G999', ts: 't1' })], 'G001')).toEqual([])
  })
})

describe('goalWindows', () => {
  const goals: Goal[] = [
    { id: 'G001', title: 'first', status: 'complete' },
    { id: 'G002', title: 'second', status: 'complete' },
    { id: 'G003', title: 'third', status: 'active' },
  ]

  it('uses the goal_completed ts as the end when the goal explicitly completed', () => {
    const ledger = [
      ledgerEntry({ event: 'goal_started', goal: 'G001', ts: 't1' }),
      ledgerEntry({ event: 'goal_completed', goal_id: 'G001', ts: 't2' }),
    ]
    expect(goalWindows(goals, ledger)).toEqual([{ goalId: 'G001', start: 't1', end: 't2' }])
  })

  it('falls back to the next goal\'s start when this goal has no completed event', () => {
    const ledger = [
      ledgerEntry({ event: 'goal_started', goal: 'G001', ts: 't1' }),
      ledgerEntry({ event: 'goal_started', goal: 'G002', ts: 't2' }),
    ]
    expect(goalWindows(goals, ledger)).toEqual([
      { goalId: 'G001', start: 't1', end: 't2' },
      { goalId: 'G002', start: 't2', end: null },
    ])
  })

  it('leaves the latest-started goal open-ended (end: null) when there is no next goal or completion', () => {
    const ledger = [ledgerEntry({ event: 'goal_started', goal: 'G003', ts: 't5' })]
    expect(goalWindows(goals, ledger)).toEqual([{ goalId: 'G003', start: 't5', end: null }])
  })

  it('skips a goal with no goal_started event anywhere in the ledger tail', () => {
    // G002 never started in this tail (e.g. it happened before the tail's retention window)
    const ledger = [
      ledgerEntry({ event: 'goal_started', goal: 'G001', ts: 't1' }),
      ledgerEntry({ event: 'goal_completed', goal_id: 'G001', ts: 't2' }),
      ledgerEntry({ event: 'goal_checkpointed', goal_id: 'G002', ts: 't3' }), // only a checkpoint, no start
    ]
    const windows = goalWindows(goals, ledger)
    expect(windows.map((w) => w.goalId)).toEqual(['G001'])
  })

  it('orders windows chronologically by start even if goals/ledger are out of order', () => {
    const ledger = [
      ledgerEntry({ event: 'goal_started', goal: 'G002', ts: 't5' }),
      ledgerEntry({ event: 'goal_started', goal: 'G001', ts: 't1' }),
    ]
    expect(goalWindows(goals, ledger).map((w) => w.goalId)).toEqual(['G001', 'G002'])
  })

  it('returns [] for an empty ledger', () => {
    expect(goalWindows(goals, [])).toEqual([])
  })
})

describe('dialogueInWindow', () => {
  it('includes entries at the exact start and end boundaries (inclusive)', () => {
    const dialogue = [dialogueEntry({ ts: 't1', excerpt: 'at start' }), dialogueEntry({ ts: 't2', excerpt: 'at end' })]
    const result = dialogueInWindow(dialogue, { start: 't1', end: 't2' })
    expect(result.map((e) => e.excerpt)).toEqual(['at start', 'at end'])
  })

  it('excludes entries outside the window', () => {
    const dialogue = [
      dialogueEntry({ ts: 't0', excerpt: 'before' }),
      dialogueEntry({ ts: 't1.5', excerpt: 'inside' }),
      dialogueEntry({ ts: 't3', excerpt: 'after' }),
    ]
    expect(dialogueInWindow(dialogue, { start: 't1', end: 't2' }).map((e) => e.excerpt)).toEqual(['inside'])
  })

  it('has no upper bound when end is null (still-open goal)', () => {
    const dialogue = [dialogueEntry({ ts: 't1' }), dialogueEntry({ ts: 't999' })]
    expect(dialogueInWindow(dialogue, { start: 't1', end: null })).toHaveLength(2)
  })

  it('returns [] when nothing falls in the window', () => {
    expect(dialogueInWindow([dialogueEntry({ ts: 't0' })], { start: 't5', end: 't9' })).toEqual([])
  })
})
