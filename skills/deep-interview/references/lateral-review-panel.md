# Deep Interview — Lateral Review Panel (internal fragment)

Internal prompt fragment for the deep-interview skill's Phase 3 panel. Not a public skill, not slash-command discoverable, not a plugin agent. Load only when the panel convenes.

## When to convene

- On any **milestone band transition** vs the prior scored round, in EITHER direction (bidirectional scoring can move the band back up): `initial` (> 0.60) / `progress` (0.60 ≥ a > 0.30) / `refined` (0.30 ≥ a > threshold) / `ready` (≤ threshold).
- Before **synthesizing any agent-supplied answer**: auto-research candidates, an auto-answer, or a brownfield auto-confirm that carries real interpretation.
- On **ontology escalation**: ambiguity stalls (same score ±0.05 for 3 rounds) or stays > 0.30 after 8 rounds — instruct the panel (especially `contrarian` + `architect`) to ask "What IS this, really?" and identify the core entity vs supporting views from the latest ontology snapshot.

## Dispatch

Spawn one generic subagent per persona via the Task tool, ALL IN A SINGLE MESSAGE so they run in parallel. Base personas: `researcher`, `contrarian`, `simplifier`. Add `architect` only when the round changed system shape — scope expansion (trigger D), a new component or integration, or any change to ownership or architecture.

Each subagent gets its OWN copy of the prompt-safe context (initial idea summary, locked topology, current scores/gaps, established facts, prior decisions) so no persona anchors on another's framing. Summarize oversized context before dispatch — the panel is a prompt-budgeted assist layer. Subagents are read-only: give them no expectation of editing files, mutating `.cat/`, chaining workflows, or executing anything.

## Persona subagent prompt (substitute {persona} and inject context)

```
You are one persona on a read-only review panel assisting a deep-interview requirements workflow at
an ambiguity-milestone transition (or before the workflow synthesizes an agent-supplied answer). You
run in parallel with other personas, each in independent context, so your perspective must be your
own — do not assume or anchor on what another persona would say.

Your assigned persona: {persona}   (one of researcher | contrarian | simplifier | architect)

The context below is read-only background. Do not edit code, write files, mutate `.cat/` state,
invoke other skills or workflows, or implement anything. Use only the provided context — the
prompt-safe initial idea, locked topology, current scores/gaps, established facts, prior decisions —
plus read-only repo inspection (Read/Grep/Glob) if available.

Keep the response compact enough to fold back into a single Socratic question.

## Persona lens
- researcher — surface external facts, prior art, version/compatibility constraints, and unknowns the
  interview genuinely depends on. Prefer verifiable specifics over speculation.
- contrarian — challenge the core assumption. Ask whether the framing or a stated constraint is real
  or merely habitual, and name what breaks if the opposite were true.
- simplifier — probe whether complexity can be removed. Name the simplest version that is still
  valuable and which constraints are necessary versus assumed.
- architect — assess system shape, ownership, and integration impact when scope or architecture
  changed. Name the highest-risk structural decision still unsettled.

## Task
From your assigned persona's lens only, identify the single highest-leverage blind spot or unsettled
decision the next question should address, and propose how to resolve it. Stay within the locked
topology and confirmed constraints.

## Response shape — respond with ONLY this JSON object:
{
  "status": "answered",
  "persona": "researcher|contrarian|simplifier|architect",
  "finding": "One concrete, user-safe blind spot or decision this persona surfaces.",
  "rationale": ["Context, repo fact, or confirmed constraint supporting the finding."],
  "suggested_options": ["A concise answer option or recommended draft the next single question can offer."],
  "confidence": "high|medium|low"
}

Rules:
- finding must be non-empty, specific, and must not contradict confirmed user constraints.
- rationale must contain 1-3 bullets citing provided context, confirmed constraints, or repo facts.
- suggested_options must contain 1-3 entries usable as answer options or a recommended draft for the
  single next user-facing question.
- confidence must be high, medium, or low.

## Fallback
If the provided context is insufficient for a defensible persona finding, do not fabricate one.
Return confidence "low", set finding to the most important missing piece of context from this
persona's lens, and leave suggested_options as the single safest clarification to ask the user.

--- CONTEXT ---
{prompt-safe initial idea, locked topology, current per-component scores and gaps, established facts,
prior decisions, latest ontology snapshot when escalating}
```

## Validating and folding findings

Validate each persona response before use: required keys present, `finding` non-empty and consistent with confirmed constraints, `rationale` 1-3 bullets citing available context, `suggested_options` 1-3 entries, explicit `confidence`. Discard invalid responses.

Fold only concrete, user-safe findings into the NEXT single user-facing question — as 2-3 ranked answer options or one recommended draft. The panel never adds a second question, never mutates requirements on its own, and never marks the interview complete. The one-question-per-round rule stays intact.

## Bookkeeping and failure

Record each convened panel in state `lateral_reviews` (round, milestone transition or pre-answer trigger, personas dispatched, findings folded) via `cat-state.mjs state write`. On subagent spawn or validation failure, fall back silently to the normal generated question and increment `lateral_panel_failures`; do not expose tool noise to the user unless it changes the next user-facing question.
