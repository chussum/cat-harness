/**
 * widgets/side-panel/SidePanel.tsx — the per-project detail panel: phases,
 * goals, ledger receipts, and the dispatch->reply dialogue timeline. Opens
 * when a floor or a cat is clicked (features/floor-inspect, features/cat-inspect).
 *
 * Clicking a goal in the GOALS list drills into a goal-scoped detail view
 * (GoalDetail below): that goal's ledger events (reliable, goal-tagged) plus
 * dialogue inferred from its time window (approximate — dialogue carries no
 * goal id at all; see ./goalWindow.ts).
 */
import { useMemo, useState } from 'react'
import { Badge } from '@/shared/ui/Badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/shared/ui/Card'
import { projectDisplayName } from '@/entities/project/model'
import { useI18n, type I18nContextValue } from '@/shared/i18n/LanguageProvider'
import { whoToWhomLabel } from '@/shared/lib/agentLabel'
import type { Goal, ProjectSnapshot } from '@/shared/api/types'
import { buildDialogueTimeline, buildProjectPanelData, type SessionPanelData, type TimelineEntry } from './model'
import { dialogueInWindow, goalWindows, ledgerForGoal } from './goalWindow'

export interface SidePanelProps {
  project: ProjectSnapshot | null
  highlightRoundTripId?: string | null
  onClose: () => void
}

/** goal.status is a known enum (complete/active/pending/cancelled) with a translated label; unknown statuses render as-is. */
function goalStatusLabel(t: I18nContextValue['t'], status: string): string {
  const key = `goalStatus.${status}`
  const label = t(key)
  return label === key ? status : label
}

/**
 * One dispatch/reply round trip, labeled both-parties ("Lead -> planner" /
 * "planner -> Lead" — see shared/lib/agentLabel.ts's `whoToWhomLabel`).
 * Shared by the main session timeline and the goal-scoped dialogue view so
 * the who->whom convention can't drift between the two.
 *
 * Unlike the room's speech bubbles (entities/cat/SpeechBubble.tsx), which
 * cap themselves at 3 lines with an ellipsis since they're a passing,
 * decorative "who's talking" cue, the side panel is the one place that
 * shows the COMPLETE excerpt — never truncated. A long unbroken token here
 * (a URL, say) would otherwise overflow the panel's fixed width sideways
 * instead of wrapping, so `overflowWrap: 'anywhere'` + `wordBreak:
 * 'break-word'` force it to wrap within the panel — full text, just
 * wrapped, never truncated and never overflowing.
 */
const WRAP_LONG_TOKENS_STYLE = { overflowWrap: 'anywhere', wordBreak: 'break-word' } as const

function TimelineEntryRow({
  entry,
  highlighted,
  leaderLabel,
}: {
  entry: TimelineEntry
  highlighted: boolean
  leaderLabel: string
}) {
  return (
    <li
      className={'rounded border border-zinc-800 p-2 ' + (highlighted ? 'ring-1 ring-violet-500' : '')}
      data-testid={`timeline-entry-${entry.roundTripId}`}
    >
      {entry.dispatch && (
        <p className="text-zinc-300" style={WRAP_LONG_TOKENS_STYLE}>
          <span className="mr-1 text-zinc-500">{whoToWhomLabel(leaderLabel, entry.dispatch.agent_type, 'dispatch', entry.dispatch.parent_agent_type)}:</span>
          {entry.dispatch.excerpt}
        </p>
      )}
      {entry.reply && (
        <p className="mt-1 text-emerald-300" style={WRAP_LONG_TOKENS_STYLE}>
          <span className="mr-1 text-zinc-500">{whoToWhomLabel(leaderLabel, entry.reply.agent_type, 'reply', entry.reply.parent_agent_type)}:</span>
          {entry.reply.excerpt}
        </p>
      )}
    </li>
  )
}

interface GoalDetailProps {
  session: SessionPanelData
  goal: Goal
  highlightRoundTripId?: string | null
  onBack: () => void
  t: I18nContextValue['t']
}

