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
 * Renders a dispatch/reply line's "who -> whom" label. Every exchange is
 * between the generic leader (the orchestrator dispatching subagents — its
 * own identity isn't captured anywhere, only the dispatched subagent_type,
 * so it always renders as the generic leader label, never a made-up name)
 * and a named subagent role: a dispatch is the leader asking that subagent,
 * a reply is that subagent answering the leader.
 */
export function whoToWhomLabel(leaderLabel: string, agentType: string, role: 'dispatch' | 'reply'): string {
  const subagent = displayAgentType(agentType)
  return role === 'dispatch' ? `${leaderLabel} → ${subagent}` : `${subagent} → ${leaderLabel}`
}
