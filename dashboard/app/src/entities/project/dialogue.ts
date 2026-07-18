/**
 * entities/project/dialogue.ts — pure derivations over a project's dialogue
 * history: grouping dispatch/reply rows into round trips, and finding the
 * single most recent entry or the most recent *complete* (dispatch+reply)
 * exchange. Used by the side panel's dialogue timeline and by the office
 * scene's room to decide which cats should show a speech bubble / drift
 * toward each other to "converse". No React.
 */
import type { DialogueEntry, ProjectSnapshot } from '@/shared/api/types'

export interface TimelineEntry {
  roundTripId: string
  dispatch: DialogueEntry | null
  reply: DialogueEntry | null
}

/**
 * Groups dialogue rows by round_trip_id in first-seen order. A round trip may
 * have only a reply (paired:false — dispatch queue was empty when it landed)
 * or, mid-flight, only a dispatch (reply not yet observed).
 */
export function buildDialogueTimeline(dialogue: DialogueEntry[]): TimelineEntry[] {
  const byId = new Map<string, TimelineEntry>()
  const order: string[] = []
  for (const entry of dialogue) {
    let bucket = byId.get(entry.round_trip_id)
    if (!bucket) {
      bucket = { roundTripId: entry.round_trip_id, dispatch: null, reply: null }
      byId.set(entry.round_trip_id, bucket)
      order.push(entry.round_trip_id)
    }
    if (entry.role === 'dispatch') bucket.dispatch = entry
    else bucket.reply = entry
  }
  return order.map((id) => byId.get(id)!)
}

export interface SingleExchange {
  sessionId: string
  entry: DialogueEntry
}

/** The single most recent dialogue entry across a project's sessions, with the session it came from. */
export function latestSingleExchange(project: ProjectSnapshot): SingleExchange | null {
  let best: SingleExchange | null = null
  for (const session of project.sessions) {
    for (const entry of session.dialogue) {
      if (!best || entry.ts > best.entry.ts) best = { sessionId: session.sessionId, entry }
    }
  }
  return best
}

/** Most recent dialogue entry across a project's sessions (for the scene's speech bubble). */
export function latestDialogueEntry(project: ProjectSnapshot): DialogueEntry | null {
  return latestSingleExchange(project)?.entry ?? null
}

export interface PairedExchange {
  sessionId: string
  dispatch: DialogueEntry
  reply: DialogueEntry
}

/**
 * Every distinct (session, agent_type)'s most recently *completed* round
 * trip (dispatch.agent_type === reply.agent_type — a round trip is one
 * sub-agent's own dispatch -> reply lifecycle, not two different agents
 * talking; see ASSETS.md / entities/cat/model.ts), sorted freshest-first by
 * the reply's timestamp.
 *
 * The office-scene room uses the top of this list to decide which agent-cat
 * (or two, if a floor has more than one with fresh news) currently has
 * something to say and should show a speech bubble.
 */
export function completedExchangesByAgent(project: ProjectSnapshot): PairedExchange[] {
  const bySessionAndAgent = new Map<string, PairedExchange>()
  for (const session of project.sessions) {
    for (const entry of buildDialogueTimeline(session.dialogue)) {
      if (!entry.dispatch || !entry.reply) continue
      const key = `${session.sessionId}:${entry.dispatch.agent_type}`
      const existing = bySessionAndAgent.get(key)
      if (!existing || entry.reply.ts > existing.reply.ts) {
        bySessionAndAgent.set(key, { sessionId: session.sessionId, dispatch: entry.dispatch, reply: entry.reply })
      }
    }
  }
  return [...bySessionAndAgent.values()].sort((a, b) => (a.reply.ts < b.reply.ts ? 1 : a.reply.ts > b.reply.ts ? -1 : 0))
}

/**
 * The single most recent *complete* round trip across a project's sessions.
 * Returns null if no round trip is complete yet (e.g. only in-flight
 * dispatches so far). A thin convenience wrapper over
 * `completedExchangesByAgent` for callers that only care about the top one.
 */
export function latestPairedExchange(project: ProjectSnapshot): PairedExchange | null {
  return completedExchangesByAgent(project)[0] ?? null
}
