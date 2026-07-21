#!/usr/bin/env node
/**
 * cat-state.mjs — the single sanctioned writer for cat-harness runtime state.
 * Implements DESIGN.md §4 exactly. Every subcommand is a pure Node builtin
 * (node >= 18) EXCEPT `graph build` and `graph query`, which use a vendored
 * web-tree-sitter WASM runtime (scripts/vendor/tree-sitter/, loaded only by
 * relative path) plus the built-in node:sqlite module — both require Node
 * 22.13.0 or newer (see the guard at the entry of each graph handler; every
 * other subcommand keeps working below that floor).
 *
 * Subcommands (all take --session <sid>; `-` reads stdin for JSON/file bodies):
 *   init
 *   state read   [--skill s]
 *   state write  --skill s --json <str|->
 *   state clear  --skill s
 *   artifact write --workflow ralplan --run <id> --stage <NN>-<name> --file <path|->
 *   goal init    --brief <path|->
 *   goal checkpoint --goal GNNN --status <s> [--quality-gate-json <path|->]
 *   ledger append --json <str|->
 *   dialogue append --json <str|->  (G004: sanctioned append to state/dialogue-excerpts.jsonl)
 *   floor
 *   receipt verify --goal GNNN
 *   design diff  --figma <path|-> --impl <path|->
 *   design visual --figma <path> --impl <path> [--major-threshold N] [--block-threshold N] [--exclude <json>]
 *   graph build  [--changed-only]           (Node 22.13.0+, repo-scoped .cat/graph/graph.db)
 *   graph query  --file <path> [--depth N]  (Node 22.13.0+, repo-scoped .cat/graph/graph.db)
 *
 * Exit codes: 0 ok; 1 usage/unexpected error; 2 contract refusal (invalid envelope,
 * invalid phase edge, trigger inconsistency, failed quality gate, stale/tampered
 * receipt, different-content artifact rewrite).
 *
 * Writer policy (G1 port): state/**, ultragoal/goals.json, ultragoal/ledger.jsonl and
 * plans/**\/index.jsonl are mutated ONLY here — atomic tmp+rename, sha256 receipt
 * stamping, revision bump, deterministic ambiguity-floor clamp. Every mutation
 * touches .session-activity.json (schema v2: {updated_at, skills:{<skill>: iso}}),
 * merging this mutation's skill timestamp and preserving existing skills entries.
 * `graph build`/`graph query` extend this same writer doctrine to a new
 * repository-scoped path (.cat/graph/graph.db, a sibling of .cat/settings.json,
 * outside any session directory) — they take --session for CLI parsing
 * uniformity only (see makeCtx) and never touch ctx.root.
 */

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const EXIT_USAGE = 1;
const EXIT_CONTRACT = 2;

const SKILLS = ["deep-interview", "ralplan", "ultragoal", "team"];

const INITIAL_PHASE = {
  "deep-interview": "interviewing",
  ralplan: "planner",
  ultragoal: "goal-planning",
  team: "starting",
};

// Canonical phase edges per DESIGN.md §3 table (self-loop always allowed; loop-backs
// cover the ralplan revision cycle and ultragoal review cycle; team terminal alts).
const PHASE_EDGES = {
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

const GOAL_STATUSES = [
  "pending", "active", "complete", "failed", "blocked", "review_blocked", "superseded",
];

// Deterministic ambiguity floor — exact port (gjc deep-interview-ambiguity.ts).
const DISPUTED_FACT_WEIGHT = 0.10;
const UNSCORED_COMPONENT_WEIGHT = 0.05;
const AUTO_ANSWER_DILUTION_WEIGHT = 0.05;

// Evidence substance floor (gjc MIN_SUBSTANTIVE_EVIDENCE_*).
const MIN_EVIDENCE_WORDS = 5;
const MIN_EVIDENCE_CHARS = 32;
const PLACEHOLDER_EVIDENCE = /^(todo|tbd|n\/a|na|none|placeholder|empty|stub)[.!]*$/i;

class UsageError extends Error {}
class ContractError extends Error {}

// ---------------------------------------------------------------- primitives

function nowIso() {
  return new Date().toISOString();
}

function isFiniteNum(v) {
  return typeof v === "number" && Number.isFinite(v);
}

function round2(v) {
  return Math.round(v * 100) / 100;
}

function sha256hex(input) {
  return createHash("sha256").update(input).digest("hex");
}

/** Canonical JSON: recursively key-sorted, undefined-stripped. */
function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map((v) => canonicalJson(v === undefined ? null : v)).join(",") + "]";
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalJson(value[k])).join(",") + "}";
}

