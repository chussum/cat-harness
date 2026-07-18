/**
 * widgets/side-panel/model.ts — pure derivations of a project's side-panel
 * content: per-session active phases, goals, ledger receipts, and a
 * dispatch/reply dialogue TIMELINE grouped by round_trip_id. No React.
 *
 * The dialogue-grouping helpers themselves live in entities/project/dialogue
 * (an entities-layer, no-React module) because the office-scene room also
 * needs them to decide which cats get a speech bubble; re-exported here so
 * existing imports of this module keep working unchanged.
 */
import type { DialogueEntry, Goal, LedgerEntry, ProjectSnapshot, SkillEntry } from '@/shared/api/types'
import { buildDialogueTimeline, latestDialogueEntry, type TimelineEntry } from '@/entities/project/dialogue'

export { buildDialogueTimeline, latestDialogueEntry, type TimelineEntry }

export interface SessionPanelData {
  sessionId: string
  lit: boolean
  activeSkills: SkillEntry[]
  goals: Goal[]
  ledgerTail: LedgerEntry[]
  /** Raw dialogue (not yet grouped into `timeline`) — the goal-detail view re-filters this by each goal's time window; see ./goalWindow.ts. */
  dialogue: DialogueEntry[]
  timeline: TimelineEntry[]
}

/** One panel block per session in the selected project, in snapshot order. */
export function buildProjectPanelData(project: ProjectSnapshot): SessionPanelData[] {
  return project.sessions.map((session) => ({
    sessionId: session.sessionId,
    lit: session.lit,
    activeSkills: Object.values(session.skills).filter((skill) => skill.active),
    goals: session.goals?.goals ?? [],
    ledgerTail: session.ledgerTail,
    dialogue: session.dialogue,
    timeline: buildDialogueTimeline(session.dialogue),
  }))
}