function GoalDetail({ session, goal, highlightRoundTripId, onBack, t }: GoalDetailProps) {
  const events = useMemo(() => ledgerForGoal(session.ledgerTail, goal.id), [session.ledgerTail, goal.id])
  const window = useMemo(
    () => goalWindows(session.goals, session.ledgerTail).find((w) => w.goalId === goal.id) ?? null,
    [session.goals, session.ledgerTail, goal.id],
  )
  const dialogueTimeline = useMemo(
    () => (window ? buildDialogueTimeline(dialogueInWindow(session.dialogue, window)) : []),
    [window, session.dialogue],
  )

  return (
    <div data-testid={`goal-detail-${goal.id}`}>
      <button
        type="button"
        onClick={onBack}
        data-testid="goal-detail-back"
        className="mb-2 text-xs text-violet-400 hover:underline"
      >
        {t('sidePanel.goalDetail.back')}
      </button>

      <div className="mb-3 flex items-center justify-between gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-zinc-100">
          {goal.id} — {goal.title}
        </span>
        <Badge variant={goal.status === 'complete' ? 'success' : 'outline'} className="shrink-0 whitespace-nowrap">
          {goalStatusLabel(t, goal.status)}
        </Badge>
      </div>

      <section>
        <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-zinc-500">
          {t('sidePanel.goalDetail.eventsTitle')}
        </h3>
        {events.length === 0 && <p className="text-xs text-zinc-600">{t('sidePanel.goalDetail.noEvents')}</p>}
        <ul className="space-y-1 font-mono text-[11px] text-zinc-400">
          {events.map((entry) => (
            <li key={entry.event_id} className="truncate">
              {entry.ts} {entry.event}
            </li>
          ))}
        </ul>
      </section>

      <section className="mt-3">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
          {t('sidePanel.goalDetail.dialogueTitle')}
        </h3>
        <p className="mb-1 text-[10px] italic text-zinc-600">{t('sidePanel.goalDetail.approximateNote')}</p>
        {!window && <p className="text-xs text-zinc-600">{t('sidePanel.goalDetail.noWindow')}</p>}
        {window && dialogueTimeline.length === 0 && (
          <p className="text-xs text-zinc-600">{t('sidePanel.goalDetail.noDialogue')}</p>
        )}
        <ol className="space-y-2" data-testid={`goal-dialogue-${goal.id}`}>
          {dialogueTimeline.map((entry) => (
            <TimelineEntryRow
              key={entry.roundTripId}
              entry={entry}
              highlighted={highlightRoundTripId === entry.roundTripId}
              leaderLabel={t('dialogue.leader')}
            />
          ))}
        </ol>
      </section>
    </div>
  )
}

interface SessionCardProps {
  session: SessionPanelData
  highlightRoundTripId?: string | null
  t: I18nContextValue['t']
}