/** Crash-atomic write: mkdir parents, tmp file, rename. */
function atomicWrite(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}.${randomUUID()}`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

/** All JSON files: 2-space indent, trailing newline (DESIGN §9). */
function writeJsonFile(file, obj) {
  atomicWrite(file, JSON.stringify(obj, null, 2) + "\n");
}

function appendJsonl(file, entry) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(entry) + "\n");
}

function readJsonSafe(file) {
  try {
    const raw = fs.readFileSync(file, "utf8");
    const value = JSON.parse(raw);
    return { ok: true, value };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function readJsonlSafe(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const rows = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      rows.push(JSON.parse(trimmed));
    } catch {
      /* skip corrupt rows — reads fail open */
    }
  }
  return rows;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function printJson(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + "\n");
}

// ------------------------------------------------------------------- session

function makeCtx(flags) {
  const sid = flags.session;
  if (!sid) throw new UsageError("--session <sid> is required");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(sid) || sid.includes("..")) {
    throw new UsageError(`invalid --session id "${sid}"`);
  }
  const projectRoot = process.cwd();
  const root = path.join(projectRoot, ".cat", `_session-${sid}`);
  return { sid, projectRoot, root };
}

function rel(ctx, abs) {
  return path.relative(ctx.projectRoot, abs);
}

/**
 * Every mutation touches the activity marker (DESIGN §3 schema v2):
 *   {"updated_at": iso, "skills": {"<skill>": iso, ...}}
 * The writer merges its own skill's timestamp on every mutation; existing
 * skills entries are always preserved. Hook nudge writes update updated_at
 * only and preserve skills — that side lives in cat-hook.mjs.
 */
function touchActivity(ctx, skill) {
  const marker = path.join(ctx.root, ".session-activity.json");
  const prev = readJsonSafe(marker);
  const prevSkills =
    prev.ok &&
    prev.value &&
    typeof prev.value === "object" &&
    prev.value.skills &&
    typeof prev.value.skills === "object" &&
    !Array.isArray(prev.value.skills)
      ? prev.value.skills
      : {};
  const ts = nowIso();
  const skills = { ...prevSkills };
  if (typeof skill === "string" && SKILLS.includes(skill)) skills[skill] = ts;
  writeJsonFile(marker, { updated_at: ts, skills });
}

function auditAppend(ctx, entry) {
  try {
    appendJsonl(path.join(ctx.root, "state", "audit.jsonl"), {
      ts: nowIso(),
      owner: "cat-state.mjs",
      ...entry,
    });
    touchActivity(ctx, typeof entry.skill === "string" ? entry.skill : undefined);
  } catch {
    /* audit is best-effort; never mask the primary refusal */
  }
}

/** Contract refusal that also lands in audit.jsonl before exit 2. */
function refuse(ctx, auditEntry, message) {
  auditAppend(ctx, auditEntry);
  throw new ContractError(message);
}

function statePath(ctx, skill) {
  return path.join(ctx.root, "state", `${skill}-state.json`);
}

function requireSkill(flags) {
  const skill = flags.skill;
  if (!skill) throw new UsageError("--skill <s> is required");
  if (!SKILLS.includes(skill)) {
    throw new ContractError(`unknown skill "${skill}" — must be one of: ${SKILLS.join(", ")}`);
  }
  return skill;
}

// -------------------------------------------------- deep-interview floor math

function isScoredRound(r) {
  if (!r || typeof r !== "object") return false;
  if (r.status === "scored" || r.lifecycle === "scored" || r.scored === true) return true;
  if (r.status === undefined && r.lifecycle === undefined && isFiniteNum(r.ambiguity)) return true;
  return false;
}

function isAutoAnsweredRound(r) {
  return !!r && typeof r === "object" && (r.auto_answered === true || r.answer_source === "auto");
}

/**
 * floor = clamp(0.10 × disputed_facts + 0.05 × unscored_active_components
 *             + 0.05 × min(1, auto_answered_rounds / max(scored_rounds, 1)), 0, 1)
 * rounded to 2 decimals. Exact port of gjc deep-interview-ambiguity.ts.
 */
function computeFloor(state) {
  const s = state && typeof state === "object" ? state : {};

  // disputed fact = disputed:true and no non-empty superseded_by
  const facts = Array.isArray(s.established_facts) ? s.established_facts : [];
  const disputed = facts.filter(
    (f) =>
      f &&
      typeof f === "object" &&
      f.disputed === true &&
      !(typeof f.superseded_by === "string" && f.superseded_by.trim().length > 0)
  ).length;

  // unscored component = active (non-deferred) component of a status:"confirmed"
  // topology whose goal/constraints/criteria clarity_scores are not all finite.
  let unscored = 0;
  const topo = s.topology;
  if (topo && typeof topo === "object" && topo.status === "confirmed" && Array.isArray(topo.components)) {
    for (const c of topo.components) {
      if (!c || typeof c !== "object") continue;
      if (c.deferred === true || c.status === "deferred") continue;
      const cs = c.clarity_scores;
      const allFinite =
        cs && typeof cs === "object" && ["goal", "constraints", "criteria"].every((k) => isFiniteNum(cs[k]));
      if (!allFinite) unscored += 1;
    }
  }

  const rounds = Array.isArray(s.rounds) ? s.rounds : [];
  const scoredRounds = rounds.length
    ? rounds.filter(isScoredRound).length
    : isFiniteNum(s.scored_rounds)
      ? Math.max(0, s.scored_rounds)
      : 0;
  const autoAnswered = isFiniteNum(s.auto_answered_rounds)
    ? Math.max(0, s.auto_answered_rounds)
    : rounds.filter(isAutoAnsweredRound).length;
  const dilutionRatio = Math.min(1, autoAnswered / Math.max(scoredRounds, 1));

  const sum =
    DISPUTED_FACT_WEIGHT * disputed +
    UNSCORED_COMPONENT_WEIGHT * unscored +
    AUTO_ANSWER_DILUTION_WEIGHT * dilutionRatio;
  const floor = round2(Math.min(1, Math.max(0, sum)));

  return {
    floor,
    parts: {
      disputed_facts: disputed,
      disputed_contribution: round2(DISPUTED_FACT_WEIGHT * disputed),
      unscored_active_components: unscored,
      unscored_contribution: round2(UNSCORED_COMPONENT_WEIGHT * unscored),
      auto_answered_rounds: autoAnswered,
      scored_rounds: scoredRounds,
      dilution_ratio: Number(dilutionRatio.toFixed(4)),
      dilution_contribution: round2(AUTO_ANSWER_DILUTION_WEIGHT * dilutionRatio),
    },
  };
}

/** effective = max(min(1, max(0, reported)), floor) */
function clampReported(reported, floor) {
  const normalized = Math.min(1, Math.max(0, reported));
  return Math.max(normalized, floor);
}

function latestScoredRoundIndex(rounds) {
  for (let i = rounds.length - 1; i >= 0; i--) {
    if (isScoredRound(rounds[i])) return i;
  }
  return -1;
}

/**
 * Clamp current_ambiguity and the LATEST scored round only. Raw values are
 * preserved as reported_ambiguity; the floor is recorded as ambiguity_floor.
 * Historical rounds are never rewritten.
 */
function applyAmbiguityFloor(merged, incoming) {
  const { floor } = computeFloor(merged);
  merged.ambiguity_floor = floor;

  const has = (obj, key) => obj && Object.prototype.hasOwnProperty.call(obj, key);
  let raw;
  if (has(incoming, "reported_ambiguity") && isFiniteNum(incoming.reported_ambiguity)) {
    raw = incoming.reported_ambiguity;
  } else if (has(incoming, "current_ambiguity") && isFiniteNum(incoming.current_ambiguity)) {
    raw = incoming.current_ambiguity;
  } else if (isFiniteNum(merged.reported_ambiguity)) {
    raw = merged.reported_ambiguity;
  } else if (isFiniteNum(merged.current_ambiguity)) {
    raw = merged.current_ambiguity;
  }
  if (isFiniteNum(raw)) {
    merged.reported_ambiguity = raw;
    merged.current_ambiguity = clampReported(raw, floor);
  }

  const rounds = Array.isArray(merged.rounds) ? merged.rounds : [];
  const idx = latestScoredRoundIndex(rounds);
  if (idx >= 0) {
    const r = rounds[idx];
    const rraw = isFiniteNum(r.reported_ambiguity)
      ? r.reported_ambiguity
      : isFiniteNum(r.ambiguity)
        ? r.ambiguity
        : undefined;
    if (isFiniteNum(rraw)) {
      r.reported_ambiguity = rraw;
      r.ambiguity = clampReported(rraw, floor);
      r.ambiguity_floor = floor;
    }
  }
  return floor;
}

/**
 * Trigger consistency (fail-closed): a round carrying an `active`
 * ambiguity-raising trigger must report ambiguity strictly greater than the
 * prior scored round, and the affected dimension must not improve.
 * disputed/unresolved triggers must carry a non-empty rationale.
 * Returns a refusal reason string or null.
 */
function validateTriggerConsistency(merged) {
  const rounds = Array.isArray(merged.rounds) ? merged.rounds : [];
  const latestIdx = latestScoredRoundIndex(rounds);
  if (latestIdx < 0) return null;
  const latest = rounds[latestIdx];
  let prior = null;
  for (let i = latestIdx - 1; i >= 0; i--) {
    if (isScoredRound(rounds[i])) {
      prior = rounds[i];
      break;
    }
  }
  const triggers = Array.isArray(latest.triggers) ? latest.triggers : [];
  for (const t of triggers) {
    if (!t || typeof t !== "object") continue;
    if (t.status === "active") {
      if (!prior) continue; // nothing to compare against
      const rawNew = isFiniteNum(latest.reported_ambiguity) ? latest.reported_ambiguity : latest.ambiguity;
      const priorAmb = isFiniteNum(prior.ambiguity) ? prior.ambiguity : prior.reported_ambiguity;
      if (!isFiniteNum(rawNew) || !isFiniteNum(priorAmb)) {
        return "trigger consistency: cannot verify ambiguity rise for an active trigger (missing/non-finite round ambiguity)";
      }
      if (!(rawNew > priorAmb)) {
        return `trigger consistency: a round with an active trigger must report ambiguity strictly greater than the prior scored round (${rawNew} <= ${priorAmb})`;
      }
      const dim = typeof t.affected_dimension === "string" && t.affected_dimension.trim() ? t.affected_dimension : null;
      if (!dim) return "trigger consistency: active trigger is missing affected_dimension";
      const newScore = isFiniteNum(t.new_dimension_score)
        ? t.new_dimension_score
        : latest.scores && isFiniteNum(latest.scores[dim])
          ? latest.scores[dim]
          : undefined;
      const priorScore = isFiniteNum(t.prior_dimension_score)
        ? t.prior_dimension_score
        : prior.scores && isFiniteNum(prior.scores[dim])
          ? prior.scores[dim]
          : undefined;
      if (!isFiniteNum(newScore) || !isFiniteNum(priorScore)) {
        return `trigger consistency: cannot verify affected dimension "${dim}" (missing dimension scores on the round records)`;
      }
      if (newScore > priorScore) {
        return `trigger consistency: affected dimension "${dim}" must not improve while its trigger is active (${newScore} > ${priorScore})`;
      }
    } else if (t.status === "disputed" || t.status === "unresolved") {
      const rationale = t.rationale ?? t.disputed_unresolved_rationale;
      if (!(typeof rationale === "string" && rationale.trim().length > 0)) {
        return `trigger consistency: a "${t.status}" trigger must carry a non-empty rationale`;
      }
    }
  }
  return null;
}

// -------------------------------------------------------------- quality gate

function substantiveEvidence(text) {
  if (typeof text !== "string") return false;
  const trimmed = text.trim();
  if (trimmed.length < MIN_EVIDENCE_CHARS) return false;
  if (PLACEHOLDER_EVIDENCE.test(trimmed)) return false;
  if (trimmed.split(/\s+/).length < MIN_EVIDENCE_WORDS) return false;
  return true;
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function isScreenshotArtifact(a) {
  return /screenshot|image|visual/i.test(String(a.kind ?? "")) || /\.(png|jpe?g)$/i.test(String(a.path ?? ""));
}

/**
 * Fail-closed completion quality gate (DESIGN §4):
 *   - architect verdicts all "CLEAR" + recommendation "APPROVE"
 *   - qa.status === "passed" with non-empty commands + substantive evidence
 *   - blockers present and empty
 *   - evidence artifact files exist; screenshots >= 4096 bytes with PNG/JPEG magic
 * Canonical shape:
 * {
 *   "architect_review": { "verdicts": {"architecture":"CLEAR",...},
 *                          "recommendation": "APPROVE", "evidence": "...", "blockers": [] },
 *   "qa": { "status": "passed", "commands": ["..."], "evidence": "...",
 *            "artifacts": [{"kind":"screenshot","path":"..."}], "blockers": [] }
 * }
 * (architect_verdicts / architect_recommendation / architect_evidence /
 *  architect_blockers accepted as top-level aliases.)
 *
 * Signature is (gate, ctx, goalId): projectRoot is derived from ctx.projectRoot,
 * and when ctx.root is present the design-QA gate is delegated to via ctx+goalId.
 */
function validateQualityGate(gate, ctx, goalId) {
  const projectRoot = ctx.projectRoot;
  const errs = [];
  if (!gate || typeof gate !== "object" || Array.isArray(gate)) {
    return ["quality gate must be a JSON object"];
  }

  const review = gate.architect_review && typeof gate.architect_review === "object" ? gate.architect_review : null;
  const verdicts = review?.verdicts ?? gate.architect_verdicts;
  if (!verdicts || typeof verdicts !== "object" || Array.isArray(verdicts) || Object.keys(verdicts).length === 0) {
    errs.push("architect verdicts missing — expected architect_review.verdicts (or architect_verdicts) with at least one lane");
  } else {
    for (const [lane, v] of Object.entries(verdicts)) {
      if (v !== "CLEAR") errs.push(`architect verdict for "${lane}" is ${JSON.stringify(v)} — every verdict must be "CLEAR"`);
    }
  }
  const recommendation = review?.recommendation ?? gate.architect_recommendation;
  if (recommendation !== "APPROVE") {
    errs.push(`architect recommendation is ${JSON.stringify(recommendation)} — must be "APPROVE"`);
  }
  const reviewEvidence = review ? review.evidence : gate.architect_evidence;
  if (!substantiveEvidence(reviewEvidence)) {
    errs.push(`architect_review.evidence must be substantive (>= ${MIN_EVIDENCE_WORDS} words, >= ${MIN_EVIDENCE_CHARS} chars, no placeholders)`);
  }
  const reviewBlockers = review ? review.blockers : gate.architect_blockers;
  if (!Array.isArray(reviewBlockers) || reviewBlockers.length !== 0) {
    errs.push("architect_review.blockers must be present and an empty array");
  }

  const qa = gate.qa;
  if (!qa || typeof qa !== "object" || Array.isArray(qa)) {
    errs.push('qa section missing — expected {"status":"passed","commands":[...],"evidence":"...","artifacts":[...],"blockers":[]}');
    return errs;
  }
  if (qa.status !== "passed") errs.push(`qa.status is ${JSON.stringify(qa.status)} — must be "passed"`);
  if (!Array.isArray(qa.commands) || qa.commands.length === 0 || !qa.commands.every((c) => typeof c === "string" && c.trim())) {
    errs.push("qa.commands must be a non-empty array of passed command strings");
  }
  if (!substantiveEvidence(qa.evidence)) {
    errs.push(`qa.evidence must be substantive (>= ${MIN_EVIDENCE_WORDS} words, >= ${MIN_EVIDENCE_CHARS} chars, no placeholders)`);
  }
  if (!Array.isArray(qa.blockers) || qa.blockers.length !== 0) {
    errs.push("qa.blockers must be present and an empty array");
  }

  const artifacts = Array.isArray(qa.artifacts) ? qa.artifacts : [];
  artifacts.forEach((a, i) => {
    if (!a || typeof a !== "object" || typeof a.path !== "string" || !a.path.trim()) {
      errs.push(`qa.artifacts[${i}] must be an object {kind, path}`);
      return;
    }
    const abs = path.isAbsolute(a.path) ? a.path : path.resolve(projectRoot, a.path);
    let st;
    try {
      st = fs.statSync(abs);
    } catch {
      errs.push(`qa.artifacts[${i}] "${a.path}" does not exist`);
      return;
    }
    if (!st.isFile() || st.size === 0) {
      errs.push(`qa.artifacts[${i}] "${a.path}" is not a non-empty file`);
      return;
    }
    if (isScreenshotArtifact(a)) {
      if (st.size < 4096) {
        errs.push(`screenshot artifact "${a.path}" is ${st.size} bytes — screenshots must be >= 4096 bytes`);
      }
      const head = Buffer.alloc(8);
      const fd = fs.openSync(abs, "r");
      try {
        fs.readSync(fd, head, 0, 8, 0);
      } finally {
        fs.closeSync(fd);
      }
      const isPng = head.equals(PNG_MAGIC);
      const isJpeg = head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
      if (!isPng && !isJpeg) {
        errs.push(`screenshot artifact "${a.path}" lacks PNG/JPEG magic bytes`);
      }
    }
  });

  // Design-QA measurement-matrix gate — fires ONLY when a design source is on
  // record (spec / approved plan / this goal's brief). No source → no new errs,
  // so the non-trigger path is behaviorally identical to before this gate.
  if (ctx && typeof ctx === "object" && ctx.root) {
    const designSource = findDesignSourceOnRecord(ctx, goalId);
    if (designSource) {
      for (const e of validateDesignGate(gate, ctx, goalId, designSource)) errs.push(e);
    }
  }

  return errs;
}

// --------------------------------------------------------- design-QA gate

/** Any http(s) URL; a bare figma.com URL also counts even without a key. */
const ANY_URL_RE = /https?:\/\/[^\s)<>"'\]]+/i;
const FIGMA_URL_RE = /https?:\/\/(?:[\w.-]+\.)?figma\.com\/[^\s)<>"'\]]+/i;
const DESIGN_SOURCE_LINE_RE = /Design Source\s*:\s*(.+)/i;

/** Reject blank / n-a / tbd / dash / unknown / same / similar / approx as a MEASURED value. */
const PLACEHOLDER_VALUE = /^(|-|–|—|n\/a|na|tbd|unknown|same|similar|approx|approximately)[.!]*$/i;

function isPlaceholderValue(v) {
  if (v === null || v === undefined) return true;
  return PLACEHOLDER_VALUE.test(String(v).trim());
}

function stripHtmlComments(s) {
  return String(s).replace(/<!--[\s\S]*?-->/g, "");
}

/** Extract a real design URL from a "Design Source:" line value (not "" / "none"). */
function designUrlFromDesignSourceLine(text) {
  for (const line of String(text).split(/\r?\n/)) {
    const m = DESIGN_SOURCE_LINE_RE.exec(line);
    if (!m) continue;
    const val = stripHtmlComments(m[1]).replace(/[{}]/g, "").trim();
    if (!val || /^(none|n\/a|na|tbd|-|–|—)$/i.test(val)) continue;
    const um = ANY_URL_RE.exec(val);
    if (um) return um[0];
  }
  return null;
}

/** A figma URL anywhere, or a keyed Design Source line — used for plan/goal text. */
function designUrlAnywhere(text) {
  const fm = FIGMA_URL_RE.exec(String(text));
  if (fm) return fm[0];
  return designUrlFromDesignSourceLine(text);
}

/** Approved-plan artifacts under ctx.root/plans: pending-approval + ralplan finals/revisions. */
function collectPlanFiles(ctx) {
  const out = [];
  const stack = [path.join(ctx.root, "plans")];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (
        e.isFile() &&
        (e.name === "pending-approval.md" ||
          e.name === "final-adr.md" ||
          /^stage-.*-(final|revision)\.md$/i.test(e.name))
      ) {
        out.push(full);
      }
    }
  }
  return out.sort();
}

/**
 * Return the first recorded design/Figma URL for a checkpointed goal, scanning
 * in order: (a) this session's specs/*.md "Design Source:" lines; (b) the
 * approved plan artifacts; (c) the goalId-scoped goal objective/title. Scoped to
 * ctx.root (cross-session isolation). Value must not be "" / "none". Fails OPEN
 * (returns null) on any I/O error — a scan failure never blocks a checkpoint.
 */
function findDesignSourceOnRecord(ctx, goalId) {
  try {
    // (a) deep-interview specs
    const specsDir = path.join(ctx.root, "specs");
    let specFiles = [];
    try {
      specFiles = fs.readdirSync(specsDir).filter((f) => f.endsWith(".md")).sort();
    } catch {
      /* no specs dir — fall through */
    }
    for (const f of specFiles) {
      let txt;
      try {
        txt = fs.readFileSync(path.join(specsDir, f), "utf8");
      } catch {
        continue;
      }
      const url = designUrlFromDesignSourceLine(txt);
      if (url) return url;
    }

    // (b) approved plan
    for (const pf of collectPlanFiles(ctx)) {
      let txt;
      try {
        txt = fs.readFileSync(pf, "utf8");
      } catch {
        continue;
      }
      const url = designUrlAnywhere(txt);
      if (url) return url;
    }

    // (c) this goal's brief (goalId-scoped — a sibling goal's URL must NOT trigger)
    if (goalId) {
      const res = readJsonSafe(ultragoalPaths(ctx).goals);
      if (res.ok && res.value && Array.isArray(res.value.goals)) {
        const goal = res.value.goals.find((g) => g && g.id === goalId);
        if (goal) {
          const txt = [goal.title, goal.objective].filter((s) => typeof s === "string").join("\n");
          const url = designUrlAnywhere(txt);
          if (url) return url;
        }
      }
    }
  } catch {
    return null; // fail OPEN
  }
  return null;
}

// -- value normalizers (1:1 with skills/ultragoal/references/design-qa.md:226-237)

function byteHex(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return null;
  return Math.min(255, Math.max(0, Math.round(n))).toString(16).padStart(2, "0");
}

/** color → normalized 8-digit lowercase hex (rrggbbaa). Accepts #rgb/#rgba/#rrggbb/#rrggbbaa/rgb()/rgba(). */
function normalizeColor(v) {
  if (typeof v !== "string") return null;
  const s = v.trim().toLowerCase();
  let m = /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(s);
  if (m) {
    let h = m[1];
    if (h.length === 3) h = h.split("").map((c) => c + c).join("") + "ff";
    else if (h.length === 4) h = h.split("").map((c) => c + c).join(""); // #rgba → rrggbbaa
    else if (h.length === 6) h = h + "ff";
    return h.toLowerCase();
  }
  m = /^rgba?\(\s*([\d.]+)\s*[, ]\s*([\d.]+)\s*[, ]\s*([\d.]+)\s*(?:[,/]\s*([\d.]+%?)\s*)?\)$/i.exec(s);
  if (m) {
    const r = byteHex(m[1]);
    const g = byteHex(m[2]);
    const b = byteHex(m[3]);
    if (r === null || g === null || b === null) return null;
    let a = "ff";
    if (m[4] !== undefined) {
      let anum = m[4].endsWith("%") ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
      if (!Number.isFinite(anum)) return null;
      anum = Math.min(1, Math.max(0, anum));
      a = Math.round(anum * 255).toString(16).padStart(2, "0");
    }
    return r + g + b + a;
  }
  return null;
}

/** length → px number (2dp), rem@16root. "auto" → null; "normal" → 0 only when normalIsZero. */
function normalizeLength(v, normalIsZero = false) {
  if (typeof v === "number") return Number.isFinite(v) ? round2(v) : null;
  if (typeof v !== "string") return null;
  const s = v.trim().toLowerCase();
  if (s === "auto") return null;
  if (s === "normal") return normalIsZero ? 0 : null;
  let m = /^(-?\d*\.?\d+)px$/.exec(s);
  if (m) return round2(parseFloat(m[1]));
  m = /^(-?\d*\.?\d+)rem$/.exec(s);
  if (m) return round2(parseFloat(m[1]) * 16);
  m = /^(-?\d*\.?\d+)$/.exec(s);
  if (m) return round2(parseFloat(m[1]));
  return null;
}

/** font-weight → {400,500,700} bucket. */
function normalizeWeight(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim().toLowerCase();
  const named = {
    thin: 100, hairline: 100, extralight: 200, ultralight: 200, light: 300,
    normal: 400, regular: 400, book: 400, medium: 500, semibold: 600, demibold: 600,
    bold: 700, extrabold: 800, ultrabold: 800, black: 900, heavy: 900,
  };
  let n;
  if (/^\d+$/.test(s)) n = parseInt(s, 10);
  else if (named[s] !== undefined) n = named[s];
  else return null;
  if (!Number.isFinite(n)) return null;
  if (n <= 450) return 400;
  if (n <= 600) return 500;
  return 700;
}

/** font-family → non-placeholder first-in-stack lowercase string. */
function normalizeFamily(v) {
  if (typeof v !== "string") return null;
  const s = v.trim().toLowerCase().replace(/['"]/g, "").split(",")[0].trim();
  if (!s || isPlaceholderValue(s)) return null;
  return s;
}

const SEVERITY_ORDINAL = { None: 0, Trivial: 1, Minor: 2, Major: 3, Critical: 4 };
const UNPARSEABLE = Symbol("unparseable");

const DESIGN_PROPERTY_KIND = {
  color: "color", "background-color": "color", background: "color",
  "border-color": "color", fill: "color",
  // border-radius reconciled to a ±2px LENGTH / Major (waivable) contract — a
  // flat row lacks the container-height context a category match needs; see
  // design-qa.md severity table.
  "border-radius": "sizeMajor2",
  width: "sizeMajor2", height: "sizeMajor2",
  // aggregate spacing AND per-side spacing — both ±2px / Major, matching the
  // design-qa.md property enum (padding-top/right/bottom/left, margin-*).
  padding: "sizeMajor2", margin: "sizeMajor2", gap: "sizeMajor2",
  "padding-top": "sizeMajor2", "padding-right": "sizeMajor2",
  "padding-bottom": "sizeMajor2", "padding-left": "sizeMajor2",
  "margin-top": "sizeMajor2", "margin-right": "sizeMajor2",
  "margin-bottom": "sizeMajor2", "margin-left": "sizeMajor2",
  "font-size": "fontSize", "font-weight": "fontWeight", "font-family": "fontFamily",
  "line-height": "lineHeight", "letter-spacing": "letterSpacing",
};

const MANDATORY_TYPO = ["font-size", "line-height", "font-weight"];
// aggregate spacing props whose PRESENCE is separately mandatory (>=1 per surface)
const SPACING_PROPS = ["padding", "margin", "gap"];

/** Any spacing property that satisfies the mandatory per-surface spacing floor:
 *  aggregate padding/margin/gap OR any per-side padding/margin side key. */
function isSpacingProperty(p) {
  return SPACING_PROPS.includes(p) || /^(padding|margin)-(top|right|bottom|left)$/.test(p);
}

function isMandatoryProperty(p) {
  return MANDATORY_TYPO.includes(p) || isSpacingProperty(p);
}

/** CLI-recompute severity per the design-qa.md table. Returns a severity string or UNPARSEABLE. */
function computeSeverity(property, expected, actual) {
  const kind = DESIGN_PROPERTY_KIND[String(property).toLowerCase()];
  if (!kind) return UNPARSEABLE;
  if (isPlaceholderValue(expected) || isPlaceholderValue(actual)) return UNPARSEABLE;
  switch (kind) {
    case "color": {
      const e = normalizeColor(expected);
      const a = normalizeColor(actual);
      if (e === null || a === null) return UNPARSEABLE;
      return e === a ? "None" : "Critical";
    }
    case "fontSize": {
      const e = normalizeLength(expected);
      const a = normalizeLength(actual);
      if (e === null || a === null) return UNPARSEABLE;
      return e === a ? "None" : "Major";
    }
    case "fontWeight": {
      const e = normalizeWeight(expected);
      const a = normalizeWeight(actual);
      if (e === null || a === null) return UNPARSEABLE;
      return e === a ? "None" : "Major";
    }
    case "fontFamily": {
      const e = normalizeFamily(expected);
      const a = normalizeFamily(actual);
      if (e === null || a === null) return UNPARSEABLE;
      return e === a ? "None" : "Minor";
    }
    case "sizeMajor2": {
      const e = normalizeLength(expected);
      const a = normalizeLength(actual);
      if (e === null || a === null) return UNPARSEABLE;
      return Math.abs(e - a) <= 2 ? "None" : "Major";
    }
    case "lineHeight": {
      const e = normalizeLength(expected);
      const a = normalizeLength(actual);
      if (e === null || a === null) return UNPARSEABLE;
      return Math.abs(e - a) <= 1 ? "None" : "Trivial";
    }
    case "letterSpacing": {
      const e = normalizeLength(expected, true);
      const a = normalizeLength(actual, true);
      if (e === null || a === null) return UNPARSEABLE;
      return Math.abs(e - a) <= 0.5 ? "None" : "Trivial";
    }
    default:
      return UNPARSEABLE;
  }
}

/**
 * Validate the qa.design measurement matrix (or a valid hatch). Returns an
 * array of refusal strings (empty ⇒ passes). Intentionally side-effecting:
 * OPTIONAL rows that don't parse are skipped AND recorded via a non-throwing
 * auditAppend note, so a passing gate is never aborted by the note.
 */
function validateDesignGate(gate, ctx, goalId, designSource) {
  const errs = [];
  const qa = gate && typeof gate.qa === "object" && gate.qa && !Array.isArray(gate.qa) ? gate.qa : {};
  const design =
    qa.design && typeof qa.design === "object" && !Array.isArray(qa.design) ? qa.design : null;
  const artifacts = Array.isArray(qa.artifacts) ? qa.artifacts : [];
  const hasScreenshot = artifacts.some((a) => a && typeof a === "object" && isScreenshotArtifact(a));
  const naAck = !!(
    gate.architect_review &&
    typeof gate.architect_review === "object" &&
    gate.architect_review.design_not_applicable_acknowledged === true
  );

  // --- not_applicable hatch: no screenshot + substantive reason + nested architect ack ---
  if (design && design.not_applicable && typeof design.not_applicable === "object" && !Array.isArray(design.not_applicable)) {
    const na = design.not_applicable;
    if (hasScreenshot) {
      errs.push('qa.design.not_applicable is invalid — a screenshot artifact is present, so this is a rendered UI surface and cannot be "not applicable"');
    }
    if (!substantiveEvidence(na.reason)) {
      errs.push(`qa.design.not_applicable.reason must be substantive (>= ${MIN_EVIDENCE_WORDS} words, >= ${MIN_EVIDENCE_CHARS} chars, no placeholders)`);
    }
    if (!naAck) {
      errs.push("qa.design.not_applicable requires nested architect_review.design_not_applicable_acknowledged:true — the alias-form gate cannot express this acknowledgement");
    }
    return errs;
  }

  // --- otherwise a complete matrix is required ---
  if (!design) {
    errs.push(`a design source is on record (${designSource}) but qa.design is missing — a complete design measurement matrix, or a valid not_applicable/waived hatch, is required`);
    return errs;
  }

  const surfaces = Array.isArray(design.surfaces) ? design.surfaces : null;
  const rows = Array.isArray(design.rows) ? design.rows : null;
  if (!surfaces || surfaces.length === 0) errs.push("qa.design.surfaces must be a non-empty array of {name, no_text?}");
  if (!rows) errs.push("qa.design.rows must be an array of {surface, element, property, figma_expected, impl_actual, severity}");
  if (errs.length) return errs;

  const surfaceByName = new Map();
  for (const s of surfaces) {
    if (!s || typeof s !== "object" || typeof s.name !== "string" || !s.name.trim()) {
      errs.push("qa.design.surfaces[] entries must each be {name:string, no_text?:boolean}");
      continue;
    }
    // Reject DUPLICATE surface names: a last-wins Map would silently let a
    // second {name, no_text:true} entry override the honest one and skip all
    // mandatory typography coverage for that surface — a malformed matrix.
    if (surfaceByName.has(s.name)) {
      errs.push(`qa.design.surfaces has a duplicate surface name "${s.name}" — each rendered surface must appear exactly once`);
      continue;
    }
    surfaceByName.set(s.name, { no_text: s.no_text === true });
  }
  if (errs.length) return errs;

  const coverage = new Map();
  for (const name of surfaceByName.keys()) coverage.set(name, new Set());
  const computedRows = [];

  rows.forEach((row, i) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      errs.push(`qa.design.rows[${i}] must be an object`);
      return;
    }
    const surface = row.surface;
    const property = typeof row.property === "string" ? row.property.toLowerCase().trim() : null;
    if (typeof surface !== "string" || !surfaceByName.has(surface)) {
      errs.push(`qa.design.rows[${i}].surface ${JSON.stringify(surface)} is not one of the declared surfaces`);
      return;
    }
    if (!property || !Object.prototype.hasOwnProperty.call(DESIGN_PROPERTY_KIND, property)) {
      errs.push(`qa.design.rows[${i}].property ${JSON.stringify(row.property)} is not a recognized design property`);
      return;
    }
    if (typeof row.severity !== "string" || !Object.prototype.hasOwnProperty.call(SEVERITY_ORDINAL, row.severity)) {
      errs.push(`qa.design.rows[${i}].severity ${JSON.stringify(row.severity)} must be one of ${Object.keys(SEVERITY_ORDINAL).join(", ")}`);
      return;
    }
    const mandatory = isMandatoryProperty(property);
    const computed = computeSeverity(property, row.figma_expected, row.impl_actual);
    if (computed === UNPARSEABLE) {
      if (mandatory) {
        errs.push(`qa.design.rows[${i}] (surface "${surface}", property "${property}") has an unparseable measured value (figma_expected=${JSON.stringify(row.figma_expected)}, impl_actual=${JSON.stringify(row.impl_actual)}) — a mandatory measurement must be well-formed`);
      } else {
        auditAppend(ctx, { category: "goal", verb: "design_optional_row_skipped", goal_id: goalId, surface, property });
      }
      return; // skipped rows contribute to neither coverage nor severity
    }
    coverage.get(surface).add(property);
    if (SEVERITY_ORDINAL[row.severity] < SEVERITY_ORDINAL[computed]) {
      errs.push(`qa.design.rows[${i}] (surface "${surface}", property "${property}") submitted severity "${row.severity}" is more lenient than the CLI-recomputed "${computed}" (figma_expected=${JSON.stringify(row.figma_expected)}, impl_actual=${JSON.stringify(row.impl_actual)})`);
    }
    computedRows.push({ surface, property, computed, figma_expected: row.figma_expected, impl_actual: row.impl_actual });
  });
  if (errs.length) return errs;

  // mandatory coverage per surface
  for (const [name, meta] of surfaceByName) {
    const covered = coverage.get(name);
    const need = meta.no_text ? [] : MANDATORY_TYPO;
    for (const p of need) {
      if (!covered.has(p)) errs.push(`qa.design surface "${name}" is missing a mandatory ${p} measurement row`);
    }
    if (![...covered].some(isSpacingProperty)) {
      errs.push(`qa.design surface "${name}" is missing a mandatory spacing measurement row (one of ${SPACING_PROPS.join("/")}, or a per-side padding-*/margin-*)`);
    }
  }
  if (errs.length) return errs;

  // block on computed Critical (never waivable) / Major (waivable by the USER only)
  const criticals = computedRows.filter((r) => r.computed === "Critical");
  const majors = computedRows.filter((r) => r.computed === "Major");

  if (criticals.length > 0) {
    for (const r of criticals) {
      errs.push(`qa.design surface "${r.surface}" property "${r.property}" computes Critical (figma_expected=${JSON.stringify(r.figma_expected)}, impl_actual=${JSON.stringify(r.impl_actual)}) — a Critical design gap can NEVER be waived; resolve it`);
    }
    return errs;
  }

  if (majors.length > 0) {
    const waived = design.waived && typeof design.waived === "object" && !Array.isArray(design.waived) ? design.waived : null;
    if (!waived) {
      for (const r of majors) {
        errs.push(`qa.design surface "${r.surface}" property "${r.property}" computes Major (figma_expected=${JSON.stringify(r.figma_expected)}, impl_actual=${JSON.stringify(r.impl_actual)}) — resolve it, or record a user-acknowledged qa.design.waived`);
      }
      return errs;
    }
    if (!substantiveEvidence(waived.reason)) {
      errs.push(`qa.design.waived.reason must be substantive (>= ${MIN_EVIDENCE_WORDS} words, >= ${MIN_EVIDENCE_CHARS} chars, no placeholders)`);
    }
    if (waived.user_acknowledged !== true) {
      errs.push("qa.design.waived.user_acknowledged must be true — a Major may only be waived by explicit user acknowledgement (the agent may not self-waive)");
    }
    const waivedSurfaces = Array.isArray(waived.surfaces) ? waived.surfaces : [];
    for (const r of majors) {
      if (!waivedSurfaces.includes(r.surface)) {
        errs.push(`qa.design.waived does not list surface "${r.surface}" which carries a Major gap (property "${r.property}") — every Major surface must be explicitly waived`);
      }
    }
    if (errs.length) return errs;
  }

  // Mechanical visual (pixel-diff) gate — additive, composed AFTER the numeric
  // matrix passes. See "design-QA VISUAL gate" section below for the algorithm.
  for (const e of validateVisualGate(design, artifacts, ctx, goalId, designSource)) errs.push(e);

  return errs;
}

// ===================================================================
// design-QA VISUAL gate (mechanical PNG diff) — pure-Node, no npm dep.
//
// Decodes two PNGs (a Figma export and an implementation screenshot),
// diffs them pixel-for-pixel after letterboxing onto a common canvas and
// downscaling, and classifies the result into three severity bands:
//   None (< VISUAL_DIFF_MAJOR_THRESHOLD) / Major (waivable, like numeric
//   Major) / Blocking (>= VISUAL_DIFF_BLOCK_THRESHOLD, NEVER waivable —
//   the same severity-outside-the-ordinal slot as numeric Critical).
//
// Structural checks (existence, PNG-only, decodable, non-blank, min
// dimension, BOTH present, registered in qa.artifacts) are fail-closed and
// non-waivable, exactly like the numeric gate's row-parse failures.
// ===================================================================

const PNG_COLOR_CHANNELS = { 0: 1, 2: 3, 4: 2, 6: 4 };

/** Paeth predictor (PNG spec §9.4) — used by both filter (encode-side, tests)
 *  and un-filter (decode-side, here). */
function paethPredictor(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/**
 * Pure-Node PNG decoder (node:zlib.inflateSync only — no npm dependency).
 * Supports colorType 0/2/4/6, bitDepth 8, non-interlaced only; un-filters all
 * 5 filter types (None/Sub/Up/Average/Paeth). CRC32 is NOT verified (decode is
 * best-effort on the pixel data; a corrupt CRC does not by itself block a
 * capture that otherwise decodes cleanly). Fails closed with a clear,
 * remedy-naming ContractError on any unsupported variant (palette, 16-bit,
 * interlaced, unknown color type/filter type) — never a silent wrong decode.
 * Returns { width, height, pixels } where pixels is a Buffer of RGBA8 (4
 * bytes/pixel, row-major, top-to-bottom).
 */
function decodePng(buffer) {
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(PNG_MAGIC)) {
    throw new ContractError("not a valid PNG (bad magic bytes)");
  }
  let offset = 8;
  let ihdr = null;
  const idatChunks = [];
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > buffer.length) break; // truncated tail — stop, use what we have
    const data = buffer.subarray(dataStart, dataEnd);
    if (type === "IHDR") {
      ihdr = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data.readUInt8(8),
        colorType: data.readUInt8(9),
        interlace: data.readUInt8(12),
      };
    } else if (type === "IDAT") {
      idatChunks.push(data);
    } else if (type === "IEND") {
      break;
    }
    offset = dataEnd + 4; // skip the 4-byte CRC (unverified)
  }
  if (!ihdr) throw new ContractError("PNG has no IHDR chunk — cannot decode");
  if (idatChunks.length === 0) throw new ContractError("PNG has no IDAT data — cannot decode");
  if (ihdr.width <= 0 || ihdr.height <= 0) throw new ContractError("PNG IHDR declares a non-positive width/height");
  if (ihdr.bitDepth !== 8) {
    throw new ContractError(`unsupported PNG bit depth ${ihdr.bitDepth} (only 8-bit is supported) — re-export as an 8-bit RGBA PNG`);
  }
  if (ihdr.interlace !== 0) {
    throw new ContractError("unsupported interlaced (Adam7) PNG — re-export as a non-interlaced 8-bit RGBA PNG");
  }
  if (ihdr.colorType === 3) {
    throw new ContractError("unsupported PNG color type 3 (indexed/palette) — re-export as an 8-bit RGBA PNG (disable palette/indexed export)");
  }
  const channels = PNG_COLOR_CHANNELS[ihdr.colorType];
  if (!channels) {
    throw new ContractError(`unsupported PNG color type ${ihdr.colorType} — re-export as an 8-bit RGBA PNG`);
  }

  const compressed = Buffer.concat(idatChunks);
  let raw;
  try {
    raw = zlib.inflateSync(compressed);
  } catch (err) {
    throw new ContractError(`PNG IDAT stream failed to inflate (${err instanceof Error ? err.message : err}) — the file may be corrupt`);
  }
  const stride = ihdr.width * channels;
  const expected = (stride + 1) * ihdr.height;
  if (raw.length < expected) {
    throw new ContractError("PNG decoded data is shorter than the declared dimensions expect — the file may be truncated/corrupt");
  }

  const bpp = channels; // bytes-per-pixel at bitDepth 8
  const unfiltered = Buffer.alloc(stride * ihdr.height);
  let rawOffset = 0;
  let prevRowStart = -1;
  for (let y = 0; y < ihdr.height; y++) {
    const filterType = raw[rawOffset];
    rawOffset += 1;
    const rowStart = y * stride;
    for (let x = 0; x < stride; x++) {
      const rawByte = raw[rawOffset + x];
      const a = x >= bpp ? unfiltered[rowStart + x - bpp] : 0;
      const b = prevRowStart >= 0 ? unfiltered[prevRowStart + x] : 0;
      const c = prevRowStart >= 0 && x >= bpp ? unfiltered[prevRowStart + x - bpp] : 0;
      let value;
      switch (filterType) {
        case 0: value = rawByte; break;
        case 1: value = (rawByte + a) & 0xff; break;
        case 2: value = (rawByte + b) & 0xff; break;
        case 3: value = (rawByte + ((a + b) >> 1)) & 0xff; break;
        case 4: value = (rawByte + paethPredictor(a, b, c)) & 0xff; break;
        default:
          throw new ContractError(`unsupported PNG scanline filter type ${filterType} at row ${y} — the file may be corrupt`);
      }
      unfiltered[rowStart + x] = value;
    }
    rawOffset += stride;
    prevRowStart = rowStart;
  }

  const pixels = Buffer.alloc(ihdr.width * ihdr.height * 4);
  for (let y = 0; y < ihdr.height; y++) {
    for (let x = 0; x < ihdr.width; x++) {
      const srcIdx = y * stride + x * channels;
      const dstIdx = (y * ihdr.width + x) * 4;
      if (ihdr.colorType === 0) {
        const g = unfiltered[srcIdx];
        pixels[dstIdx] = g; pixels[dstIdx + 1] = g; pixels[dstIdx + 2] = g; pixels[dstIdx + 3] = 255;
      } else if (ihdr.colorType === 2) {
        pixels[dstIdx] = unfiltered[srcIdx]; pixels[dstIdx + 1] = unfiltered[srcIdx + 1]; pixels[dstIdx + 2] = unfiltered[srcIdx + 2]; pixels[dstIdx + 3] = 255;
      } else if (ihdr.colorType === 4) {
        const g = unfiltered[srcIdx];
        pixels[dstIdx] = g; pixels[dstIdx + 1] = g; pixels[dstIdx + 2] = g; pixels[dstIdx + 3] = unfiltered[srcIdx + 1];
      } else if (ihdr.colorType === 6) {
        pixels[dstIdx] = unfiltered[srcIdx]; pixels[dstIdx + 1] = unfiltered[srcIdx + 1]; pixels[dstIdx + 2] = unfiltered[srcIdx + 2]; pixels[dstIdx + 3] = unfiltered[srcIdx + 3];
      }
    }
  }
  return { width: ihdr.width, height: ihdr.height, pixels };
}

/** Composite RGBA onto a white background, dropping alpha → RGB8 buffer (3 bytes/px). */
function compositeOverWhite(pixels, width, height) {
  const rgb = Buffer.alloc(width * height * 3);
  for (let i = 0, p = 0; i < width * height; i++, p += 4) {
    const alpha = pixels[p + 3] / 255;
    const oi = i * 3;
    rgb[oi] = Math.round(pixels[p] * alpha + 255 * (1 - alpha));
    rgb[oi + 1] = Math.round(pixels[p + 1] * alpha + 255 * (1 - alpha));
    rgb[oi + 2] = Math.round(pixels[p + 2] * alpha + 255 * (1 - alpha));
  }
  return rgb;
}

const BLANK_RANGE_EPSILON = 4;

/** Blank predicate: per-channel (max-min) at-or-below BLANK_RANGE_EPSILON over the whole image. */
function isBlank(rgb) {
  let minR = 255, maxR = 0, minG = 255, maxG = 0, minB = 255, maxB = 0;
  for (let i = 0; i < rgb.length; i += 3) {
    const r = rgb[i], g = rgb[i + 1], b = rgb[i + 2];
    if (r < minR) minR = r;
    if (r > maxR) maxR = r;
    if (g < minG) minG = g;
    if (g > maxG) maxG = g;
    if (b < minB) minB = b;
    if (b > maxB) maxB = b;
  }
  return maxR - minR <= BLANK_RANGE_EPSILON && maxG - minG <= BLANK_RANGE_EPSILON && maxB - minB <= BLANK_RANGE_EPSILON;
}

const MIN_DIMENSION = 32;

/** Top-left letterbox: paste `rgb` (width x height) onto a white canvasW x canvasH buffer at (0,0). */
function letterboxOntoCanvas(rgb, width, height, canvasW, canvasH) {
  const out = Buffer.alloc(canvasW * canvasH * 3, 255);
  const rowBytes = width * 3;
  for (let y = 0; y < height; y++) {
    rgb.copy(out, y * canvasW * 3, y * rowBytes, y * rowBytes + rowBytes);
  }
  return out;
}

const TARGET_LONG_EDGE = 480;

/** Integer box-average downscale so the long edge is at most `targetLongEdge`; a no-op if already smaller. */
function resampleBoxAverage(rgb, width, height, targetLongEdge) {
  const longEdge = Math.max(width, height);
  if (longEdge <= targetLongEdge) return { rgb, width, height };
  const scale = targetLongEdge / longEdge;
  const outW = Math.max(1, Math.round(width * scale));
  const outH = Math.max(1, Math.round(height * scale));
  const out = Buffer.alloc(outW * outH * 3);
  for (let oy = 0; oy < outH; oy++) {
    const y0 = Math.floor((oy * height) / outH);
    const y1 = Math.max(y0 + 1, Math.floor(((oy + 1) * height) / outH));
    for (let ox = 0; ox < outW; ox++) {
      const x0 = Math.floor((ox * width) / outW);
      const x1 = Math.max(x0 + 1, Math.floor(((ox + 1) * width) / outW));
      let sr = 0, sg = 0, sb = 0, count = 0;
      for (let y = y0; y < y1 && y < height; y++) {
        for (let x = x0; x < x1 && x < width; x++) {
          const idx = (y * width + x) * 3;
          sr += rgb[idx]; sg += rgb[idx + 1]; sb += rgb[idx + 2];
          count++;
        }
      }
      const oi = (oy * outW + ox) * 3;
      out[oi] = Math.round(sr / count);
      out[oi + 1] = Math.round(sg / count);
      out[oi + 2] = Math.round(sb / count);
    }
  }
  return { rgb: out, width: outW, height: outH };
}

const EXCLUDE_REGION_MAX_FRACTION = 0.15;
const AA_TOLERANCE = 32;
const VISUAL_DIFF_MAJOR_THRESHOLD = 0.45; // hardcoded, not settings-overridable (out of scope, see plan)
// PROVISIONAL, pre-calibration default — set to roughly 2x the architect's
// measured normal-noise ceiling (~0.40) on the 0.65-0.80 directed range's
// midpoint. Override per-project via .cat/settings.json designQa.visualDiffBlockThreshold
// (valid range: strictly > VISUAL_DIFF_MAJOR_THRESHOLD, strictly < 1).
const VISUAL_DIFF_BLOCK_THRESHOLD = 0.75;
const VISUAL_SEVERITY_ORDINAL = { None: 0, Major: 1, Blocking: 2 };

// INVARIANT (does not need re-derivation if VISUAL_DIFF_BLOCK_THRESHOLD,
// EXCLUDE_REGION_MAX_FRACTION, or the designQa.visualDiffBlockThreshold
// override change): classifyVisualSeverity() decides Blocking from rawRatio
// ONLY (exclude_regions applied AFTER raw measurement is never read in that
// branch). So exclude_regions — 0 up to EXCLUDE_REGION_MAX_FRACTION, at ANY
// placement — can NEVER pull an item whose raw ratio is already
// >= blockThreshold down to Major or None, for ANY valid blockThreshold
// (including a low .cat/settings.json override such as 0.50). This is a
// constant-independent invariant, not an arithmetic example tied to the
// default 0.75 — see stage-11-revision.md Option P11-A. Only a DESCRIPTIVE
// number (the floor adjustedRatio can reach *inside* the Major band under a
// saturated 0.15 exclusion) depends on the constants' values, and that
// number is not a safety proof.

/** Round to 4 decimal places (ratios/fractions). */
function round4(v) {
  return Math.round(v * 10000) / 10000;
}

function clampInt(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

/**
 * Build a boolean exclusion mask over an outW x outH canvas from normalized
 * (0..1) rectangles, unioned (each pixel marked at most once regardless of
 * overlap count) — a single shared pixel set reused by the diff ratio,
 * excluded_fraction, AND hot_blocks (Options §5/§7 of the plan).
 */
function buildExcludeMask(regions, outW, outH) {
  const mask = new Uint8Array(outW * outH);
  for (const r of regions) {
    const x0 = clampInt(Math.round(r.x * outW), 0, outW);
    const y0 = clampInt(Math.round(r.y * outH), 0, outH);
    const x1 = clampInt(Math.round((r.x + r.w) * outW), 0, outW);
    const y1 = clampInt(Math.round((r.y + r.h) * outH), 0, outH);
    for (let y = Math.min(y0, y1); y < Math.max(y0, y1); y++) {
      const rowStart = y * outW;
      for (let x = Math.min(x0, x1); x < Math.max(x0, x1); x++) mask[rowStart + x] = 1;
    }
  }
  return mask;
}

/** Fixed 8x8 grid (64 cells) of {row, col, diff_pixels, total_pixels, excluded_pixels}. */
function computeHotBlocks(diffMask, excludeMask, outW, outH) {
  const GRID = 8;
  const blocks = [];
  for (let by = 0; by < GRID; by++) {
    const y0 = Math.floor((by * outH) / GRID);
    const y1 = Math.floor(((by + 1) * outH) / GRID);
    for (let bx = 0; bx < GRID; bx++) {
      const x0 = Math.floor((bx * outW) / GRID);
      const x1 = Math.floor(((bx + 1) * outW) / GRID);
      let diffPixels = 0, excludedPixels = 0, totalPixels = 0;
      for (let y = y0; y < y1; y++) {
        const rowStart = y * outW;
        for (let x = x0; x < x1; x++) {
          const idx = rowStart + x;
          totalPixels++;
          if (diffMask[idx]) diffPixels++;
          if (excludeMask && excludeMask[idx]) excludedPixels++;
        }
      }
      blocks.push({ row: by, col: bx, diff_pixels: diffPixels, total_pixels: totalPixels, excluded_pixels: excludedPixels });
    }
  }
  return blocks;
}

/**
 * Diff two decoded PNGs (already {width,height,pixels:RGBA8}). Returns BOTH
 * rawRatio (before exclude_regions) and adjustedRatio (after) — see the
 * INVARIANT comment above for why both must survive to the classifier.
 */
function computeVisualDiff(figma, impl, excludeRegions = []) {
  const canvasW = Math.max(figma.width, impl.width);
  const canvasH = Math.max(figma.height, impl.height);
  const figmaRgb = compositeOverWhite(figma.pixels, figma.width, figma.height);
  const implRgb = compositeOverWhite(impl.pixels, impl.width, impl.height);
  const figmaCanvas = letterboxOntoCanvas(figmaRgb, figma.width, figma.height, canvasW, canvasH);
  const implCanvas = letterboxOntoCanvas(implRgb, impl.width, impl.height, canvasW, canvasH);
  const figmaSmall = resampleBoxAverage(figmaCanvas, canvasW, canvasH, TARGET_LONG_EDGE);
  const implSmall = resampleBoxAverage(implCanvas, canvasW, canvasH, TARGET_LONG_EDGE);
  const outW = figmaSmall.width;
  const outH = figmaSmall.height;
  const n = outW * outH;

  const diffMask = new Uint8Array(n);
  let rawDiffCount = 0;
  for (let i = 0; i < n; i++) {
    const p = i * 3;
    const dr = Math.abs(figmaSmall.rgb[p] - implSmall.rgb[p]);
    const dg = Math.abs(figmaSmall.rgb[p + 1] - implSmall.rgb[p + 1]);
    const db = Math.abs(figmaSmall.rgb[p + 2] - implSmall.rgb[p + 2]);
    if (dr + dg + db > AA_TOLERANCE) {
      diffMask[i] = 1;
      rawDiffCount++;
    }
  }
  const rawRatio = n > 0 ? rawDiffCount / n : 0;

  let excludeMask = null;
  let excludedFraction = 0;
  let capped = false;
  let adjustedRatio = rawRatio;
  if (Array.isArray(excludeRegions) && excludeRegions.length > 0) {
    const candidateMask = buildExcludeMask(excludeRegions, outW, outH);
    let excludedCount = 0;
    for (let i = 0; i < n; i++) if (candidateMask[i]) excludedCount++;
    const candidateFraction = n > 0 ? excludedCount / n : 0;
    if (candidateFraction > EXCLUDE_REGION_MAX_FRACTION) {
      capped = true; // over cap → drop exclusions entirely and recompute on the full frame
    } else {
      excludeMask = candidateMask;
      excludedFraction = candidateFraction;
      let adjustedDiffCount = 0;
      let remaining = 0;
      for (let i = 0; i < n; i++) {
        if (excludeMask[i]) continue;
        remaining++;
        if (diffMask[i]) adjustedDiffCount++;
      }
      adjustedRatio = remaining > 0 ? adjustedDiffCount / remaining : 0;
    }
  }

  const hotBlocks = computeHotBlocks(diffMask, excludeMask, outW, outH);

  return {
    rawRatio,
    adjustedRatio,
    excludedFraction: round4(excludedFraction),
    capped,
    hotBlocks,
    canvasWidth: canvasW,
    canvasHeight: canvasH,
    sampledWidth: outW,
    sampledHeight: outH,
  };
}

/**
 * Three-band classification. rawRatio decides Blocking ALONE — adjustedRatio
 * is not even read in that branch — per the INVARIANT above (pass 11's fix
 * for the exclude_regions-vs-low-override bypass).
 */
function classifyVisualSeverity(rawRatio, adjustedRatio, majorThreshold, blockThreshold) {
  if (rawRatio >= blockThreshold) return "Blocking";
  if (adjustedRatio >= majorThreshold) return "Major";
  return "None";
}

/** Narrow single-key reader for .cat/settings.json (repo-scoped, sibling of .cat/graph/graph.db). */
function readSettingsFile(ctx) {
  const file = path.join(ctx.projectRoot, ".cat", "settings.json");
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return { present: false };
  }
  try {
    return { present: true, value: JSON.parse(raw) };
  } catch {
    return { present: true, malformed: true };
  }
}

/**
 * Resolve VISUAL_DIFF_BLOCK_THRESHOLD: a valid .cat/settings.json
 * designQa.visualDiffBlockThreshold override wins; file absence or a
 * present-but-unset key is normal (silent default, no audit); a present key
 * that is malformed/out-of-range falls back to the default AND reports
 * `invalid` so the caller audits once. Valid range: strictly greater than
 * VISUAL_DIFF_MAJOR_THRESHOLD, strictly less than 1.
 */
function resolveVisualDiffBlockThreshold(ctx) {
  const DEFAULT = { threshold: VISUAL_DIFF_BLOCK_THRESHOLD, source: "default (PROVISIONAL pre-calibration 0.75)" };
  const settings = readSettingsFile(ctx);
  if (!settings.present) return DEFAULT;
  if (settings.malformed) {
    return { ...DEFAULT, invalid: { raw: undefined, reason: ".cat/settings.json is not valid JSON" } };
  }
  const value = settings.value;
  const designQa = value && typeof value === "object" && !Array.isArray(value) ? value.designQa : undefined;
  if (!designQa || typeof designQa !== "object" || Array.isArray(designQa) || !Object.prototype.hasOwnProperty.call(designQa, "visualDiffBlockThreshold")) {
    return DEFAULT; // key not set — normal, no audit
  }
  const rawVal = designQa.visualDiffBlockThreshold;
  if (typeof rawVal === "number" && Number.isFinite(rawVal) && rawVal > VISUAL_DIFF_MAJOR_THRESHOLD && rawVal < 1) {
    return { threshold: rawVal, source: ".cat/settings.json designQa.visualDiffBlockThreshold" };
  }
  return {
    ...DEFAULT,
    invalid: { raw: rawVal, reason: `designQa.visualDiffBlockThreshold must be a number > ${VISUAL_DIFF_MAJOR_THRESHOLD} and < 1 (got ${JSON.stringify(rawVal)})` },
  };
}

/**
 * Load + structurally validate one PNG file for the visual gate: exists,
 * non-empty, PNG magic (JPEG explicitly rejected — the decoder is PNG-only
 * even though qa.artifacts' generic screenshot check accepts JPEG), decodes,
 * meets MIN_DIMENSION, and is non-blank. Returns {error} OR {width,height,
 * pixels,rgb} — never throws, so callers can fold `.error` into an errs[]
 * array (gate) or wrap it in a ContractError (CLI).
 */
function loadVisualPngFile(absPath, roleLabel) {
  let st;
  try {
    st = fs.statSync(absPath);
  } catch {
    return { error: `${roleLabel} "${absPath}" does not exist` };
  }
  if (!st.isFile() || st.size === 0) {
    return { error: `${roleLabel} "${absPath}" is not a non-empty file` };
  }
  const buf = fs.readFileSync(absPath);
  const isPng = buf.length >= 8 && buf.subarray(0, 8).equals(PNG_MAGIC);
  const isJpeg = buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  if (!isPng) {
    if (isJpeg) {
      return { error: `${roleLabel} "${absPath}" is a JPEG — the visual-diff decoder only supports PNG (pure-Node, no dependency); re-export/re-capture as PNG` };
    }
    return { error: `${roleLabel} "${absPath}" lacks PNG magic bytes` };
  }
  let decoded;
  try {
    decoded = decodePng(buf);
  } catch (err) {
    return { error: `${roleLabel} "${absPath}" failed to decode: ${err instanceof Error ? err.message : err}` };
  }
  if (decoded.width < MIN_DIMENSION || decoded.height < MIN_DIMENSION) {
    return { error: `${roleLabel} "${absPath}" is ${decoded.width}x${decoded.height} — both dimensions must be >= ${MIN_DIMENSION}px` };
  }
  const rgb = compositeOverWhite(decoded.pixels, decoded.width, decoded.height);
  if (isBlank(rgb)) {
    return { error: `${roleLabel} "${absPath}" is blank (every channel within ${BLANK_RANGE_EPSILON} of range across the whole image) — capture a real, non-blank render` };
  }
  return { width: decoded.width, height: decoded.height, pixels: decoded.pixels, rgb };
}

function parseExcludeRegions(value) {
  if (value === undefined || value === null) return { regions: [] };
  if (!Array.isArray(value)) return { error: "must be an array of {x,y,w,h} normalized (0..1) rectangles" };
  const regions = [];
  for (let i = 0; i < value.length; i++) {
    const r = value[i];
    if (!r || typeof r !== "object" || Array.isArray(r)) return { error: `[${i}] must be an object {x,y,w,h}` };
    for (const k of ["x", "y", "w", "h"]) {
      const v = r[k];
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1) {
        return { error: `[${i}].${k} must be a finite number in [0,1] (got ${JSON.stringify(v)})` };
      }
    }
    regions.push({ x: r.x, y: r.y, w: r.w, h: r.h });
  }
  return { regions };
}

function isRegisteredArtifact(p, artifacts, projectRoot) {
  const abs = path.isAbsolute(p) ? p : path.resolve(projectRoot, p);
  return artifacts.some((a) => {
    if (!a || typeof a.path !== "string") return false;
    const aAbs = path.isAbsolute(a.path) ? a.path : path.resolve(projectRoot, a.path);
    return aAbs === abs;
  });
}

/**
 * validateVisualGate(design, artifacts, ctx, goalId, designSource) — composed
 * ADDITIVELY into validateDesignGate, mirroring the numeric Critical/Major
 * waiver logic exactly (Blocking is un-waivable like numeric Critical; Major
 * is user-waivable via qa.design.waived + user_acknowledged; a submitted
 * severity more lenient than the server recompute is rejected —
 * recompute-authoritative, extended to BOTH rawRatio and adjustedRatio: the
 * server always recomputes both from the actual PNGs, never trusting
 * submitted raw_diff_ratio/diff_ratio for the severity decision).
 */
function validateVisualGate(design, artifacts, ctx, goalId, designSource) {
  const errs = [];
  const surfaces = Array.isArray(design.surfaces) ? design.surfaces : [];
  const declaredNames = new Set(surfaces.filter((s) => s && typeof s.name === "string").map((s) => s.name));
  if (declaredNames.size === 0) return errs; // surfaces already validated non-empty upstream; defensive no-op

  const visual = design.visual;
  if (!Array.isArray(visual)) {
    errs.push("qa.design.visual is missing — every declared surface requires a mechanical visual-diff result (qa.design.visual[]); the self-attested side-by-side checkbox alone is no longer sufficient");
    return errs;
  }

  const bySurface = new Map();
  visual.forEach((v, i) => {
    if (!v || typeof v !== "object" || Array.isArray(v)) {
      errs.push(`qa.design.visual[${i}] must be an object`);
      return;
    }
    if (typeof v.surface !== "string" || !declaredNames.has(v.surface)) {
      errs.push(`qa.design.visual[${i}].surface ${JSON.stringify(v.surface)} is not one of the declared surfaces`);
      return;
    }
    if (bySurface.has(v.surface)) {
      errs.push(`qa.design.visual has more than one entry for surface "${v.surface}" — exactly one is required`);
      return;
    }
    bySurface.set(v.surface, v);
  });
  if (errs.length) return errs;
  for (const name of declaredNames) {
    if (!bySurface.has(name)) errs.push(`qa.design surface "${name}" is missing a qa.design.visual[] entry — the mechanical visual-diff result is required`);
  }
  if (errs.length) return errs;

  const artifactList = Array.isArray(artifacts) ? artifacts : [];
  const projectRoot = ctx.projectRoot;
  const resolved = resolveVisualDiffBlockThreshold(ctx);
  if (resolved.invalid) {
    auditAppend(ctx, {
      category: "goal",
      verb: "design_visual_block_threshold_override_invalid",
      goal_id: goalId,
      raw: resolved.invalid.raw,
      reason: resolved.invalid.reason,
    });
  }
  const blockThreshold = resolved.threshold;
  const blockThresholdSource = resolved.source;

  const results = [];
  for (const [surface, v] of bySurface) {
    for (const [field, label] of [["figma_export", "figma_export"], ["impl_screenshot", "impl_screenshot"]]) {
      const val = v[field];
      if (typeof val !== "string" || !val.trim()) {
        errs.push(`qa.design.visual surface "${surface}" is missing ${label}`);
      }
    }
    if (typeof v.figma_export === "string" && v.figma_export.trim() && typeof v.impl_screenshot === "string" && v.impl_screenshot.trim()) {
      if (!isRegisteredArtifact(v.figma_export, artifactList, projectRoot)) {
        errs.push(`qa.design.visual surface "${surface}" figma_export "${v.figma_export}" is not registered in qa.artifacts`);
      }
      if (!isRegisteredArtifact(v.impl_screenshot, artifactList, projectRoot)) {
        errs.push(`qa.design.visual surface "${surface}" impl_screenshot "${v.impl_screenshot}" is not registered in qa.artifacts`);
      }
    }
  }
  if (errs.length) return errs;

  for (const [surface, v] of bySurface) {
    const figmaAbs = path.isAbsolute(v.figma_export) ? v.figma_export : path.resolve(projectRoot, v.figma_export);
    const implAbs = path.isAbsolute(v.impl_screenshot) ? v.impl_screenshot : path.resolve(projectRoot, v.impl_screenshot);
    const figmaLoaded = loadVisualPngFile(figmaAbs, "figma_export");
    if (figmaLoaded.error) { errs.push(`qa.design.visual surface "${surface}" ${figmaLoaded.error}`); continue; }
    const implLoaded = loadVisualPngFile(implAbs, "impl_screenshot");
    if (implLoaded.error) { errs.push(`qa.design.visual surface "${surface}" ${implLoaded.error}`); continue; }

    const excludeParsed = parseExcludeRegions(v.exclude_regions);
    if (excludeParsed.error) { errs.push(`qa.design.visual surface "${surface}" exclude_regions ${excludeParsed.error}`); continue; }

    const diff = computeVisualDiff(figmaLoaded, implLoaded, excludeParsed.regions);
    if (excludeParsed.regions.length > 0) {
      auditAppend(ctx, {
        category: "goal",
        verb: "design_visual_exclude_regions_applied",
        goal_id: goalId,
        surface,
        design_source: designSource,
        region_count: excludeParsed.regions.length,
        excluded_fraction: diff.excludedFraction,
        capped: diff.capped,
      });
    }
    const computed = classifyVisualSeverity(diff.rawRatio, diff.adjustedRatio, VISUAL_DIFF_MAJOR_THRESHOLD, blockThreshold);
    results.push({ surface, v, diff, computed });
  }
  if (errs.length) return errs;

  // Blocking is decided from rawRatio alone and sits OUTSIDE the waiver
  // system entirely — same code-shape as numeric Critical (cat-state.mjs
  // criticals block above): if any surface computes Blocking, refuse
  // immediately, audit every occurrence, and never reach the Major/waived path.
  const blocking = results.filter((r) => r.computed === "Blocking");
  if (blocking.length > 0) {
    for (const r of blocking) {
      auditAppend(ctx, {
        category: "goal",
        verb: "design_visual_blocking",
        goal_id: goalId,
        surface: r.surface,
        design_source: designSource,
        raw_diff_ratio: round4(r.diff.rawRatio),
        diff_ratio: round4(r.diff.adjustedRatio),
        block_threshold: blockThreshold,
        block_threshold_source: blockThresholdSource,
      });
      errs.push(
        `qa.design surface "${r.surface}" visual diff computes Blocking (raw_diff_ratio ${round4(r.diff.rawRatio)} [pre-exclude_regions], ` +
        `adjusted_diff_ratio ${round4(r.diff.adjustedRatio)} [post-exclude_regions, informational only], ` +
        `block threshold ${blockThreshold} [source ${blockThresholdSource}]) — Blocking is determined from the raw ratio before ` +
        `exclude_regions and can NEVER be waived or reduced by exclude_regions at any configured threshold. This indicates a grossly ` +
        `mismatched render (wrong page, broken/near-blank render, or totally different layout) rather than an imperfect-but-correct ` +
        `implementation. Verify the capture matches the intended surface and fix the render. If this project's UI is legitimately ` +
        `high-noise, raise designQa.visualDiffBlockThreshold in .cat/settings.json.`
      );
    }
    return errs;
  }

  // Recompute-authoritative: a submitted severity more lenient than the
  // server recompute is rejected outright (same SEVERITY_ORDINAL comparison
  // pattern as the numeric rows, using VISUAL_SEVERITY_ORDINAL here).
  for (const r of results) {
    const submitted = r.v.severity;
    if (typeof submitted !== "string" || !Object.prototype.hasOwnProperty.call(VISUAL_SEVERITY_ORDINAL, submitted)) {
      errs.push(`qa.design.visual surface "${r.surface}" severity ${JSON.stringify(submitted)} must be one of ${Object.keys(VISUAL_SEVERITY_ORDINAL).join(", ")}`);
      continue;
    }
    if (VISUAL_SEVERITY_ORDINAL[submitted] < VISUAL_SEVERITY_ORDINAL[r.computed]) {
      errs.push(`qa.design.visual surface "${r.surface}" submitted severity "${submitted}" is more lenient than the CLI-recomputed "${r.computed}" (raw_diff_ratio ${round4(r.diff.rawRatio)}, diff_ratio ${round4(r.diff.adjustedRatio)})`);
    }
  }
  if (errs.length) return errs;

  const majors = results.filter((r) => r.computed === "Major");
  if (majors.length > 0) {
    const waived = design.waived && typeof design.waived === "object" && !Array.isArray(design.waived) ? design.waived : null;
    if (!waived) {
      for (const r of majors) {
        errs.push(`qa.design surface "${r.surface}" visual diff computes Major (diff_ratio ${round4(r.diff.adjustedRatio)}) — resolve it, or record a user-acknowledged qa.design.waived`);
      }
      return errs;
    }
    if (!substantiveEvidence(waived.reason)) {
      errs.push(`qa.design.waived.reason must be substantive (>= ${MIN_EVIDENCE_WORDS} words, >= ${MIN_EVIDENCE_CHARS} chars, no placeholders)`);
    }
    if (waived.user_acknowledged !== true) {
      errs.push("qa.design.waived.user_acknowledged must be true — a Major may only be waived by explicit user acknowledgement (the agent may not self-waive)");
    }
    const waivedSurfaces = Array.isArray(waived.surfaces) ? waived.surfaces : [];
    for (const r of majors) {
      if (!waivedSurfaces.includes(r.surface)) {
        errs.push(`qa.design.waived does not list surface "${r.surface}" which carries a Major visual diff gap — every Major surface must be explicitly waived`);
      }
    }
    if (errs.length) return errs;
  }

  return errs;
}

