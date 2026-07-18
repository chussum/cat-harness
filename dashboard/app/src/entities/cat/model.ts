/**
 * entities/cat — maps active skills/agents onto pixel cats that move around a
 * floor. Two cat "kinds":
 *   - `skill`  one per session skill-state file with active:true (the
 *     driving cat-harness skill for that session — deep-interview/ralplan/
 *     ultragoal/team).
 *   - `agent`  one per distinct sub-agent role seen in that session's recent
 *     dialogue excerpts (planner/architect/critic/executor, from
 *     `agent_type` values like `cat-harness:executor`) — `busy` while its
 *     most recent dialogue entry is an unpaired dispatch (still working),
 *     idle once a reply has landed.
 * Pure snapshot -> cat-list mapping, no React.
 */
import type { SessionSnapshot } from '@/shared/api/types'

export const AGENT_ROLES = ['planner', 'architect', 'critic', 'executor'] as const
export type AgentRole = (typeof AGENT_ROLES)[number]

export interface Cat {
  id: string
  sessionId: string
  /**
   * `skill`/`agent` are session-derived (see below). `leader` is NOT
   * produced by `sessionsToCats` — it's a synthetic, always-idle manager cat
   * entities/floor/ui.tsx adds per lit floor (the orchestrator that dispatches
   * subagents; see entities/cat/SpeechBubble.tsx's who->whom labeling).
   */
  kind: 'skill' | 'agent' | 'leader'
  label: string
  busy: boolean
  phase: string | null
  nextAction: string | null
}

/** Maps a raw agent_type (e.g. "cat-harness:executor") to its role, or null if it's not a known sub-agent role. */
export function agentRoleFromAgentType(agentType: string): AgentRole | null {
  const suffix = agentType.split(':').pop() ?? agentType
  return (AGENT_ROLES as readonly string[]).includes(suffix) ? (suffix as AgentRole) : null
}

/** One cat per active skill in this session. */
function skillCats(session: SessionSnapshot): Cat[] {
  const cats: Cat[] = []
  for (const [skillName, entry] of Object.entries(session.skills)) {
    if (!entry.active) continue
    cats.push({
      id: `${session.sessionId}:skill:${skillName}`,
      sessionId: session.sessionId,
      kind: 'skill',
      label: skillName,
      busy: true,
      phase: entry.current_phase,
      nextAction: entry.hud?.nextAction ?? null,
    })
  }
  return cats
}

/** One cat per distinct sub-agent role seen in the session's dialogue tail (most recent wins). */
function agentCats(session: SessionSnapshot): Cat[] {
  const cats: Cat[] = []
  const seen = new Set<AgentRole>()
  for (let i = session.dialogue.length - 1; i >= 0; i--) {
    const entry = session.dialogue[i]
    const role = agentRoleFromAgentType(entry.agent_type)
    if (!role || seen.has(role)) continue
    seen.add(role)
    cats.push({
      id: `${session.sessionId}:agent:${role}`,
      sessionId: session.sessionId,
      kind: 'agent',
      label: role,
      busy: entry.role === 'dispatch' && entry.paired === false,
      phase: null,
      nextAction: null,
    })
  }
  return cats
}

export function sessionsToCats(sessions: SessionSnapshot[]): Cat[] {
  return sessions.flatMap((session) => [...skillCats(session), ...agentCats(session)])
}

/** A same-shaped, always-idle stand-in Cat for a canonical role with no real dialogue on this floor yet — see `canonicalAgentCats` below. */
function placeholderAgentCat(floorId: string, role: AgentRole): Cat {
  return {
    id: `${floorId}:agent:${role}:idle`,
    sessionId: floorId,
    kind: 'agent',
    label: role,
    busy: false,
    phase: null,
    nextAction: null,
  }
}

/**
 * Every lit floor seats ALL FOUR canonical agent roles
 * (planner/architect/critic/executor), not just whichever ones a project's
 * dialogue happened to use — so a project that only ever dispatched an
 * executor still shows a planner/architect/critic desk too (napping,
 * `sleeping`, rather than absent — entities/floor/ui.tsx). For a role with
 * real dialogue, its real session-scoped Cat is kept as-is (same id as
 * `catIdForExchange` would produce, so active-exchange matching still
 * works, and its `busy` reflects the real dispatch/reply state); a role
 * with no dialogue yet gets a `placeholderAgentCat` instead. `cats` may
 * include multiple sessions' cats for the same role (a multi-session
 * project) — the first one encountered wins, same "most recent tail wins"
 * bias `agentCats` already uses per-session.
 */
export function canonicalAgentCats(cats: Cat[], floorId: string): Cat[] {
  const byRole = new Map<AgentRole, Cat>()
  for (const cat of cats) {
    if (cat.kind !== 'agent') continue
    const role = cat.label as AgentRole
    if (!byRole.has(role)) byRole.set(role, cat)
  }
  return AGENT_ROLES.map((role) => byRole.get(role) ?? placeholderAgentCat(floorId, role))
}
