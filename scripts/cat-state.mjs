#!/usr/bin/env node
/**
 * cat-state.mjs — the single sanctioned writer for cat-harness runtime state.
 * Implements DESIGN.md §4 exactly. Zero dependencies; node >= 18.
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
 */

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

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
                                                  # (extracted-but-not-measured) or malformed pair — the two-numbers rule`;

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
    if (i + 1 >= argv.length) throw new UsageError(`flag --${key} requires a value`);
    flags[key] = argv[++i];
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