// ------------------------------------------------------------ ultragoal utils

function ultragoalPaths(ctx) {
  const dir = path.join(ctx.root, "ultragoal");
  return {
    dir,
    brief: path.join(dir, "brief.md"),
    goals: path.join(dir, "goals.json"),
    ledger: path.join(dir, "ledger.jsonl"),
  };
}

function loadPlan(ctx) {
  const { goals } = ultragoalPaths(ctx);
  if (!fs.existsSync(goals)) {
    throw new ContractError("ultragoal/goals.json does not exist — run `goal init --brief <path|->` first");
  }
  const res = readJsonSafe(goals);
  if (!res.ok || !res.value || typeof res.value !== "object" || !Array.isArray(res.value.goals)) {
    throw new ContractError(`ultragoal/goals.json is unreadable or malformed — fail closed (${res.ok ? "missing goals[]" : res.error})`);
  }
  return res.value;
}

function findGoal(plan, goalId) {
  const goal = plan.goals.find((g) => g && g.id === goalId);
  if (!goal) throw new ContractError(`goal ${goalId} not found in ultragoal/goals.json`);
  return goal;
}

function chooseNextGoal(plan) {
  const goals = plan.goals.filter((g) => g && g.status !== "superseded");
  return goals.find((g) => g.status === "active")?.id ?? goals.find((g) => g.status === "pending")?.id ?? null;
}

