/**
 * shared/api/types.ts — TypeScript types mirroring dashboard/server/snapshot.mjs's
 * on-the-wire JSON shape verbatim (field names/casing match the server exactly).
 * Keep this file in lockstep with dashboard/server/snapshot.mjs; it is the one
 * spot the whole app relies on for the server contract.
 */

export interface DialogueEntry {
  round_trip_id: string
  role: 'dispatch' | 'reply'
  agent_type: string
  excerpt: string
  ts: string
  prompt_id?: string | null
  paired: boolean
}

export interface SkillHud {
  nextAction: string | null
}

export interface SkillEntry {
  skill: string
  active: boolean
  current_phase: string | null
  updated_at: string | null
  hud: SkillHud | null
  threshold?: number
  threshold_source?: string
  current_ambiguity?: number
  reported_ambiguity?: number
  ambiguity_floor?: number
}

export interface Goal {
  id: string
  title: string
  status: string
}

export interface GoalsFile {
  version: number
  goals: Goal[]
}

export interface LedgerEntry {
  event: string
  /** Goal id the entry is about — different ledger event types spell this field differently: `goal_started` uses `goal`, `goal_checkpointed`/`goal_completed` use `goal_id`. Callers filtering by goal should check both. */
  goal?: string
  goal_id?: string
  event_id: string
  ts: string
  [key: string]: unknown
}

export interface SessionSnapshot {
  sessionId: string
  lit: boolean
  skills: Record<string, SkillEntry>
  goals: GoalsFile | null
  ledgerTail: LedgerEntry[]
  dialogue: DialogueEntry[]
  hasSpecs: boolean
  specs: string[]
  hasPlans: boolean
  plans: { ralplan: string[] }
}

export interface ProjectSnapshot {
  root: string
  lit: boolean
  sessions: SessionSnapshot[]
}

export interface Snapshot {
  schemaVersion: number
  generatedAt: string
  projects: ProjectSnapshot[]
}
