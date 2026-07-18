/**
 * widgets/side-panel/goalWindow.ts — pure helpers for the side panel's
 * goal-scoped detail view (click a goal in the GOALS list to drill in).
 *
 * Two very different reliability levels:
 *  - `ledgerForGoal` is RELIABLE: ledger entries are already goal-tagged
 *    (`goal` on goal_started, `goal_id` on goal_checkpointed/goal_completed —
 *    the field name differs by event type, so check both).
 *  - `goalWindows`/`dialogueInWindow` are APPROXIMATE: dialogue excerpts
 *    carry no goal id at all, so a goal's dialogue is inferred purely from
 *    its time window [goal_started ts, goal_completed ts — or the next
 *    goal's goal_started, or open-ended if still the latest]. The UI must
 *    label this section as time-based/approximate, never as authoritative.
 *
 * No React here.
 */
import type { DialogueEntry, Goal, LedgerEntry } from '@/shared/api/types'

/** The goal id a ledger entry is about, regardless of which field name this event type uses. */
function ledgerGoalId(entry: LedgerEntry): string | undefined {
  return entry.goal ?? entry.goal_id
}

/** Every ledger entry tagged with `goalId` (by either field name), in time order — the reliable "what happened in this goal" log. */
export function ledgerForGoal(ledger: LedgerEntry[], goalId: string): LedgerEntry[] {
  return ledger.filter((entry) => ledgerGoalId(entry) === goalId).sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0))
}

export interface GoalWindow {
  goalId: string
  /** ISO ts of this goal's goal_started event. */
  start: string
  /** ISO ts of this goal's goal_completed event, or the next goal's start, or null if still open-ended (no upper bound yet). */
  end: string | null
}

/**
 * Derives a time window per goal from the ledger tail: start = this goal's
 * `goal_started` ts; end = this goal's `goal_completed` ts, else the next
 * (by start time) goal's `goal_started` ts, else null (open-ended — still
 * the most recent goal to have started, or still running).
 *
 * A goal with no `goal_started` event anywhere in the (tail of the) ledger
 * has no discoverable window and is simply omitted — the ledger is only a
 * tail, so this is expected for older goals, not an error.
 */
export function goalWindows(goals: Goal[], ledger: LedgerEntry[]): GoalWindow[] {
  const starts = new Map<string, string>()
  const completions = new Map<string, string>()
  for (const entry of ledger) {
    const goalId = ledgerGoalId(entry)
    if (!goalId) continue
    if (entry.event === 'goal_started' && !starts.has(goalId)) starts.set(goalId, entry.ts)
    if (entry.event === 'goal_completed' && !completions.has(goalId)) completions.set(goalId, entry.ts)
  }

  const started = goals
    .map((goal) => ({ goalId: goal.id, start: starts.get(goal.id) }))
    .filter((g): g is { goalId: string; start: string } => g.start !== undefined)
    .sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0))

  return started.map((goal, index) => ({
    goalId: goal.goalId,
    start: goal.start,
    end: completions.get(goal.goalId) ?? started[index + 1]?.start ?? null,
  }))
}

/** Dialogue entries whose ts falls within `window` (inclusive) — `end: null` means no upper bound (still open). */
export function dialogueInWindow(dialogue: DialogueEntry[], window: Pick<GoalWindow, 'start' | 'end'>): DialogueEntry[] {
  return dialogue.filter((entry) => entry.ts >= window.start && (window.end === null || entry.ts <= window.end))
}