function allComplete(plan) {
  const required = plan.goals.filter((g) => g && g.status !== "superseded");
  return required.length > 0 && required.every((g) => g.status === "complete");
}

/**
 * Receipt scheme v2 (D14): plan_generation_sha256 = sha256 over the canonical
 * goal row MINUS completion_receipt, computed AFTER the completion mutation
 * (status, completed_at, updated_at=verified_at). Verify recomputes over the
 * CURRENT row minus completion_receipt — any post-verification edit to any
 * goal-row field (title, completed_at, ...) fails verification.
 */
function goalRowSha256(goal) {
  const row = { ...goal };
  delete row.completion_receipt;
  return sha256hex(canonicalJson(row));
}

/** @goal column-0 delimiter (gjc-exact): boundary only when followed by `:`, whitespace, or EOL. */
const GOAL_DELIM = /^@goal(?::|[ \t]+|$)[ \t]*(.*)$/;

function parseBrief(text) {
  const lines = text.split(/\r?\n/);
  const preamble = [];
  const blocks = [];
  let current = null;
  for (const line of lines) {
    const m = GOAL_DELIM.exec(line);
    if (m) {
      current = { title: m[1].trim(), body: [] };
      blocks.push(current);
    } else if (current) {
      current.body.push(line);
    } else {
      preamble.push(line);
    }
  }

  if (blocks.length === 0) {
    const whole = text.trim();
    if (!whole) throw new ContractError("ultragoal brief is empty");
    const firstLine = whole.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0);
    return { preamble: "", goals: [{ title: firstLine, objective: whole }] };
  }

  const goals = blocks.map((b, i) => {
    let title = b.title;
    let objective = b.body.join("\n").trim();
    if (!title && objective) {
      const idx = b.body.findIndex((l) => l.trim().length > 0);
      title = b.body[idx].trim();
      const rest = b.body.slice(idx + 1).join("\n").trim();
      objective = rest || title;
    } else if (title && !objective) {
      objective = title;
    } else if (!title && !objective) {
      throw new ContractError(`ultragoal @goal block ${i + 1} has no title or objective`);
    }
    return { title, objective };
  });

  return { preamble: preamble.join("\n").trim(), goals };
}

