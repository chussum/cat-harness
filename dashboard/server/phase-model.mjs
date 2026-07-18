/**
 * dashboard/server/phase-model.mjs — READ-ONLY MIRROR of the canonical phase model.
 *
 * This is the THIRD independent copy of these constants (architect finding A5,
 * plan §"Risks and mitigations" item 11), alongside hooks/cat-hook.mjs's and
 * scripts/cat-state.mjs's existing separate copies, and DESIGN.md §3's table —
 * four total sources that must agree. This is a deliberate mirror, not a shared
 * import, matching the codebase's existing duplication style (cat-hook.mjs and
 * cat-state.mjs already each keep their own copy). Drift across all four sources
 * is caught by dashboard/server/phase-parity.test.mjs, which fails loudly and
 * names the divergent source(s) — never silently.
 *
 * Do NOT hand-edit this file without also updating hooks/cat-hook.mjs,
 * scripts/cat-state.mjs, and DESIGN.md §3's canonical phases table.
 */

export const SKILLS = ["deep-interview", "ralplan", "ultragoal", "team"];

export const STOP_RELEASING_PHASES = ["complete", "completed", "failed", "cancelled", "canceled", "inactive"];

export const INITIAL_PHASE = {
  "deep-interview": "interviewing",
  ralplan: "planner",
  ultragoal: "goal-planning",
  team: "starting",
};

// Canonical phase edges per DESIGN.md §3 table (self-loop always allowed; loop-backs
// cover the ralplan revision cycle and ultragoal review cycle; team terminal alts).
export const PHASE_EDGES = {
  "deep-interview": {
    interviewing: ["interviewing", "handoff"],
    handoff: ["handoff", "complete"],
    complete: ["complete"],
  },
  ralplan: {
    planner: ["planner", "review", "revision"],
    review: ["review", "revision", "post-interview"],
    revision: ["revision", "planner", "review"],
    "post-interview": ["post-interview", "adr", "revision"],
    adr: ["adr", "final"],
    final: ["final", "handoff", "revision"],
    handoff: ["handoff", "complete"],
    complete: ["complete"],
  },
  ultragoal: {
    "goal-planning": ["goal-planning", "executing"],
    executing: ["executing", "review", "complete"],
    review: ["review", "executing", "complete"],
    complete: ["complete"],
  },
  team: {
    starting: ["starting", "running", "failed", "cancelled"],
    running: ["running", "complete", "awaiting_integration", "failed", "cancelled"],
    complete: ["complete"],
    awaiting_integration: ["awaiting_integration", "complete", "failed", "cancelled"],
    failed: ["failed"],
    cancelled: ["cancelled"],
  },
};

/** Canonical phase order (chain) per skill, derived from PHASE_EDGES key insertion order. */
export function phaseOrder(skill) {
  const edges = PHASE_EDGES[skill];
  return edges ? Object.keys(edges) : [];
}

/** A run is "lit" (active, non-terminal) if active===true and its phase is not stop-releasing. */
export function isLitPhase(currentPhase) {
  return typeof currentPhase === "string" && !STOP_RELEASING_PHASES.includes(currentPhase);
}
