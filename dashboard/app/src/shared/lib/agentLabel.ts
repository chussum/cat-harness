/**
 * shared/lib/agentLabel.ts — presentation-only helpers for agent_type values
 * (e.g. "cat-harness:executor"). Strips a leading `cat-harness:` namespace
 * so speech bubbles and the dialogue timeline show just the role
 * (planner/architect/critic/executor). The raw agent_type is never mutated —
 * only the rendered label changes.
 */
const CAT_HARNESS_PREFIX = 'cat-harness:'

export function displayAgentType(agentType: string): string {
  return agentType.startsWith(CAT_HARNESS_PREFIX) ? agentType.slice(CAT_HARNESS_PREFIX.length) : agentType
}

/**
 * Renders a dispatch/reply line's "who -> whom" label between the dispatching
 * party and a named subagent role: a dispatch is the dispatcher asking that
 * subagent, a reply is that subagent answering the dispatcher.
 *
 * The dispatcher is the generic leader by default — the top-level orchestrator,
 * whose own identity isn't captured anywhere (only the dispatched subagent_type
 * is), so it renders as the generic leader label, never a made-up name.
 *
 * Feature B (nested dispatch): when `parentAgentType` is present, the dispatcher
 * was itself a subagent (e.g. an executor that dispatched a critic), so it names
 * that parent role instead — `executor → critic` / `critic → executor` rather
 * than `Lead → critic`. Absent/empty parent falls back to the leader label.
 */
export function whoToWhomLabel(
  leaderLabel: string,
  agentType: string,
  role: 'dispatch' | 'reply',
  parentAgentType?: string | null,
): string {
  const subagent = displayAgentType(agentType)
  const dispatcher = parentAgentType ? displayAgentType(parentAgentType) : leaderLabel
  return role === 'dispatch' ? `${dispatcher} → ${subagent}` : `${subagent} → ${dispatcher}`
}