function appendLedgerEvent(ctx, event) {
  const { ledger } = ultragoalPaths(ctx);
  // D15: mint AFTER spreading the caller event so falsy/empty caller values
  // (e.g. event_id: "") can never erase the minted UUID.
  const row = {
    ...event,
    event_id: typeof event.event_id === "string" && event.event_id ? event.event_id : randomUUID(),
    ts: typeof event.ts === "string" && event.ts ? event.ts : nowIso(),
  };
  appendJsonl(ledger, row);
  return row;
}

// ----------------------------------------------------------------- commands

function cmdInit(ctx) {
  for (const dir of ["state", "specs", path.join("plans", "ralplan"), "ultragoal"]) {
    fs.mkdirSync(path.join(ctx.root, dir), { recursive: true });
  }
  touchActivity(ctx);
  printJson({ ok: true, session_root: rel(ctx, ctx.root) });
}

function cmdStateRead(ctx, flags) {
  if (flags.skill) {
    const skill = requireSkill(flags);
    const res = readJsonSafe(statePath(ctx, skill));
    printJson(res.ok ? res.value : {});
    return;
  }
  const out = {};
  for (const skill of SKILLS) {
    const file = statePath(ctx, skill);
    if (!fs.existsSync(file)) {
      out[skill] = null;
      continue;
    }
    const res = readJsonSafe(file);
    out[skill] = res.ok ? res.value : { skill, corrupt: true, error: res.error };
  }
  printJson(out);
}

async function cmdStateWrite(ctx, flags) {
  const skill = requireSkill(flags);
  if (flags.json === undefined) throw new UsageError("state write requires --json <str|->");
  const rawJson = flags.json === "-" ? await readStdin() : flags.json;

  let incoming;
  try {
    incoming = JSON.parse(rawJson);
  } catch (err) {
    refuse(
      ctx,
      { category: "state", verb: "invalid_envelope", skill, reason: "unparseable --json" },
      `invalid envelope: --json is not valid JSON (${err.message})`
    );
  }
  if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) {
    refuse(
      ctx,
      { category: "state", verb: "invalid_envelope", skill, reason: "envelope must be a JSON object" },
      "invalid envelope: --json must be a JSON object"
    );
  }
  if (incoming.skill !== undefined && incoming.skill !== skill) {
    refuse(
      ctx,
      { category: "state", verb: "invalid_envelope", skill, reason: `envelope skill "${incoming.skill}" != --skill "${skill}"` },
      `invalid envelope: json.skill "${incoming.skill}" does not match --skill "${skill}"`
    );
  }

  const file = statePath(ctx, skill);
  const existingRes = fs.existsSync(file) ? readJsonSafe(file) : { ok: false, error: "missing" };
  const existing = existingRes.ok && existingRes.value && typeof existingRes.value === "object" ? existingRes.value : null;

  const merged = { ...(existing ?? {}), ...incoming };
  merged.skill = skill;

  if (typeof merged.active !== "boolean") {
    refuse(
      ctx,
      { category: "state", verb: "invalid_envelope", skill, reason: "active must be boolean" },
      "invalid envelope: `active` must be a boolean"
    );
  }
  if (typeof merged.current_phase !== "string" || !merged.current_phase.trim()) {
    refuse(
      ctx,
      { category: "state", verb: "invalid_envelope", skill, reason: "current_phase must be a non-empty string" },
      "invalid envelope: `current_phase` must be a non-empty string"
    );
  }

  // Phase + edge validation (deactivation writes are exempt, gjc-parity).
  if (merged.active === true) {
    const edges = PHASE_EDGES[skill];
    const to = merged.current_phase;
    if (!edges[to]) {
      refuse(
        ctx,
        { category: "state", verb: "invalid_transition", skill, from_phase: existing?.current_phase ?? null, to_phase: to, reason: "unknown phase" },
        `invalid phase: "${to}" is not a known ${skill} phase (${Object.keys(edges).join(" → ")})`
      );
    }
    const from = existing && existing.active === true && typeof existing.current_phase === "string" ? existing.current_phase : null;
    if (from === null) {
      if (to !== INITIAL_PHASE[skill]) {
        refuse(
          ctx,
          { category: "state", verb: "invalid_transition", skill, from_phase: null, to_phase: to, reason: "fresh activation must start at the initial phase" },
          `invalid phase edge: fresh ${skill} activation must start at "${INITIAL_PHASE[skill]}" (got "${to}")`
        );
      }
    } else if (edges[from] && !edges[from].includes(to)) {
      refuse(
        ctx,
        { category: "state", verb: "invalid_transition", skill, from_phase: from, to_phase: to, reason: "edge not in §3 phase table" },
        `invalid phase edge: ${skill} "${from}" → "${to}" is not allowed (valid from "${from}": ${edges[from].join(", ")})`
      );
    }
    // Corrupt/unknown prior phase: skip edge check (fail open on prior), `to` already validated.
  }

  let floorInfo = null;
  if (skill === "deep-interview") {
    if (merged.active === true) {
      const reason = validateTriggerConsistency(merged);
      if (reason) {
        refuse(ctx, { category: "state", verb: "trigger_consistency_refused", skill, reason }, reason);
      }
    }
    floorInfo = applyAmbiguityFloor(merged, incoming);
  }

  // Team task board mirror: DESIGN §6 names state/team-board.json and G1 routes all
  // state/** writes through this CLI — a `board` field on the team envelope is
  // mirrored to that file.
  let boardPath = null;
  if (skill === "team" && merged.board && typeof merged.board === "object") {
    boardPath = path.join(ctx.root, "state", "team-board.json");
    writeJsonFile(boardPath, merged.board);
  }

  merged.updated_at = nowIso();
  merged.state_revision = (existing && isFiniteNum(existing.state_revision) ? existing.state_revision : 0) + 1;
  delete merged.content_sha256;
  merged.content_sha256 = sha256hex(canonicalJson(merged));

  writeJsonFile(file, merged);
  touchActivity(ctx, skill);

  const receipt = {
    ok: true,
    skill,
    state_path: rel(ctx, file),
    state_revision: merged.state_revision,
    active: merged.active,
    current_phase: merged.current_phase,
    updated_at: merged.updated_at,
    content_sha256: merged.content_sha256,
  };
  if (skill === "deep-interview") {
    receipt.ambiguity_floor = floorInfo;
    if (isFiniteNum(merged.current_ambiguity)) receipt.current_ambiguity = merged.current_ambiguity;
    if (isFiniteNum(merged.reported_ambiguity)) receipt.reported_ambiguity = merged.reported_ambiguity;
  }
  if (boardPath) receipt.board_path = rel(ctx, boardPath);
  printJson(receipt);
}

function cmdStateClear(ctx, flags) {
  const skill = requireSkill(flags);
  const file = statePath(ctx, skill);
  const existingRes = fs.existsSync(file) ? readJsonSafe(file) : { ok: false };
  const existing = existingRes.ok && existingRes.value && typeof existingRes.value === "object" ? existingRes.value : {};
  const sentinel = {
    ...existing,
    skill,
    active: false,
    current_phase: "complete",
    updated_at: nowIso(),
    state_revision: (isFiniteNum(existing.state_revision) ? existing.state_revision : 0) + 1,
  };
  delete sentinel.content_sha256;
  sentinel.content_sha256 = sha256hex(canonicalJson(sentinel));
  writeJsonFile(file, sentinel);
  touchActivity(ctx, skill);
  printJson({
    ok: true,
    skill,
    state_path: rel(ctx, file),
    active: false,
    current_phase: "complete",
    state_revision: sentinel.state_revision,
  });
}

async function cmdArtifactWrite(ctx, flags) {
  const workflow = flags.workflow;
  if (!workflow) throw new UsageError("artifact write requires --workflow ralplan");
  if (workflow !== "ralplan") throw new ContractError(`unknown workflow "${workflow}" — only "ralplan" is supported`);
  const runId = flags.run;
  if (!runId) throw new UsageError("artifact write requires --run <id>");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(runId) || runId.includes("..")) {
    throw new ContractError(`invalid --run id "${runId}"`);
  }
  const stageArg = flags.stage;
  if (!stageArg) throw new UsageError("artifact write requires --stage <NN>-<name>");
  const m = /^(\d{1,3})-([a-z0-9][a-z0-9_-]*)$/i.exec(stageArg);
  if (!m) throw new ContractError(`invalid --stage "${stageArg}" — expected <NN>-<name> (e.g. 01-planner)`);
  const stageN = parseInt(m[1], 10);
  const stage = m[2];
  const nn = String(stageN).padStart(2, "0");
  if (flags.file === undefined) throw new UsageError("artifact write requires --file <path|->");
  const content = flags.file === "-" ? await readStdin() : fs.readFileSync(path.resolve(ctx.projectRoot, flags.file), "utf8");

  const sha = sha256hex(content);
  const runDir = path.join(ctx.root, "plans", "ralplan", runId);
  const indexPath = path.join(runDir, "index.jsonl");
  const filePath = path.join(runDir, `stage-${nn}-${stage}.md`);
  const rows = readJsonlSafe(indexPath);
  const match = rows.find((r) => r && r.stage === stage && r.stage_n === stageN);

  if (match) {
    if (match.sha256 === sha) {
      // dedup by (stage, stage_n) + sha256 — idempotent re-write, no new row
      touchActivity(ctx, "ralplan");
      printJson({ ok: true, workflow, run_id: runId, stage, stage_n: stageN, path: match.path, sha256: sha, created_at: match.created_at, deduped: true });
      return;
    }
    refuse(
      ctx,
      { category: "artifact", verb: "rewrite_refused", workflow, run_id: runId, stage, stage_n: stageN, reason: `existing sha256 ${match.sha256} != new ${sha}` },
      `refusing different-content rewrite of ralplan stage (${stage}, ${stageN}) — existing sha256 ${match.sha256}, new ${sha}. Use the next stage_n instead.`
    );
  }

  const createdAt = nowIso();
  atomicWrite(filePath, content);
  const row = { stage, stage_n: stageN, path: rel(ctx, filePath), created_at: createdAt, sha256: sha };
  appendJsonl(indexPath, row);

  const receipt = { ok: true, workflow, run_id: runId, ...row };
  if (stage === "final") {
    const pending = path.join(runDir, "pending-approval.md");
    atomicWrite(pending, content);
    receipt.pending_approval_path = rel(ctx, pending);
  }
  touchActivity(ctx, "ralplan");
  printJson(receipt);
}

