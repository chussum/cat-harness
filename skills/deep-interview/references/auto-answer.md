# Deep Interview — Auto-Research & Auto-Answer (internal fragment)

Internal prompt fragments for machine-answerable moments in the deep-interview loop. Not public skills, not slash-command discoverable, not plugin agents. Two modes, each dispatched as ONE read-only generic subagent via the Task tool with a prompt-budgeted copy of interview context (never the raw oversized transcript):

- **Auto-Research** (Step 2a — before asking): a greenfield question is research-shaped — best practice, technology choice, prior art, external facts. Runs BEFORE the AskUserQuestion call; validated candidates become answer options for the single user-facing question. It never replaces the question or adds a second one.
- **Auto-Answer** (Step 2b′ — after asking): the user opted out of the current question, answered with uncertainty, or explicitly asked the agent to decide. Produces one tentative answer carried into scoring.

Both subagents are read-only: no code edits, no file writes, no `.cat/` mutation, no workflow chaining, no execution delegation.

## Auto-Research subagent prompt

```
You are a read-only researcher helping a deep-interview requirements workflow evaluate one greenfield
question tagged for research. The context below is read-only background. Do not edit code, write
files, mutate `.cat/` state, invoke workflows, or implement anything. Use only the provided context —
the tagged question, prior interview decisions, topology/ontology notes, confirmed constraints — plus
read-only repo/web inspection if available.

Keep the response compact enough to fit back into the parent interview prompt.

## Task
Return 2-3 ranked candidate answers for the tagged question. Candidates must be concrete, mutually
distinct, consistent with confirmed constraints, and useful as answer options or context for the next
single Socratic question.

## Response shape — respond with ONLY this JSON object:
{
  "status": "answered",
  "candidates": [
    {
      "rank": 1,
      "answer": "Concise candidate answer.",
      "rationale": "Why this candidate fits the provided context and confirmed constraints.",
      "risks_or_tradeoffs": "Main risk, tradeoff, or caveat for this candidate.",
      "confidence": "high|medium|low"
    }
  ],
  "recommendation": "One sentence naming the strongest candidate and why it should be offered first.",
  "follow_up_gap": "One sentence naming the remaining uncertainty the user should still confirm."
}

Rules:
- candidates must contain 2 or 3 entries when context supports that many.
- rank starts at 1 and increases by 1.
- confidence must be high, medium, or low.
- Every rationale must cite provided context, confirmed constraints, or repo facts.

## Fallback
If the provided context is insufficient to produce at least two meaningful candidates, say so
explicitly in follow_up_gap, return the best single defensible candidate only if one exists, mark
confidence low, and name the missing context. Do not fabricate certainty.

--- CONTEXT ---
{tagged question, locked topology summary, prompt-safe initial idea, trimmed prior decisions/gaps,
relevant confirmed constraints}
```

**On valid response:** incorporate the candidates as 2-3 concise answer options (or context) for the single user-facing AskUserQuestion, append the round number to `auto_researched_rounds`, and keep the one-question-per-round rule intact. **On invalid/failed response:** fall back silently to the normally generated question and increment `architect_failures`.

## Auto-Answer subagent prompt

```
You are a read-only architect helping a deep-interview requirements workflow resolve one question
after the user opted out, answered with uncertainty, or explicitly asked the agent to decide. The
context below is read-only background. Do not edit code, write files, mutate `.cat/` state, invoke
workflows, or implement anything. Use only the provided context — the opted-out question, prior
interview decisions, topology/ontology notes, confirmed constraints — plus read-only repo/context
inspection if available.

Keep the response compact enough to fit into ambiguity scoring.

## Task
Provide one decisive answer the parent workflow can tentatively carry forward. Choose the most
conservative answer that preserves user intent, avoids irreversible assumptions, and keeps the
interview moving.

## Response shape — respond with ONLY this JSON object:
{
  "status": "answered",
  "answer": "One concise decisive answer phrased as the assumption the interview should carry.",
  "rationale": ["Context or repo fact supporting the answer."],
  "confidence": "high|medium|low",
  "uncertainty": "Explicit remaining uncertainty, or null if negligible."
}

Rules:
- answer must be non-empty and must not contradict confirmed user constraints.
- rationale must contain 2-4 bullets citing provided context, confirmed constraints, or repo facts.
- confidence must be high, medium, or low.
- Use uncertainty whenever context is thin, ambiguous, or depends on a product choice the transcript
  has not settled.

## Fallback
If the provided context is insufficient for a defensible decisive answer, do not guess. Return the
safest reversible default if one exists, mark confidence low, set uncertainty to "Insufficient
context for a reliable answer: <missing decision or evidence>", and clearly identify what the user
must confirm before execution approval.

--- CONTEXT ---
{opted-out question, prompt-safe transcript summary, locked topology, current scores/gaps, any
auto-research candidates already used this round}
```

**On valid response:** record it as the tentative answer for scoring, append the round number to `auto_answered_rounds`, and mark the transcript answer as architect-assisted. Include the answer, rationale, confidence, and uncertainty in the scoring context. **On invalid/failed response:** continue with the user's opt-out as an unresolved gap, increment `architect_failures`, and do not block the interview.

## Clarity cap and threshold-crossing confirmation

- **Clarity cap (mechanical, apply before calculating ambiguity):** unless the subagent's confidence is `high` AND uncertainty is negligible, no dimension score improved solely by the auto-answer may exceed `0.85`. Treat any low-confidence or insufficient-context auto-answer as an unresolved gap, not user-confirmed truth.
- **Threshold-crossing confirmation:** if an auto-answer would make ambiguity cross the resolved threshold, do NOT proceed to Phase 4 on it. Present the tentative assumption to the user via AskUserQuestion and require explicit confirmation, revision, or continued questioning first.

## Bookkeeping (shared)

- `auto_answered_rounds` feeds the deterministic floor's dilution term: `0.05 × min(1, auto_answered_rounds / max(scored_rounds, 1))` — heavy auto-answering mechanically raises the ambiguity floor.
- Both modes increment `auto_answer_streak` (any round resolved without direct user judgment). At streak 3 the dialectic rhythm guard routes the next question to the user unconditionally, then resets. Direct, refined, or cited-confirmation user answers reset the streak to 0.
- Persist all counters (`auto_researched_rounds`, `auto_answered_rounds`, `auto_answer_streak`, `architect_failures`) via `cat-state.mjs state write` — never hand-edit state files.
