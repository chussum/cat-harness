/**
 * dashboard/server/snapshot.mjs — builds a versioned, MCP-friendly JSON snapshot of
 * one or more registered project roots by rescanning their .cat/_session-* trees.
 *
 * Disk is the sole source of truth (DESIGN.md §3 state contract): every call
 * rebuilds from scratch, no cached/authoritative in-memory state. Stable keys,
 * no functions, no class instances in the returned value — safe to JSON.stringify
 * and safe for a future MCP bridge to consume unchanged.
 */

import fs from "node:fs";
import path from "node:path";
import { SKILLS, isLitPhase } from "./phase-model.mjs";
import { existsDir, listDirSafe, readJsonSafe, tailJsonl } from "./fsutil.mjs";

export const SCHEMA_VERSION = 1;
const LEDGER_TAIL_N = 20;
const DIALOGUE_TAIL_N = 50;

const AMBIGUITY_FIELDS = [
  "threshold",
  "threshold_source",
  "current_ambiguity",
  "reported_ambiguity",
  "ambiguity_floor",
];

function listSessionDirs(catDir) {
  return listDirSafe(catDir)
    .filter((e) => e.isDirectory() && e.name.startsWith("_session-"))
    .map((e) => ({ id: e.name.slice("_session-".length), dir: path.join(catDir, e.name) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Starred fields (skill, active, current_phase, updated_at) + hud + ambiguity fields. */
function buildSkillEntry(sessionDir, skill) {
  const file = path.join(sessionDir, "state", `${skill}-state.json`);
  const state = readJsonSafe(file, null);
  if (!state || typeof state !== "object") return null;

  const entry = {
    skill: typeof state.skill === "string" ? state.skill : skill,
    active: state.active === true,
    current_phase: typeof state.current_phase === "string" ? state.current_phase : null,
    updated_at: typeof state.updated_at === "string" ? state.updated_at : null,
    hud: state.hud && typeof state.hud === "object" ? { nextAction: state.hud.nextAction ?? null } : null,
  };
  for (const field of AMBIGUITY_FIELDS) {
    if (state[field] !== undefined) entry[field] = state[field];
  }
  return entry;
}

function buildGoals(sessionDir) {
  return readJsonSafe(path.join(sessionDir, "ultragoal", "goals.json"), null);
}

function buildLedgerTail(sessionDir) {
  return tailJsonl(path.join(sessionDir, "ultragoal", "ledger.jsonl"), LEDGER_TAIL_N);
}

/**
 * G005 additive extension: tail-reads state/dialogue-excerpts.jsonl (G004's
 * append-only dispatch/reply excerpt log) for the UI's speech bubbles + side-panel
 * timeline. Fail-open (missing/corrupt file -> []) via tailJsonl; bounded to the
 * last DIALOGUE_TAIL_N rows so a long-running session's snapshot stays small.
 * Passes through each row's shape as written by hooks/cat-hook.mjs /
 * scripts/cat-state.mjs's `dialogue append` (round_trip_id, role, agent_type,
 * excerpt, ts, prompt_id, paired) verbatim — no reshaping, so this stays a thin
 * read-only mirror of the on-disk contract.
 */
function buildDialogue(sessionDir) {
  return tailJsonl(path.join(sessionDir, "state", "dialogue-excerpts.jsonl"), DIALOGUE_TAIL_N);
}

function listSpecs(sessionDir) {
  const specsDir = path.join(sessionDir, "specs");
  if (!existsDir(specsDir)) return [];
  return listDirSafe(specsDir)
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .sort();
}

function listPlanRuns(sessionDir) {
  const ralplanDir = path.join(sessionDir, "plans", "ralplan");
  if (!existsDir(ralplanDir)) return [];
  return listDirSafe(ralplanDir)
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

function buildSession(sessionEntry) {
  const { id, dir } = sessionEntry;
  const skills = {};
  let lit = false;
  for (const skill of SKILLS) {
    const skillEntry = buildSkillEntry(dir, skill);
    if (skillEntry) {
      skills[skill] = skillEntry;
      if (skillEntry.active && isLitPhase(skillEntry.current_phase)) lit = true;
    }
  }
  return {
    sessionId: id,
    lit,
    skills,
    goals: buildGoals(dir),
    ledgerTail: buildLedgerTail(dir),
    dialogue: buildDialogue(dir),
    hasSpecs: existsDir(path.join(dir, "specs")),
    specs: listSpecs(dir),
    hasPlans: existsDir(path.join(dir, "plans")),
    plans: { ralplan: listPlanRuns(dir) },
  };
}

/**
 * Builds one project's snapshot entry from its filesystem root. Self-healing and
 * coarse: a root with no .cat tree yet (not registered/no activity) yields an
 * empty, dormant entry rather than an error — never throws.
 */
export function buildProjectSnapshot(root) {
  const catDir = path.join(root, ".cat");
  const sessions = existsDir(catDir) ? listSessionDirs(catDir).map(buildSession) : [];
  return {
    root,
    lit: sessions.some((s) => s.lit),
    sessions,
  };
}

/** Builds the full multi-project snapshot served over HTTP/SSE. */
export function buildSnapshot(roots) {
  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    projects: roots.map(buildProjectSnapshot),
  };
}