async function cmdGoalInit(ctx, flags) {
  if (flags.brief === undefined) throw new UsageError("goal init requires --brief <path|->");
  const briefText = flags.brief === "-" ? await readStdin() : fs.readFileSync(path.resolve(ctx.projectRoot, flags.brief), "utf8");

  const paths = ultragoalPaths(ctx);
  if (fs.existsSync(paths.goals)) {
    refuse(
      ctx,
      { category: "goal", verb: "init_refused", reason: "goals.json already exists" },
      "ultragoal/goals.json already exists — refusing to overwrite an existing plan (clear the session dir to restart)"
    );
  }

  const { preamble, goals: parsed } = parseBrief(briefText);
  const createdAt = nowIso();
  const goals = parsed.map((g, i) => ({
    id: `G${String(i + 1).padStart(3, "0")}`,
    title: g.title,
    objective: g.objective,
    status: "pending",
    created_at: createdAt,
    updated_at: createdAt,
  }));

  atomicWrite(paths.brief, briefText.endsWith("\n") ? briefText : briefText + "\n");
  const plan = { version: 1, brief: preamble, goals, created_at: createdAt, updated_at: createdAt };
  writeJsonFile(paths.goals, plan);
  const event = appendLedgerEvent(ctx, {
    event: "plan_created",
    goal_count: goals.length,
    goal_ids: goals.map((g) => g.id),
  });
  touchActivity(ctx, "ultragoal");
  printJson({
    ok: true,
    goals_path: rel(ctx, paths.goals),
    brief_path: rel(ctx, paths.brief),
    goal_count: goals.length,
    goals: goals.map((g) => ({ id: g.id, title: g.title })),
    ledger_event_id: event.event_id,
  });
}

async function cmdGoalCheckpoint(ctx, flags) {
  const goalId = flags.goal;
  if (!goalId) throw new UsageError("goal checkpoint requires --goal GNNN");
  if (!/^G\d{3,}$/.test(goalId)) throw new UsageError(`invalid --goal "${goalId}" — expected GNNN (e.g. G001)`);
  const status = flags.status;
  if (!status) throw new UsageError("goal checkpoint requires --status <s>");
  if (!GOAL_STATUSES.includes(status)) {
    throw new ContractError(`unknown status "${status}" — must be one of: ${GOAL_STATUSES.join(", ")}`);
  }

  const plan = loadPlan(ctx);
  const goal = findGoal(plan, goalId);
  const paths = ultragoalPaths(ctx);

  if (status !== "complete") {
    if (goal.status === "complete") {
      refuse(
        ctx,
        { category: "goal", verb: "checkpoint_refused", goal_id: goalId, reason: `cannot move a complete goal to "${status}"` },
        `goal ${goalId} is already complete — completed goals cannot be re-checkpointed to "${status}"`
      );
    }
    const ts = nowIso();
    goal.status = status;
    goal.updated_at = ts;
    plan.updated_at = ts;
    const event = appendLedgerEvent(ctx, { event: "goal_checkpointed", goal_id: goalId, status, ts });
    writeJsonFile(paths.goals, plan);
    touchActivity(ctx, "ultragoal");
    printJson({
      ok: true,
      goal_id: goalId,
      status,
      ledger_event_id: event.event_id,
      next_goal: chooseNextGoal(plan),
      all_complete: allComplete(plan),
    });
    return;
  }

  // --status complete: fail-closed quality gate + receipt minting
  let gate = null;
  if (flags["quality-gate-json"] !== undefined) {
    const rawGate = flags["quality-gate-json"] === "-" ? await readStdin() : fs.readFileSync(path.resolve(ctx.projectRoot, flags["quality-gate-json"]), "utf8");
    try {
      gate = JSON.parse(rawGate);
    } catch (err) {
      refuse(
        ctx,
        { category: "goal", verb: "quality_gate_refused", goal_id: goalId, reason: "unparseable quality gate JSON" },
        `quality gate is not valid JSON (${err.message})`
      );
    }
  }

  if (goal.status === "complete") {
    const receipt = goal.completion_receipt;
    if (gate && receipt && sha256hex(canonicalJson(gate)) === receipt.quality_gate_sha256) {
      // idempotent duplicate checkpoint — dedup against the existing receipt
      printJson({ ok: true, goal_id: goalId, status: "complete", receipt, deduped: true, next_goal: chooseNextGoal(plan), all_complete: allComplete(plan) });
      return;
    }
    refuse(
      ctx,
      { category: "goal", verb: "checkpoint_refused", goal_id: goalId, reason: "re-checkpoint of a complete goal with different evidence" },
      `goal ${goalId} is already complete — re-checkpointing with different evidence is refused`
    );
  }
  if (!(goal.status === "active" || goal.status === "failed")) {
    refuse(
      ctx,
      { category: "goal", verb: "checkpoint_refused", goal_id: goalId, reason: `complete requires prior status active|failed (was "${goal.status}")` },
      `goal ${goalId} is "${goal.status}" — start the goal before completing it (checkpoint --status active first)`
    );
  }
  if (!gate) {
    refuse(
      ctx,
      { category: "goal", verb: "quality_gate_refused", goal_id: goalId, reason: "--status complete without --quality-gate-json" },
      "--status complete REQUIRES --quality-gate-json <path|-> — the completion quality gate is fail-closed"
    );
  }
  const errs = validateQualityGate(gate, ctx, goalId);
  if (errs.length > 0) {
    refuse(
      ctx,
      { category: "goal", verb: "quality_gate_refused", goal_id: goalId, reasons: errs },
      `quality gate failed:\n  - ${errs.join("\n  - ")}`
    );
  }

  const verifiedAt = nowIso();
  const qualityGateSha = sha256hex(canonicalJson(gate));
  const statusBefore = goal.status;

  // Receipt scheme v2 (D14): mutate the goal row FIRST, then hash the row
  // minus completion_receipt so the receipt covers every completed-row field.
  goal.status = "complete";
  goal.completed_at = verifiedAt;
  goal.updated_at = verifiedAt; // receipt freshness anchor: updated_at === verified_at
  delete goal.completion_receipt;
  const planGeneration = goalRowSha256(goal);

  const event = appendLedgerEvent(ctx, {
    event: "goal_checkpointed",
    goal_id: goalId,
    status: "complete",
    goal_status_before: statusBefore,
    quality_gate: gate,
    quality_gate_sha256: qualityGateSha,
    plan_generation_sha256: planGeneration,
    verified_at: verifiedAt,
    ts: verifiedAt,
  });

  const receipt = {
    plan_generation_sha256: planGeneration,
    quality_gate_sha256: qualityGateSha,
    ledger_event_id: event.event_id,
    verified_at: verifiedAt,
  };
  goal.completion_receipt = receipt;
  plan.updated_at = verifiedAt;
  writeJsonFile(paths.goals, plan);
  touchActivity(ctx, "ultragoal");
  printJson({
    ok: true,
    goal_id: goalId,
    status: "complete",
    receipt,
    next_goal: chooseNextGoal(plan),
    all_complete: allComplete(plan),
  });
}

async function cmdLedgerAppend(ctx, flags) {
  if (flags.json === undefined) throw new UsageError("ledger append requires --json <str|->");
  const raw = flags.json === "-" ? await readStdin() : flags.json;
  let event;
  try {
    event = JSON.parse(raw);
  } catch (err) {
    throw new ContractError(`ledger event is not valid JSON (${err.message})`);
  }
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    throw new ContractError("ledger event must be a JSON object");
  }
  if (typeof event.event !== "string" || !event.event.trim()) {
    throw new ContractError('ledger event requires a non-empty "event" field');
  }
  const row = appendLedgerEvent(ctx, event);
  touchActivity(ctx, "ultragoal");
  printJson({ ok: true, event: row.event, event_id: row.event_id, ts: row.ts, ledger_path: rel(ctx, ultragoalPaths(ctx).ledger) });
}

/**
 * dialogue append (G004): sanctioned CLI path to append a dialogue-excerpt
 * row to state/dialogue-excerpts.jsonl — the append-only sibling of
 * `ledger append`, but scoped to state/** (auto-protected by G1) rather than
 * ultragoal/. The hook (hooks/cat-hook.mjs) is the primary writer via its own
 * sanctioned inline writes (dispatch capture + subagentstop reply capture,
 * mirroring audit.jsonl); this subcommand is the CLI-accessible alternative.
 */
async function cmdDialogueAppend(ctx, flags) {
  if (flags.json === undefined) throw new UsageError("dialogue append requires --json <str|->");
  const raw = flags.json === "-" ? await readStdin() : flags.json;
  let entry;
  try {
    entry = JSON.parse(raw);
  } catch (err) {
    throw new ContractError(`dialogue entry is not valid JSON (${err.message})`);
  }
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new ContractError("dialogue entry must be a JSON object");
  }
  if (entry.role !== "dispatch" && entry.role !== "reply") {
    throw new ContractError('dialogue entry requires "role" to be "dispatch" or "reply"');
  }
  const file = path.join(ctx.root, "state", "dialogue-excerpts.jsonl");
  appendJsonl(file, entry);
  touchActivity(ctx);
  printJson({ ok: true, path: rel(ctx, file), role: entry.role });
}

function cmdFloor(ctx) {
  const res = readJsonSafe(statePath(ctx, "deep-interview"));
  const state = res.ok ? res.value : {};
  const { floor, parts } = computeFloor(state);
  printJson({ floor, parts });
}

function cmdReceiptVerify(ctx, flags) {
  const goalId = flags.goal;
  if (!goalId) throw new UsageError("receipt verify requires --goal GNNN");

  const plan = loadPlan(ctx);
  const goal = findGoal(plan, goalId);
  const receipt = goal.completion_receipt;
  if (!receipt || typeof receipt !== "object") {
    throw new ContractError(`goal ${goalId} has no completion receipt — not verified complete`);
  }
  for (const field of ["plan_generation_sha256", "quality_gate_sha256", "ledger_event_id", "verified_at"]) {
    if (typeof receipt[field] !== "string" || !receipt[field]) {
      throw new ContractError(`goal ${goalId} receipt is malformed — missing ${field}`);
    }
  }
  if (goal.status !== "complete") {
    throw new ContractError(`goal ${goalId} carries a completion receipt but status is "${goal.status}" — tampered or stale`);
  }
  if (goal.updated_at !== receipt.verified_at) {
    throw new ContractError(`goal ${goalId} row was touched after verification (updated_at ${goal.updated_at} != verified_at ${receipt.verified_at}) — stale receipt`);
  }

  const rows = readJsonlSafe(ultragoalPaths(ctx).ledger);
  const row = rows.find(
    (r) =>
      r &&
      r.event === "goal_checkpointed" &&
      r.event_id === receipt.ledger_event_id &&
      r.goal_id === goalId &&
      r.status === "complete"
  );
  if (!row) {
    throw new ContractError(`goal ${goalId} receipt is not anchored — no matching goal_checkpointed ledger event ${receipt.ledger_event_id}`);
  }
  if (row.quality_gate_sha256 !== receipt.quality_gate_sha256) {
    throw new ContractError(`goal ${goalId} quality gate hash mismatch between receipt and ledger row — tampered`);
  }
  if (sha256hex(canonicalJson(row.quality_gate)) !== receipt.quality_gate_sha256) {
    throw new ContractError(`goal ${goalId} ledger quality gate content does not hash to the receipt — dirty quality gate`);
  }
  // Receipt scheme v2 (D14): recompute over the CURRENT goal row minus
  // completion_receipt — any post-verification edit to any field fails here.
  const recomputed = goalRowSha256(goal);
  if (recomputed !== receipt.plan_generation_sha256 || row.plan_generation_sha256 !== receipt.plan_generation_sha256) {
    throw new ContractError(`goal ${goalId} plan generation mismatch — goals.json was tampered with or the receipt is stale`);
  }

  printJson({ ok: true, goal_id: goalId, receipt });
}

// ---------------------------------------------------- design diff (QA lane aid)

/**
 * `design diff` — mechanical Figma↔implementation measurement diff, the
 * authoring aid behind `skills/ultragoal/references/design-qa.md`'s
 * "two-numbers rule" and "no sampling" doctrine.
 *
 * It joins the extracted Figma sized-node INVENTORY (`--figma`) against the
 * LIVE-DOM computed measurements (`--impl`) by (surface, element, property) and
 * mechanically:
 *  - emits gate-ready `qa.design.rows` ONLY for fully-paired, well-formed pairs,
 *    with severity computed by the SAME `computeSeverity()` the checkpoint gate
 *    uses (the diff tool and the gate can never disagree);
 *  - reports `unmeasured` (a Figma spec with NO impl counterpart — a node that
 *    was extracted but not measured; this is exactly where a mismatch would
 *    otherwise be GUESSED, e.g. the 40px section-box proxy), `unexpected` (an
 *    impl measurement with no Figma spec), and `malformed` (a pair whose values
 *    don't parse or use an unknown property);
 *  - refuses (`ok:false`, exit 2) when ANY `unmeasured` or `malformed` entry
 *    exists — the mechanical form of "no row, no claim, without BOTH
 *    figma_expected AND impl_actual". Real Critical/Major gaps on well-formed
 *    pairs are NOT a tool error (they are legitimate findings the leader routes
 *    to fix/waive at checkpoint) → `ok:true`, exit 0, surfaced in `summary`.
 *
 * This is the closest a zero-dependency verifier can get to closing the
 * documented per-element coverage residual: it cannot force the agent to
 * extract a COMPLETE inventory, but once a node is on the `--figma` inventory it
 * can no longer be silently dropped — every extracted sized node must carry a
 * measured counterpart or the diff stays red.
 */
async function cmdDesignDiff(ctx, flags) {
  if (flags.figma === undefined || flags.impl === undefined) {
    throw new UsageError("design diff requires --figma <path|-> and --impl <path|->");
  }
  if (flags.figma === "-" && flags.impl === "-") {
    throw new UsageError("design diff: only one of --figma/--impl may read stdin (-)");
  }
  const readManifest = async (val, label) => {
    const raw = val === "-" ? await readStdin() : fs.readFileSync(path.resolve(ctx.projectRoot, val), "utf8");
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new ContractError(`--${label} is not valid JSON (${err.message})`);
    }
    if (!Array.isArray(parsed)) throw new ContractError(`--${label} must be a JSON array of measurement rows`);
    return parsed;
  };
  const figma = await readManifest(flags.figma, "figma");
  const impl = await readManifest(flags.impl, "impl");

  const keyOf = (e) =>
    `${String(e.surface ?? "").trim()} ${String(e.element ?? "").trim()} ${String(e.property ?? "").toLowerCase().trim()}`;

  const errs = [];
  const index = (list, label, valueKey) => {
    const map = new Map();
    list.forEach((e, i) => {
      if (!e || typeof e !== "object" || Array.isArray(e)) {
        errs.push(`--${label}[${i}] must be an object`);
        return;
      }
      for (const req of ["surface", "element", "property", valueKey]) {
        if (typeof e[req] !== "string" || !e[req].trim()) {
          errs.push(`--${label}[${i}] is missing a non-empty "${req}"`);
        }
      }
      const k = keyOf(e);
      if (map.has(k)) {
        errs.push(`--${label} has a duplicate (surface,element,property) key ${JSON.stringify([e.surface, e.element, e.property])}`);
        return;
      }
      map.set(k, e);
    });
    return map;
  };
  const figmaMap = index(figma, "figma", "figma_expected");
  const implMap = index(impl, "impl", "impl_actual");
  if (errs.length) throw new ContractError(errs.join("; "));

  const rows = [];
  const unmeasured = [];
  const unexpected = [];
  const malformed = [];
  const bySeverity = { Critical: 0, Major: 0, Minor: 0, Trivial: 0, None: 0 };

  for (const [k, fe] of figmaMap) {
    const ie = implMap.get(k);
    if (!ie) {
      unmeasured.push({ surface: fe.surface, element: fe.element, property: fe.property, figma_expected: fe.figma_expected });
      continue;
    }
    const property = String(fe.property).toLowerCase().trim();
    const severity = computeSeverity(property, fe.figma_expected, ie.impl_actual);
    if (severity === UNPARSEABLE) {
      malformed.push({ surface: fe.surface, element: fe.element, property: fe.property, figma_expected: fe.figma_expected, impl_actual: ie.impl_actual });
      continue;
    }
    rows.push({ surface: fe.surface, element: fe.element, property, figma_expected: fe.figma_expected, impl_actual: ie.impl_actual, severity });
    bySeverity[severity] += 1;
  }
  for (const [k, ie] of implMap) {
    if (!figmaMap.has(k)) {
      unexpected.push({ surface: ie.surface, element: ie.element, property: ie.property, impl_actual: ie.impl_actual });
    }
  }

  const ready = unmeasured.length === 0 && malformed.length === 0;
  printJson({
    ok: ready,
    rows,
    unmeasured,
    unexpected,
    malformed,
    summary: {
      figma_nodes: figmaMap.size,
      impl_nodes: implMap.size,
      paired: rows.length,
      unmeasured: unmeasured.length,
      unexpected: unexpected.length,
      malformed: malformed.length,
      by_severity: bySeverity,
      blocking: bySeverity.Critical + bySeverity.Major,
    },
  });
  if (!ready) process.exit(EXIT_CONTRACT);
}