function SessionCard({ session, highlightRoundTripId, t }: SessionCardProps) {
  const [selectedGoalId, setSelectedGoalId] = useState<string | null>(null)
  const selectedGoal = session.goals.find((goal) => goal.id === selectedGoalId) ?? null

  return (
    <Card data-testid={`panel-session-${session.sessionId}`}>
      <CardHeader className="flex items-center justify-between">
        <CardTitle className="truncate" title={session.sessionId}>
          {t('sidePanel.sessionLabel', { id: session.sessionId.slice(0, 8) })}
        </CardTitle>
        <Badge variant={session.lit ? 'success' : 'outline'}>{session.lit ? t('status.lit') : t('status.dormant')}</Badge>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {selectedGoal ? (
          <GoalDetail
            session={session}
            goal={selectedGoal}
            highlightRoundTripId={highlightRoundTripId}
            onBack={() => setSelectedGoalId(null)}
            t={t}
          />
        ) : (
          <>
            <section>
              <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-zinc-500">{t('sidePanel.phases')}</h3>
              {session.activeSkills.length === 0 && <p className="text-xs text-zinc-600">{t('sidePanel.noActiveSkills')}</p>}
              <ul className="space-y-1">
                {session.activeSkills.map((skill) => (
                  <li key={skill.skill} className="flex items-center justify-between">
                    <span>{skill.skill}</span>
                    <span className="text-xs text-zinc-500">{skill.current_phase}</span>
                  </li>
                ))}
              </ul>
            </section>

            <section>
              <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-zinc-500">{t('sidePanel.goals')}</h3>
              {session.goals.length === 0 && <p className="text-xs text-zinc-600">{t('sidePanel.noGoals')}</p>}
              <ul className="space-y-1">
                {session.goals.map((goal) => (
                  <li key={goal.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedGoalId(goal.id)}
                      data-testid={`goal-${goal.id}`}
                      className="flex w-full items-center justify-between gap-2 rounded px-1 py-0.5 text-left hover:bg-zinc-800"
                    >
                      {/* `min-w-0` is required alongside `flex-1 truncate` here: a
                          flex item's default min-width is `auto` (its content's
                          natural width), which overrides `truncate`'s
                          `overflow:hidden` and lets a long title push/squish the
                          Badge sibling instead of ellipsizing — see
                          entities/floor's similar truncate+flex patterns. */}
                      <span className="min-w-0 flex-1 truncate">
                        {goal.id} — {goal.title}
                      </span>
                      <Badge variant={goal.status === 'complete' ? 'success' : 'outline'} className="shrink-0 whitespace-nowrap">
                        {goalStatusLabel(t, goal.status)}
                      </Badge>
                    </button>
                  </li>
                ))}
              </ul>
            </section>

            <section>
              <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-zinc-500">{t('sidePanel.receipts')}</h3>
              {session.ledgerTail.length === 0 && <p className="text-xs text-zinc-600">{t('sidePanel.noLedger')}</p>}
              <ul className="space-y-1 font-mono text-[11px] text-zinc-400">
                {session.ledgerTail.map((entry) => (
                  <li key={entry.event_id} className="truncate">
                    {entry.ts} {entry.event} {entry.goal ?? entry.goal_id ?? ''}
                  </li>
                ))}
              </ul>
            </section>

            <section>
              <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-zinc-500">
                {t('sidePanel.dialogueTimeline')}
              </h3>
              {session.timeline.length === 0 && <p className="text-xs text-zinc-600">{t('sidePanel.noDialogue')}</p>}
              <ol className="space-y-2" data-testid={`timeline-${session.sessionId}`}>
                {session.timeline.map((entry) => (
                  <TimelineEntryRow
                    key={entry.roundTripId}
                    entry={entry}
                    highlighted={highlightRoundTripId === entry.roundTripId}
                    leaderLabel={t('dialogue.leader')}
                  />
                ))}
              </ol>
            </section>
          </>
        )}
      </CardContent>
    </Card>
  )
}

export function SidePanel({ project, highlightRoundTripId, onClose }: SidePanelProps) {
  const { t } = useI18n()

  if (!project) {
    return (
      <aside className="w-80 shrink-0 border-l border-zinc-800 p-4 text-sm text-zinc-500" data-testid="side-panel-empty">
        {t('sidePanel.emptyPrompt')}
      </aside>
    )
  }

  const sessions = buildProjectPanelData(project)

  return (
    <aside className="w-96 shrink-0 overflow-y-auto border-l border-zinc-800 bg-zinc-950" data-testid="side-panel">
      <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
        <div>
          <p className="text-xs text-zinc-500">{t('sidePanel.projectLabel')}</p>
          <h2 className="text-base font-semibold text-zinc-100">{projectDisplayName(project.root)}</h2>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('sidePanel.closeAria')}
          className="rounded px-2 py-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
        >
          ×
        </button>
      </div>

      <div className="space-y-4 p-4">
        {sessions.length === 0 && <p className="text-xs text-zinc-500">{t('sidePanel.noSessions')}</p>}
        {sessions.map((session) => (
          <SessionCard key={session.sessionId} session={session} highlightRoundTripId={highlightRoundTripId} t={t} />
        ))}
      </div>
    </aside>
  )
}