// ------------------------------------------------ design visual (QA lane aid)

/**
 * `design visual` — standalone diagnostic for the mechanical visual (pixel)
 * diff behind the checkpoint gate's qa.design.visual[]. Decodes --figma and
 * --impl as PNG files directly (no qa.artifacts registration requirement —
 * that check only applies inside the checkpoint gate's validateVisualGate),
 * runs the SAME computeVisualDiff/classifyVisualSeverity functions the gate
 * uses (single shared code path — the diagnostic and the gate can never
 * disagree), and prints the full result including BOTH raw_diff_ratio
 * (pre-exclude_regions) and diff_ratio (post-exclude_regions).
 *
 * --block-threshold is a DIAGNOSTIC-ONLY override (lets an agent preview a
 * candidate .cat/settings.json value before writing it); when omitted, the
 * threshold is resolved via the exact same resolveVisualDiffBlockThreshold(ctx)
 * the checkpoint gate calls, so the printed block_threshold/source matches
 * what the gate would actually enforce.
 */
async function cmdDesignVisual(ctx, flags) {
  if (flags.figma === undefined || flags.impl === undefined) {
    throw new UsageError("design visual requires --figma <path> and --impl <path> (PNG files)");
  }
  const majorThreshold = flags["major-threshold"] !== undefined ? Number(flags["major-threshold"]) : VISUAL_DIFF_MAJOR_THRESHOLD;
  if (!Number.isFinite(majorThreshold)) throw new UsageError("--major-threshold must be a number");

  let blockThreshold;
  let blockThresholdSource;
  if (flags["block-threshold"] !== undefined) {
    const v = Number(flags["block-threshold"]);
    if (!Number.isFinite(v)) throw new UsageError("--block-threshold must be a number");
    blockThreshold = v;
    blockThresholdSource = "--block-threshold (diagnostic override, not settings.json)";
  } else {
    const resolved = resolveVisualDiffBlockThreshold(ctx);
    blockThreshold = resolved.threshold;
    blockThresholdSource = resolved.source;
  }

  let excludeRegions = [];
  if (flags.exclude !== undefined) {
    let parsedJson;
    try {
      parsedJson = JSON.parse(flags.exclude);
    } catch (err) {
      throw new ContractError(`--exclude is not valid JSON (${err.message})`);
    }
    const parsed = parseExcludeRegions(parsedJson);
    if (parsed.error) throw new ContractError(`--exclude ${parsed.error}`);
    excludeRegions = parsed.regions;
  }

  const figmaAbs = path.resolve(ctx.projectRoot, flags.figma);
  const implAbs = path.resolve(ctx.projectRoot, flags.impl);
  const figmaLoaded = loadVisualPngFile(figmaAbs, "figma_export");
  if (figmaLoaded.error) throw new ContractError(figmaLoaded.error);
  const implLoaded = loadVisualPngFile(implAbs, "impl_screenshot");
  if (implLoaded.error) throw new ContractError(implLoaded.error);

  const diff = computeVisualDiff(figmaLoaded, implLoaded, excludeRegions);
  const severity = classifyVisualSeverity(diff.rawRatio, diff.adjustedRatio, majorThreshold, blockThreshold);

  printJson({
    ok: true,
    figma_export: flags.figma,
    impl_screenshot: flags.impl,
    raw_diff_ratio: round4(diff.rawRatio),
    diff_ratio: round4(diff.adjustedRatio),
    severity,
    major_threshold: majorThreshold,
    block_threshold: blockThreshold,
    block_threshold_source: blockThresholdSource,
    excluded_fraction: diff.excludedFraction,
    capped: diff.capped,
    hot_blocks: diff.hotBlocks,
    canvas: { width: diff.canvasWidth, height: diff.canvasHeight },
    sampled: { width: diff.sampledWidth, height: diff.sampledHeight },
  });
}

// ------------------------------------------------------------- graph (WS2)
//
// `graph build` / `graph query` are the ONLY subcommands that import
// node:sqlite or the vendored web-tree-sitter WASM runtime under
// scripts/vendor/tree-sitter/ — both imports are confined to this section
// (dynamic `import("node:sqlite")` inside the handlers, never a top-level
// import) so an API drift in either experimental/vendored dependency can
// only ever break these two subcommands (blast-radius containment, plan
// "동시성 모델"/"Node 런타임 하한" sections). The graph DB is REPOSITORY
// scoped (.cat/graph/graph.db, a sibling of .cat/settings.json) — --session
// is required for CLI parsing uniformity (makeCtx) but ctx.root is never
// referenced here, only ctx.projectRoot (same pattern as `design diff`).

const GRAPH_NODE_FLOOR = [22, 13, 0];
const GRAPH_BUSY_TIMEOUT_MS = 5000;
const GRAPH_SOURCE_EXTENSIONS = new Set([".js", ".mjs", ".ts", ".tsx"]);
const GRAPH_EXCLUDE_PREFIXES = ["node_modules/", ".cat/", "scripts/vendor/"];
const GRAPH_GRAMMAR_BY_EXT = {
  ".js": "tree-sitter-javascript.wasm",
  ".mjs": "tree-sitter-javascript.wasm",
  ".ts": "tree-sitter-typescript.wasm",
  ".tsx": "tree-sitter-tsx.wasm",
};
const GRAPH_FUNCTION_VALUE_TYPES = new Set(["arrow_function", "function_expression", "function"]);

const GRAPH_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS files (
  path         TEXT PRIMARY KEY,
  sha256       TEXT NOT NULL,
  mtime        TEXT NOT NULL,
  parse_status TEXT NOT NULL,
  node_count   INTEGER NOT NULL,
  edge_count   INTEGER NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS nodes (
  id       TEXT PRIMARY KEY,
  file     TEXT NOT NULL REFERENCES files(path),
  symbol   TEXT NOT NULL,
  kind     TEXT NOT NULL,
  exported INTEGER NOT NULL,
  line     INTEGER NOT NULL,
  sha256   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_nodes_file ON nodes(file);
CREATE TABLE IF NOT EXISTS edges (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  from_id TEXT NOT NULL,
  to_id   TEXT NOT NULL,
  kind    TEXT NOT NULL,
  file    TEXT NOT NULL,
  line    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_edges_to   ON edges(to_id);
CREATE INDEX IF NOT EXISTS idx_edges_from ON edges(from_id);
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

function graphNodeVersionAtLeast(floor) {
  const parts = String(process.versions.node)
    .split(".")
    .map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < floor.length; i++) {
    const have = parts[i] ?? 0;
    if (have > floor[i]) return true;
    if (have < floor[i]) return false;
  }
  return true;
}

/**
 * Entry guard for `graph build`/`graph query` ONLY — never called from
 * main()'s top level, so every other subcommand keeps working below this
 * floor. Must run before any node:sqlite or vendored-parser import so a
 * below-floor Node gets this message instead of a cryptic import failure.
 */
function requireGraphNodeFloor(label) {
  if (!graphNodeVersionAtLeast(GRAPH_NODE_FLOOR)) {
    process.stderr.write(`cat-state: ${label} requires Node 22.13.0 or newer, found ${process.versions.node}\n`);
    process.exit(EXIT_USAGE);
  }
}

function graphDbPath(ctx) {
  return path.join(ctx.projectRoot, ".cat", "graph", "graph.db");
}

function isGraphLockError(err) {
  return !!(err && err.code === "ERR_SQLITE_ERROR" && /locked|busy/i.test(String(err.message || "")));
}

/** Vendored web-tree-sitter loader — always by relative path (never a bare specifier). */
async function loadGraphParser() {
  const vendorDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "vendor", "tree-sitter");
  const { default: ParserClass } = await import(path.join(vendorDir, "tree-sitter.js"));
  await ParserClass.init({ locateFile: (name) => path.join(vendorDir, name) });
  const languages = new Map();
  for (const wasmName of new Set(Object.values(GRAPH_GRAMMAR_BY_EXT))) {
    languages.set(wasmName, await ParserClass.Language.load(path.join(vendorDir, "grammars", wasmName)));
  }
  return { ParserClass, languages };
}

function graphStringNodeText(stringNode) {
  return stringNode && stringNode.namedChildCount > 0 ? stringNode.namedChild(0).text : "";
}

/**
 * Extract function/class/export declarations, named imports, and unresolved
 * call candidates from one parsed file's AST. Node-type shapes verified
 * against the vendored web-tree-sitter 0.24.7 loader + tree-sitter-wasms
 * 0.1.13 JS/TS/TSX grammars (see scripts/vendor/tree-sitter/VENDOR.md).
 * Scope is intentionally narrow (top-level function/class/export-const
 * declarations only, simple identifier call callees only) — this is a
 * lightweight code-review aid, not a full semantic resolver.
 */
function extractGraphFacts(relPath, root) {
  const declByAst = new Map();
  const decls = [];
  const explicitExportNames = new Set();
  const imports = [];

  // Keyed by node.id (a stable numeric handle into the underlying tree),
  // NOT by the Node wrapper object itself — web-tree-sitter constructs a
  // fresh JS wrapper object on every `.child()`/`.namedChild()` call, so
  // two wrappers for the exact same tree position are NOT reference-equal.
  const registerDecl = (astNode, symbol, kind, line) => {
    if (!symbol) return null;
    const info = { id: `${relPath}::${symbol}`, symbol, kind, line, exported: false };
    declByAst.set(astNode.id, info);
    decls.push(info);
    return info;
  };

  for (let i = 0; i < root.childCount; i++) {
    const stmt = root.child(i);
    let target = stmt;
    let exportedHere = false;
    if (stmt.type === "export_statement") {
      exportedHere = true;
      const declField = stmt.childForFieldName("declaration");
      if (declField) {
        target = declField;
      } else {
        // `export { a, b as c }` re-export list — mark previously (or later)
        // declared same-file locals as exported; no new decl to register here.
        const clause = stmt.namedChild(0);
        if (clause && clause.type === "export_clause") {
          for (let j = 0; j < clause.namedChildCount; j++) {
            const spec = clause.namedChild(j);
            if (spec.type !== "export_specifier") continue;
            const nameNode = spec.childForFieldName("name");
            if (nameNode) explicitExportNames.add(nameNode.text);
          }
        }
        continue;
      }
    }
    if (target.type === "function_declaration") {
      const nameNode = target.childForFieldName("name");
      const info = registerDecl(target, nameNode?.text, "function", target.startPosition.row + 1);
      if (info && exportedHere) info.exported = true;
    } else if (target.type === "class_declaration") {
      const nameNode = target.childForFieldName("name");
      const info = registerDecl(target, nameNode?.text, "class", target.startPosition.row + 1);
      if (info && exportedHere) info.exported = true;
    } else if (target.type === "lexical_declaration" || target.type === "variable_declaration") {
      for (let j = 0; j < target.namedChildCount; j++) {
        const decl = target.namedChild(j);
        if (decl.type !== "variable_declarator") continue;
        const nameNode = decl.childForFieldName("name");
        const valueNode = decl.childForFieldName("value");
        if (nameNode && valueNode && GRAPH_FUNCTION_VALUE_TYPES.has(valueNode.type)) {
          const info = registerDecl(decl, nameNode.text, "function", decl.startPosition.row + 1);
          if (info && exportedHere) info.exported = true;
        }
      }
    } else if (stmt.type === "import_statement") {
      const sourceNode = stmt.childForFieldName("source");
      const source = graphStringNodeText(sourceNode);
      const clause = stmt.namedChild(0);
      const line = stmt.startPosition.row + 1;
      if (clause && clause.type === "import_clause") {
        for (let j = 0; j < clause.namedChildCount; j++) {
          const part = clause.namedChild(j);
          if (part.type !== "named_imports") continue;
          // Default imports (bare `identifier`) and `import * as ns` (namespace_import)
          // carry no remote symbol name to match against and are not resolved —
          // documented limitation (see VENDOR.md).
          for (let k = 0; k < part.namedChildCount; k++) {
            const spec = part.namedChild(k);
            if (spec.type !== "import_specifier") continue;
            const nameNode = spec.childForFieldName("name");
            const aliasNode = spec.childForFieldName("alias");
            if (!nameNode) continue;
            imports.push({ localName: (aliasNode ?? nameNode).text, remoteName: nameNode.text, source, line });
          }
        }
      }
    }
  }

  if (explicitExportNames.size) {
    for (const info of decls) {
      if (explicitExportNames.has(info.symbol)) info.exported = true;
    }
  }

  const callCandidates = [];
  const walk = (node, enclosingId) => {
    const declInfo = declByAst.get(node.id);
    const nextEnclosing = declInfo ? declInfo.id : enclosingId;
    if (node.type === "call_expression") {
      const fn = node.childForFieldName("function");
      if (fn && fn.type === "identifier") {
        callCandidates.push({ enclosingId, calleeName: fn.text, line: node.startPosition.row + 1 });
      }
    }
    for (let i = 0; i < node.childCount; i++) walk(node.child(i), nextEnclosing);
  };
  walk(root, relPath);

  return { decls, imports, callCandidates };
}

/** Tracked JS/TS/TSX source files, respecting .gitignore via `git ls-files`. */
function listGraphSourceFiles(projectRoot) {
  let raw;
  try {
    raw = execFileSync("git", ["ls-files", "-z"], { cwd: projectRoot, maxBuffer: 64 * 1024 * 1024 });
  } catch (err) {
    throw new ContractError(`graph build: git ls-files failed (${err.message}) — is this a git repository?`);
  }
  const all = raw.toString("utf8").split("\0").filter(Boolean);
  return all
    .filter((relPath) => {
      const ext = path.posix.extname(relPath);
      if (!GRAPH_SOURCE_EXTENSIONS.has(ext)) return false;
      if (relPath.endsWith(".d.ts")) return false;
      for (const prefix of GRAPH_EXCLUDE_PREFIXES) {
        if (relPath.startsWith(prefix)) return false;
      }
      return true;
    })
    .sort();
}

/** Resolve a relative import specifier to one of the known-scanned files (posix paths throughout). */
function resolveGraphSpecifier(fromRelPath, spec, knownFiles) {
  if (!spec || !spec.startsWith(".")) return null;
  const fromDir = path.posix.dirname(fromRelPath);
  const raw = path.posix.normalize(path.posix.join(fromDir, spec));
  const candidates = [
    raw,
    `${raw}.ts`,
    `${raw}.tsx`,
    `${raw}.js`,
    `${raw}.mjs`,
    `${raw}.jsx`,
    path.posix.join(raw, "index.ts"),
    path.posix.join(raw, "index.tsx"),
    path.posix.join(raw, "index.js"),
    path.posix.join(raw, "index.mjs"),
  ];
  for (const c of candidates) if (knownFiles.has(c)) return c;
  return null;
}

/**
 * `graph build [--changed-only]` — parses tracked JS/TS/TSX with the
 * vendored Tree-sitter runtime and upserts nodes/edges into the
 * repository-scoped .cat/graph/graph.db (SQLite, WAL, busy_timeout 5000ms)
 * in a single BEGIN IMMEDIATE ... COMMIT transaction. Fail-open on lock
 * contention past busy_timeout: {ok:false, skipped:"locked"}, exit 0.
 */
async function cmdGraphBuild(ctx, flags) {
  requireGraphNodeFloor("graph build");
  const { DatabaseSync } = await import("node:sqlite");
  const changedOnly = flags["changed-only"] !== undefined && flags["changed-only"] !== "false";

  const dbPath = graphDbPath(ctx);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  let db;
  try {
    db = new DatabaseSync(dbPath, { timeout: GRAPH_BUSY_TIMEOUT_MS });
  } catch (err) {
    if (isGraphLockError(err)) {
      printJson({ ok: false, skipped: "locked" });
      return;
    }
    throw err;
  }

  try {
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec(`PRAGMA busy_timeout = ${GRAPH_BUSY_TIMEOUT_MS};`);
    db.exec(GRAPH_SCHEMA_SQL);

    const sourceFiles = listGraphSourceFiles(ctx.projectRoot);
    const sourceFileSet = new Set(sourceFiles);

    const existingFiles = new Map();
    for (const row of db.prepare("SELECT path, sha256 FROM files").all()) {
      existingFiles.set(row.path, row.sha256);
    }

    // Decide which files need (re)parsing. Without --changed-only every
    // scanned file is reparsed (simple, always-consistent full rebuild);
    // with --changed-only, a file already in the DB with a matching sha256
    // is skipped and its existing nodes/edges are left untouched.
    const toParse = [];
    const unchangedKept = [];
    for (const relPath of sourceFiles) {
      const prevSha = existingFiles.get(relPath);
      if (changedOnly && prevSha !== undefined) {
        const abs = path.join(ctx.projectRoot, relPath);
        let sha;
        try {
          sha = sha256hex(fs.readFileSync(abs));
        } catch {
          toParse.push(relPath);
          continue;
        }
        if (sha === prevSha) {
          unchangedKept.push(relPath);
          continue;
        }
      }
      toParse.push(relPath);
    }

    let ParserClass = null;
    let languages = null;
    if (toParse.length) {
      const loaded = await loadGraphParser();
      ParserClass = loaded.ParserClass;
      languages = loaded.languages;
    }

    const parsedByFile = new Map();
    for (const relPath of toParse) {
      const abs = path.join(ctx.projectRoot, relPath);
      let source;
      try {
        source = fs.readFileSync(abs, "utf8");
      } catch {
        parsedByFile.set(relPath, { decls: [], imports: [], callCandidates: [], sha: existingFiles.get(relPath) ?? "", parseStatus: "skipped" });
        continue;
      }
      const sha = sha256hex(source);
      const ext = path.posix.extname(relPath);
      const wasmName = GRAPH_GRAMMAR_BY_EXT[ext];
      let facts = { decls: [], imports: [], callCandidates: [] };
      let parseStatus = "skipped";
      if (wasmName && languages) {
        try {
          const parser = new ParserClass();
          parser.setLanguage(languages.get(wasmName));
          const tree = parser.parse(source);
          facts = extractGraphFacts(relPath, tree.rootNode);
          parseStatus = tree.rootNode.hasError ? "partial" : "ok";
        } catch {
          parseStatus = "skipped";
        }
      }
      parsedByFile.set(relPath, { ...facts, sha, parseStatus });
    }

    // Cross-file resolution needs every file's CURRENT decls, including
    // unchanged files that were skipped above (loaded from the DB).
    const declsByFile = new Map();
    for (const relPath of unchangedKept) {
      const rows = db.prepare("SELECT id, symbol, kind, exported, line FROM nodes WHERE file = ?").all(relPath);
      declsByFile.set(
        relPath,
        rows.map((r) => ({ id: r.id, symbol: r.symbol, kind: r.kind, exported: !!r.exported, line: r.line }))
      );
    }
    for (const [relPath, info] of parsedByFile) declsByFile.set(relPath, info.decls);

    const perFileDeclMap = new Map();
    const perFileExportedMap = new Map();
    const globalExportedIndex = new Map();
    for (const [relPath, decls] of declsByFile) {
      const byName = new Map();
      const exportedByName = new Map();
      for (const d of decls) {
        byName.set(d.symbol, d.id);
        if (d.exported) {
          exportedByName.set(d.symbol, d.id);
          if (!globalExportedIndex.has(d.symbol)) globalExportedIndex.set(d.symbol, new Set());
          globalExportedIndex.get(d.symbol).add(d.id);
        }
      }
      perFileDeclMap.set(relPath, byName);
      perFileExportedMap.set(relPath, exportedByName);
    }

    // Resolve imports+calls for changed/new files only — these are the
    // edges *originating* in that file (edges.file = relPath). Unchanged
    // files' previously-computed outgoing edges are left as-is.
    const edgesByFile = new Map();
    for (const [relPath, info] of parsedByFile) {
      const edges = [];
      const localImportMap = new Map();
      for (const imp of info.imports) {
        const targetFile = resolveGraphSpecifier(relPath, imp.source, sourceFileSet);
        if (!targetFile) continue;
        const targetId = perFileExportedMap.get(targetFile)?.get(imp.remoteName);
        if (!targetId) continue;
        localImportMap.set(imp.localName, targetId);
        edges.push({ from_id: relPath, to_id: targetId, kind: "import", file: relPath, line: imp.line });
      }
      const sameFileMap = perFileDeclMap.get(relPath);
      for (const call of info.callCandidates) {
        let targetId = sameFileMap?.get(call.calleeName) ?? localImportMap.get(call.calleeName);
        if (!targetId) {
          const globalMatches = globalExportedIndex.get(call.calleeName);
          if (globalMatches && globalMatches.size === 1) targetId = [...globalMatches][0];
        }
        if (!targetId) continue;
        edges.push({ from_id: call.enclosingId, to_id: targetId, kind: "call", file: relPath, line: call.line });
      }
      edgesByFile.set(relPath, edges);
    }

    db.exec("BEGIN IMMEDIATE");

    try {
      const deleteNodesStmt = db.prepare("DELETE FROM nodes WHERE file = ?");
      const deleteEdgesStmt = db.prepare("DELETE FROM edges WHERE file = ?");
      const deleteFileStmt = db.prepare("DELETE FROM files WHERE path = ?");
      const insertNodeStmt = db.prepare(
        "INSERT OR REPLACE INTO nodes (id, file, symbol, kind, exported, line, sha256) VALUES (?, ?, ?, ?, ?, ?, ?)"
      );
      const insertEdgeStmt = db.prepare("INSERT INTO edges (from_id, to_id, kind, file, line) VALUES (?, ?, ?, ?, ?)");
      const upsertFileStmt = db.prepare(
        "INSERT INTO files (path, sha256, mtime, parse_status, node_count, edge_count, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) " +
          "ON CONFLICT(path) DO UPDATE SET sha256=excluded.sha256, mtime=excluded.mtime, parse_status=excluded.parse_status, " +
          "node_count=excluded.node_count, edge_count=excluded.edge_count, updated_at=excluded.updated_at"
      );
      const upsertMetaStmt = db.prepare(
        "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
      );

      let nodesWritten = 0;
      let edgesWritten = 0;
      let filesPartial = 0;
      let filesSkipped = 0;

      for (const [relPath, info] of parsedByFile) {
        deleteNodesStmt.run(relPath);
        deleteEdgesStmt.run(relPath);
        // files row must exist before nodes are inserted (nodes.file REFERENCES files.path)
        const edges = edgesByFile.get(relPath) ?? [];
        const nowTs = nowIso();
        upsertFileStmt.run(relPath, info.sha, nowTs, info.parseStatus, info.decls.length, edges.length, nowTs);
        for (const d of info.decls) {
          insertNodeStmt.run(d.id, relPath, d.symbol, d.kind, d.exported ? 1 : 0, d.line, sha256hex(`${d.symbol}:${d.kind}:${d.line}`));
        }
        for (const e of edges) insertEdgeStmt.run(e.from_id, e.to_id, e.kind, e.file, e.line);
        nodesWritten += info.decls.length;
        edgesWritten += edges.length;
        if (info.parseStatus === "partial") filesPartial += 1;
        if (info.parseStatus === "skipped") filesSkipped += 1;
      }

      let filesPruned = 0;
      for (const relPath of existingFiles.keys()) {
        if (!sourceFileSet.has(relPath)) {
          deleteNodesStmt.run(relPath);
          deleteEdgesStmt.run(relPath);
          deleteFileStmt.run(relPath);
          filesPruned += 1;
        }
      }

      // `last_build_mode` + `full_build_generation` are the cross-file
      // honesty signal for `graph query` (--changed-only skips reparsing
      // dependents, so a renamed/removed export can leave dangling caller
      // edges the per-file `stale` sha check can never see). A FULL build
      // (changedOnly=false) always recomputes every file's outgoing edges,
      // so it retires that staleness and bumps the generation counter; a
      // --changed-only build leaves the generation untouched and just
      // records that the most recent build was incremental.
      const prevGenRow = db.prepare("SELECT value FROM meta WHERE key = 'full_build_generation'").get();
      const prevGen = prevGenRow ? parseInt(prevGenRow.value, 10) || 0 : 0;
      const buildMode = changedOnly ? "changed-only" : "full";
      const fullBuildGeneration = changedOnly ? prevGen : prevGen + 1;

      upsertMetaStmt.run("last_build_at", nowIso());
      upsertMetaStmt.run("last_build_files_scanned", String(sourceFiles.length));
      upsertMetaStmt.run("last_build_mode", buildMode);
      upsertMetaStmt.run("full_build_generation", String(fullBuildGeneration));

      db.exec("COMMIT");

      const totals = db
        .prepare(
          "SELECT (SELECT COUNT(*) FROM nodes) AS nodes, (SELECT COUNT(*) FROM edges) AS edges, (SELECT COUNT(*) FROM files) AS files"
        )
        .get();

      printJson({
        ok: true,
        changed_only: changedOnly,
        incremental_since_full_build: buildMode === "changed-only",
        files_scanned: sourceFiles.length,
        files_changed: parsedByFile.size,
        files_unchanged: unchangedKept.length,
        files_pruned: filesPruned,
        files_partial: filesPartial,
        files_skipped: filesSkipped,
        nodes_written: nodesWritten,
        edges_written: edgesWritten,
        total_nodes: totals.nodes,
        total_edges: totals.edges,
        total_files: totals.files,
      });
    } catch (err) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* best-effort — no transaction may have been open yet */
      }
      throw err;
    }
  } catch (err) {
    // Covers lock contention ANYWHERE in this function — the PRAGMA/DDL
    // calls above BEGIN IMMEDIATE, and BEGIN IMMEDIATE itself, can also
    // throw "database is locked" while another process holds the write
    // lock, not only the transaction body. Fail-open per the plan's
    // concurrency model: never crash on lock contention, exit 0.
    if (isGraphLockError(err)) {
      printJson({ ok: false, skipped: "locked" });
      return;
    }
    throw err;
  } finally {
    try {
      db.close();
    } catch {
      /* already closed or never opened */
    }
  }
}

/**
 * `graph query --file <path> [--depth N]` (default depth 2) — read-only
 * lookup of a file's own nodes plus transitive callers/dependents (fan-in,
 * BFS over both `call` and `import` edges) up to --depth, from the
 * repository-scoped .cat/graph/graph.db. `stale` reflects whether the
 * queried file's current on-disk sha256 differs from the stored row — it
 * says nothing about OTHER files' edges into this one. `incremental_since_
 * full_build` is the cross-file honesty signal: true when the most recent
 * `graph build` was --changed-only, meaning dependents that were not
 * reparsed may still hold dangling/stale caller edges (e.g. after a
 * cross-file symbol rename) even though `stale` reports false here.
 */
async function cmdGraphQuery(ctx, flags) {
  requireGraphNodeFloor("graph query");
  const { DatabaseSync } = await import("node:sqlite");

  if (!flags.file || flags.file === true) throw new UsageError("graph query requires --file <path>");
  const absFile = path.resolve(ctx.projectRoot, flags.file);
  const relFile = path.relative(ctx.projectRoot, absFile).split(path.sep).join("/");

  let depth = 2;
  if (flags.depth !== undefined && flags.depth !== true) {
    depth = parseInt(flags.depth, 10);
    if (!Number.isFinite(depth) || depth < 0) {
      throw new UsageError(`--depth must be a non-negative integer, got "${flags.depth}"`);
    }
  }

  const missing = (incrementalSinceFullBuild = false) =>
    printJson({
      ok: true,
      file: relFile,
      depth,
      stale: true,
      incremental_since_full_build: incrementalSinceFullBuild,
      nodes: [],
      callers: [],
      dependents: [],
      parse_status: "missing",
    });

  const dbPath = graphDbPath(ctx);
  if (!fs.existsSync(dbPath)) return missing();

  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true, timeout: GRAPH_BUSY_TIMEOUT_MS });
  } catch {
    return missing();
  }

  try {
    // Cross-file honesty signal: true when the most recent `graph build` was
    // --changed-only, meaning inbound caller/dependent edges for files that
    // were NOT reparsed may be stale even though this file's own `stale`
    // (sha256) check below says otherwise (see BLOCKER 2 / DESIGN.md graph
    // subsystem "Known Limitations").
    const buildModeRow = db.prepare("SELECT value FROM meta WHERE key = 'last_build_mode'").get();
    const incrementalSinceFullBuild = buildModeRow?.value === "changed-only";

    const fileRow = db.prepare("SELECT * FROM files WHERE path = ?").get(relFile);
    if (!fileRow) return missing(incrementalSinceFullBuild);

    let stale = true;
    try {
      const liveSha = sha256hex(fs.readFileSync(absFile));
      stale = liveSha !== fileRow.sha256;
    } catch {
      stale = true;
    }

    const nodeRows = db.prepare("SELECT id, symbol, kind, exported, line FROM nodes WHERE file = ? ORDER BY line").all(relFile);
    const nodes = nodeRows.map((r) => ({ id: r.id, symbol: r.symbol, kind: r.kind, exported: !!r.exported, line: r.line }));

    const visited = new Map();
    for (const n of nodes) visited.set(n.id, 0);
    // The queried file's own top-level (module) scope is also "self", not an
    // external caller — a call sitting directly at module scope (outside any
    // declared function) uses relFile itself as the edge's from_id.
    visited.set(relFile, 0);
    let frontier = nodes.map((n) => n.id);
    let currentDistance = 0;
    while (currentDistance < depth && frontier.length) {
      const placeholders = frontier.map(() => "?").join(",");
      const rows = db.prepare(`SELECT DISTINCT from_id FROM edges WHERE to_id IN (${placeholders})`).all(...frontier);
      const nextFrontier = [];
      for (const row of rows) {
        if (visited.has(row.from_id)) continue;
        visited.set(row.from_id, currentDistance + 1);
        nextFrontier.push(row.from_id);
      }
      currentDistance += 1;
      frontier = nextFrontier;
    }

    const callers = [];
    for (const [id, distance] of visited) {
      if (distance === 0) continue;
      const nodeRow = db.prepare("SELECT file, symbol, kind FROM nodes WHERE id = ?").get(id);
      if (nodeRow) {
        callers.push({ id, file: nodeRow.file, symbol: nodeRow.symbol, kind: nodeRow.kind, distance });
      } else {
        // file-level pseudo id (a top-level call/import site, not inside any declared node)
        callers.push({ id, file: id, symbol: "<module>", kind: "module", distance });
      }
    }
    callers.sort((a, b) => a.distance - b.distance || a.id.localeCompare(b.id));

    printJson({
      ok: true,
      file: relFile,
      depth,
      stale,
      incremental_since_full_build: incrementalSinceFullBuild,
      nodes,
      callers,
      dependents: callers,
      parse_status: fileRow.parse_status,
    });
  } finally {
    try {
      db.close();
    } catch {
      /* already closed */
    }
  }
}

// --------------------------------------------------------------------- main

const USAGE = `usage: cat-state.mjs <subcommand> --session <sid> [flags]
subcommands:
  init
  state read   [--skill s]
  state write  --skill s --json <str|->
  state clear  --skill s
  artifact write --workflow ralplan --run <id> --stage <NN>-<name> --file <path|->
  goal init    --brief <path|->
  goal checkpoint --goal GNNN --status <s> [--quality-gate-json <path|->]
  ledger append --json <str|->
  dialogue append --json <str|->
  floor
  receipt verify --goal GNNN
  design diff  --figma <path|-> --impl <path|->   # mechanical Figma↔impl measurement diff (design-qa lane aid):
                                                  # joins by (surface,element,property), emits gate-ready qa.design
                                                  # rows for well-formed pairs, refuses (exit 2) on any unmeasured
                                                  # (extracted-but-not-measured) or malformed pair — the two-numbers rule
  design visual --figma <path> --impl <path>      # mechanical PNG pixel-diff diagnostic (design-qa lane aid):
    [--major-threshold N] [--block-threshold N]    # decodes both PNGs, letterboxes+downscales onto a common canvas,
    [--exclude <json>]                             # classifies None/Major/Blocking (raw_diff_ratio decides Blocking,
                                                  # exclude_regions only ever affects diff_ratio); --block-threshold is
                                                  # diagnostic-only (the checkpoint gate always resolves via
                                                  # .cat/settings.json designQa.visualDiffBlockThreshold, PROVISIONAL
                                                  # default 0.75); stdout includes raw_diff_ratio AND diff_ratio.
  graph build  [--changed-only]                   # Node 22.13.0+ only: parse tracked JS/TS/TSX with the vendored
                                                  # Tree-sitter runtime, upsert into repo-scoped .cat/graph/graph.db
                                                  # (SQLite, WAL). --changed-only skips files whose sha256 is unchanged.
  graph query  --file <path> [--depth N]          # Node 22.13.0+ only: query .cat/graph/graph.db for a file's own
                                                  # nodes plus transitive callers/dependents up to --depth (default 2)`;

function parseArgs(argv) {
  const words = [];
  const flags = {};
  let i = 0;
  for (; i < argv.length; i++) {
    if (argv[i].startsWith("--")) break;
    words.push(argv[i]);
  }
  for (; i < argv.length; i++) {
    const tok = argv[i];
    if (!tok.startsWith("--")) throw new UsageError(`unexpected argument "${tok}"\n${USAGE}`);
    const key = tok.slice(2);
    const next = argv[i + 1];
    // Bare boolean flags (e.g. `--changed-only`, with no following value or
    // immediately followed by another --flag) are supported alongside the
    // original value-flag form; no existing call site in this repo passes a
    // flag with no trailing value, so this is additive, not breaking.
    if (next === undefined || next.startsWith("--")) {
      flags[key] = true;
    } else {
      flags[key] = next;
      i++;
    }
  }
  return { command: words.join(" "), flags };
}

async function main() {
  const { command, flags } = parseArgs(process.argv.slice(2));
  const ctx = makeCtx(flags);
  switch (command) {
    case "init":
      return cmdInit(ctx);
    case "state read":
      return cmdStateRead(ctx, flags);
    case "state write":
      return cmdStateWrite(ctx, flags);
    case "state clear":
      return cmdStateClear(ctx, flags);
    case "artifact write":
      return cmdArtifactWrite(ctx, flags);
    case "goal init":
      return cmdGoalInit(ctx, flags);
    case "goal checkpoint":
      return cmdGoalCheckpoint(ctx, flags);
    case "ledger append":
      return cmdLedgerAppend(ctx, flags);
    case "dialogue append":
      return cmdDialogueAppend(ctx, flags);
    case "floor":
      return cmdFloor(ctx);
    case "receipt verify":
      return cmdReceiptVerify(ctx, flags);
    case "design diff":
      return cmdDesignDiff(ctx, flags);
    case "design visual":
      return cmdDesignVisual(ctx, flags);
    case "graph build":
      return cmdGraphBuild(ctx, flags);
    case "graph query":
      return cmdGraphQuery(ctx, flags);
    default:
      throw new UsageError(`unknown subcommand "${command}"\n${USAGE}`);
  }
}

main().catch((err) => {
  if (err instanceof ContractError) {
    process.stderr.write(`cat-state: ${err.message}\n`);
    process.exit(EXIT_CONTRACT);
  }
  if (err instanceof UsageError) {
    process.stderr.write(`cat-state: ${err.message}\n`);
    process.exit(EXIT_USAGE);
  }
  process.stderr.write(`cat-state: unexpected error: ${err?.stack ?? err}\n`);
  process.exit(EXIT_USAGE);
});
