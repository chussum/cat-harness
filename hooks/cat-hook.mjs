#!/usr/bin/env node
/**
 * cat-harness runtime hook — single entry point for all four hook events.
 *
 *   node cat-hook.mjs router        UserPromptSubmit -> inject routing context (always exit 0)
 *   node cat-hook.mjs pretool       PreToolUse       -> mutation guard + G1 state protection +
 *                                                        chain guard + G004 dialogue dispatch capture
 *   node cat-hook.mjs stop          Stop             -> completion gate (block until workflows terminal)
 *   node cat-hook.mjs subagentstop  SubagentStop     -> G004 dialogue reply capture (passive, disk-only)
 *
 * Contract: reads Claude Code hook JSON on stdin, writes ONLY contract JSON to stdout.
 * Never crashes: any error fails open (exit 0), diagnostics go to stderr / audit.jsonl.
 * Zero dependencies (node >= 18 builtins only). No network, no LLM calls.
 */

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MODE = process.argv[2] ?? "";
const PLUGIN_ROOT =
  process.env.CLAUDE_PLUGIN_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const SKILLS = ["deep-interview", "ralplan", "ultragoal", "team"];
const STOP_RELEASING_PHASES = ["complete", "completed", "failed", "cancelled", "canceled", "inactive"];
const FAIL_CLOSED_SKILLS = new Set(["deep-interview", "ralplan"]);
const DEEP_INTERVIEW_ABORT_PHASES = new Set(["failed", "cancelled", "canceled"]);
const BLOCKING_PHASES = {
  "deep-interview": new Set(["interviewing"]),
  ralplan: new Set(["planner", "review", "revision", "post-interview", "adr", "final"]),
  ultragoal: new Set(["goal-planning"]),
  team: new Set(["starting"]),
};
const STOP_NUDGE_BUDGET = 10;
const ROUTER_BLOCK_LIMIT = 4096;

// ---------------------------------------------------------------------------
// G004 dialogue-excerpt capture constants. Scope is namespaced cat-harness
// subagent_type/agent_type values only (planner/architect/critic/executor);
// general-purpose and other non-namespaced dispatches are skipped silently.
// ---------------------------------------------------------------------------
const DIALOGUE_NAMESPACE_PREFIX = "cat-harness:";
const DIALOGUE_EXCERPT_MAX_LEN = 140;
const DIALOGUE_PENDING_CAP = 50;
const DIALOGUE_TRANSCRIPT_TAIL_BYTES = 16384;

// ---------------------------------------------------------------------------
// Keyword table (port of gajae-code hooks/skill-keywords.ts). Priority desc,
// then keyword length desc, then alphabetical; first match wins.
// ---------------------------------------------------------------------------
const KEYWORD_DEFINITIONS = [
  { keyword: "$ralplan", skill: "ralplan", priority: 9 },
  { keyword: "consensus plan", skill: "ralplan", priority: 9 },
  { keyword: "$deep-interview", skill: "deep-interview", priority: 8 },
  { keyword: "deep interview", skill: "deep-interview", priority: 8 },
  { keyword: "interview me", skill: "deep-interview", priority: 8 },
  { keyword: "don't assume", skill: "deep-interview", priority: 8 },
  { keyword: "$ultragoal", skill: "ultragoal", priority: 8 },
  { keyword: "$team", skill: "team", priority: 8 },
  { keyword: "coordinated team", skill: "team", priority: 8 },
];

// Advisory hint regexes (never route on their own).
const VAGUENESS_RE = /not sure|unclear|vague|don't assume|어떻게든|알아서|대충/gi;
const SCOPE_RISK_RE = /migration|security|breaking change|data loss|마이그레이션|보안/gi;
// Design/external-resource URL detector: a pasted design link (Figma etc.) must
// never be silently dropped. When present, the router surfaces it as a directive
// so the link survives into the spec/plan and the design-QA gate is honored
// (fail-closed + MCP-install nudge when the capture tool is not connected).
const DESIGN_SOURCE_RE =
  /https?:\/\/(?:www\.)?(?:figma\.com\/(?:file|design|proto|board|community\/file)\/|(?:app\.)?zeplin\.io\/|(?:www\.)?sketch\.com\/(?:s|docs)\/)[^\s"'`)<>\]]+/gi;
const SIGNAL_DETECTORS = [
  [
    "file-path",
    /(?:^|[\s"'`(=])(?:\/|\.\/|\.\.\/|~\/)?[\w.-]+\/[\w./-]*[\w-]|\b[\w-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|c|h|cpp|cc|cs|md|json|ya?ml|toml|css|scss|html|sh|sql|swift)\b/i,
  ],
  ["issue-ref", /#\d+\b/],
  ["code-fence", /```/],
  ["symbol", /\b[a-z][a-z0-9]*[A-Z][A-Za-z0-9]*\b|\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/],
  ["numbered-list", /^\s*\d+[.)]\s+\S/m],
  ["error-trace", /\b(?:error|exception|traceback|stacktrace|stack trace)\b|^\s+at\s+\S+ \(/im],
];

// ---------------------------------------------------------------------------
// Bash mutation-detection regexes (verbatim port of gajae-code
// skill-state/deep-interview-mutation-guard.ts, plus git apply|patch per
// DESIGN.md §5).
// ---------------------------------------------------------------------------
const BASH_MUTATION_COMMAND_RE =
  /(?:^|[;&|\n])\s*(?:\w+=[^\s]+\s+)*(?:sudo\s+)?(?:tee|touch|rm|mkdir|cp|mv|install|truncate)\b([^;&|\n]*)|(?:^|[^<>])(?:>>?|\d>>?)\s*([^\s;&|]+)/gi;
const BASH_IN_PLACE_MUTATION_COMMAND_RE =
  /(?:^|[;&|\n])\s*(?:\w+=[^\s]+\s+)*(?:sudo\s+)?(?:sed|perl)\b([^;&|\n]*)/gi;
const BASH_OPAQUE_INTERPRETER_WRITE_RE =
  /(?:^|[;&|\n])\s*(?:\w+=[^\s]+\s+)*(?:sudo\s+)?(?:python3?|node|ruby)\b[^;&|\n]*(?:-c|-e)\b[^;&|\n]*(?:open\s*\(|writeFile(?:Sync)?\s*\(|\.write\s*\()/i;
const BASH_HEREDOC_OPAQUE_INTERPRETER_WRITE_RE =
  /(?:^|[;&|\n])\s*(?:\w+=[^\s]+\s+)*(?:sudo\s+)?(?:python3?|node|ruby)\b[^;&|\n]*(?:<<[-]?\s*['"]?\w+['"]?)[\s\S]*(?:open\s*\(|writeFile(?:Sync)?\s*\(|\.write\s*\()/i;
const BASH_DD_OUTPUT_RE = /(?:^|[;&|\n])\s*(?:\w+=[^\s]+\s+)*(?:sudo\s+)?dd\b([^;&|\n]*)/gi;
const BASH_GIT_APPLY_PATCH_RE = /(?:^|[;&|\n])\s*(?:\w+=[^\s]+\s+)*(?:sudo\s+)?(?:git\s+apply|patch)\b/i;
// Device sinks / fd duplications are never mutation targets (D1).
const DEVICE_SINKS = new Set(["/dev/null", "/dev/stdout", "/dev/stderr", "/dev/tty"]);
// A single command SEGMENT (after comment-strip + separator split) is a sanctioned
// cat-state.mjs invocation only when it matches this anchored shape AND carries no
// mutation targets of its own (D2 — no substring exemption).
const CAT_STATE_SANCTIONED_SEGMENT_RE =
  /^\s*(?:command\s+)?node\s+("[^"]*cat-state\.mjs"|\S*cat-state\.mjs)\b/;
// Destructive ops whose path args can take out whole directories of G1 state.
const G1_ANCESTOR_DIRS = new Set(["state", "ultragoal", "plans"]);

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------
function readStdin() {
  return new Promise(resolve => {
    let data = "";
    const timer = setTimeout(() => resolve(data), 5000);
    if (typeof timer.unref === "function") timer.unref();
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", chunk => {
      data += chunk;
    });
    process.stdin.on("end", () => {
      clearTimeout(timer);
      resolve(data);
    });
    process.stdin.on("error", () => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

function warn(message) {
  try {
    process.stderr.write(`cat-hook: ${message}\n`);
  } catch {
    /* fail open */
  }
}

function emit(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function nowIso() {
  return new Date().toISOString();
}

function sha256hex(input) {
  return createHash("sha256").update(input).digest("hex");
}

/** Canonical JSON: recursively key-sorted, undefined-stripped (cat-state.mjs parity). */
function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(v => canonicalJson(v === undefined ? null : v)).join(",") + "]";
  const keys = Object.keys(value).filter(k => value[k] !== undefined).sort();
  return "{" + keys.map(k => JSON.stringify(k) + ":" + canonicalJson(value[k])).join(",") + "}";
}

function writeAtomicRaw(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

function writeJsonAtomic(file, value) {
  writeAtomicRaw(file, `${JSON.stringify(value, null, 2)}\n`);
}

function auditAppend(dir, entry) {
  try {
    const file = path.join(dir, "state", "audit.jsonl");
    let prev = "";
    try {
      prev = fs.readFileSync(file, "utf8");
    } catch {
      /* first entry */
    }
    writeAtomicRaw(file, `${prev}${JSON.stringify({ ts: nowIso(), source: "cat-hook", ...entry })}\n`);
  } catch (error) {
    warn(`audit append failed: ${error && error.message ? error.message : error}`);
  }
}

function auditAppendIfSession(dir, entry) {
  try {
    if (!dir || !fs.existsSync(dir)) return;
  } catch {
    return;
  }
  auditAppend(dir, entry);
}

/**
 * Activity marker schema v2 (D4): {"updated_at": iso, "skills": {"<skill>": iso}}.
 * Hook nudge writes bump `updated_at` ONLY and PRESERVE `skills` (cat-state.mjs
 * owns merging its skill on every mutation).
 */
function touchActivityMarker(dir) {
  try {
    const file = path.join(dir, ".session-activity.json");
    let existing = null;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) existing = parsed;
    } catch {
      /* absent or corrupt marker → fresh */
    }
    writeJsonAtomic(file, { ...(existing ?? {}), updated_at: nowIso() });
  } catch {
    /* best-effort */
  }
}

function readActivityMarker(dir) {
  if (!dir) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, ".session-activity.json"), "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  } catch {
    /* absent/corrupt marker → no fail-closed evidence */
  }
  return null;
}

function markerHasSkill(marker, skill) {
  const skills = marker && marker.skills;
  return Boolean(
    skills &&
      typeof skills === "object" &&
      !Array.isArray(skills) &&
      Object.prototype.hasOwnProperty.call(skills, skill),
  );
}

function sessionOf(input) {
  const cwd = typeof input.cwd === "string" && input.cwd.trim() ? input.cwd : process.cwd();
  const sid = typeof input.session_id === "string" ? input.session_id.trim() : "";
  if (!sid || sid.includes("/") || sid.includes("\\") || sid.includes("..")) {
    return { cwd, sid: null, dir: null };
  }
  return { cwd, sid, dir: path.join(cwd, ".cat", `_session-${sid}`) };
}

function phaseOf(state) {
  return String((state && state.current_phase) ?? "")
    .trim()
    .toLowerCase();
}

function readModeState(dir, skill) {
  const file = path.join(dir, "state", `${skill}-state.json`);
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return { skill, file, exists: false, corrupt: false, state: null };
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { skill, file, exists: true, corrupt: true, state: null };
    }
    return { skill, file, exists: true, corrupt: false, state: parsed };
  } catch {
    return { skill, file, exists: true, corrupt: true, state: null };
  }
}

function readAllModeStates(dir) {
  if (!dir) return [];
  return SKILLS.map(skill => readModeState(dir, skill));
}

/**
 * Pick the single CURRENT workflow entry among active entries: the
 * most-recently-updated active:true state wins (a stale planning row can never
 * outrank a newer executor). Corrupt files are skipped fail-open here (the
 * PreToolUse posture); the Stop gate handles corruption fail-closed itself.
 */
function currentActiveEntry(entries) {
  const active = entries.filter(entry => entry.state && entry.state.active === true);
  if (active.length === 0) return null;
  const ts = entry => {
    const value = Date.parse(String(entry.state.updated_at ?? ""));
    return Number.isNaN(value) ? -1 : value;
  };
  let best = active[0];
  for (const entry of active) if (ts(entry) > ts(best)) best = entry;
  return best;
}

// ---------------------------------------------------------------------------
// Path classification (.cat containment + G1 protection)
// ---------------------------------------------------------------------------

/** Segments after `.cat/` when the target resolves inside `<cwd>/.cat/**`, else null. */
function catSegments(cwd, rawPath) {
  const trimmed = String(rawPath ?? "").trim();
  if (!trimmed) return null;
  let abs;
  try {
    abs = path.resolve(cwd, trimmed);
  } catch {
    return null;
  }
  const rel = path.relative(path.resolve(cwd), abs);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  const segments = rel.split(/[\\/]/).filter(Boolean);
  if (segments[0] !== ".cat") return null;
  return segments.slice(1);
}

/**
 * G1-protected files (DESIGN.md §3 writer policy): state/**, ultragoal/goals.json,
 * ultragoal/ledger.jsonl, plans/**\/index.jsonl — mutated ONLY via cat-state.mjs.
 * Applies even with no active workflow. Spec/plan markdown bodies stay writable.
 * For DESTRUCTIVE ops (rm/mv) the ancestors are protected too (D3): `.cat` itself,
 * `_session-*` dirs, and their state/ ultragoal/ plans/ subdirs.
 */
function isG1Protected(segmentsAfterCat, destructive = false) {
  if (!segmentsAfterCat) return false;
  if (segmentsAfterCat.length === 0) return destructive; // `.cat` itself
  const rest = segmentsAfterCat[0].startsWith("_session-") ? segmentsAfterCat.slice(1) : segmentsAfterCat;
  if (rest.length === 0) return destructive; // a `_session-*` dir itself
  if (destructive && rest.length === 1 && G1_ANCESTOR_DIRS.has(rest[0])) return true;
  if (rest[0] === "state") return true;
  const last = rest[rest.length - 1];
  if (rest[0] === "ultragoal" && (last === "goals.json" || last === "ledger.jsonl")) return true;
  if (rest[0] === "plans" && last === "index.jsonl") return true;
  return false;
}

// ---------------------------------------------------------------------------
// Bash target extraction (port of extractBashTargets)
// ---------------------------------------------------------------------------
function shellWords(argsText) {
  return argsText.match(/(?:[^\s'"\\]+|'[^']*'|"[^"]*")+/g) ?? [];
}

function cleanShellWord(value) {
  return value.replace(/^['"]|['"]$/g, "");
}

function addPath(targets, value, destructive = false) {
  if (typeof value === "string" && value.trim().length > 0) {
    targets.paths.push({ path: value.trim(), destructive });
  }
}

/**
 * Strip shell comments (`#` to end-of-line) outside single/double quotes; a `#`
 * only starts a comment at start-of-input or after whitespace/separators.
 */
function stripShellComments(command) {
  let out = "";
  let quote = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      out += ch;
      if (ch === "\\" && quote === '"' && i + 1 < command.length) {
        out += command[++i];
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      out += ch;
      continue;
    }
    if (ch === "\\" && i + 1 < command.length) {
      out += ch + command[++i];
      continue;
    }
    if (ch === "#") {
      const prev = out.length > 0 ? out[out.length - 1] : "";
      if (prev === "" || /[\s;&|(]/.test(prev)) {
        while (i + 1 < command.length && command[i + 1] !== "\n") i++;
        continue;
      }
    }
    out += ch;
  }
  return out;
}

/** Split a comment-stripped command on && ; | || & and newlines (D2). */
function splitShellSegments(strippedCommand) {
  return strippedCommand.split(/[;&|\n]+/);
}

/** targets.paths = [{path, destructive}] — destructive ops (rm/mv) can take out directories. */
function extractBashTargets(command) {
  const targets = { paths: [], unknown: false };
  if (!command.trim()) {
    targets.unknown = true;
    return targets;
  }
  if (BASH_OPAQUE_INTERPRETER_WRITE_RE.test(command) || BASH_HEREDOC_OPAQUE_INTERPRETER_WRITE_RE.test(command)) {
    targets.unknown = true;
  }
  if (BASH_GIT_APPLY_PATCH_RE.test(command)) {
    targets.unknown = true;
  }
  for (const match of command.matchAll(BASH_DD_OUTPUT_RE)) {
    const parts = shellWords(match[1] ?? "").map(cleanShellWord);
    const output = parts.find(part => part.startsWith("of="));
    if (output) addPath(targets, output.slice(3));
    else targets.unknown = true;
  }
  for (const match of command.matchAll(BASH_IN_PLACE_MUTATION_COMMAND_RE)) {
    const parts = shellWords(match[1] ?? "").map(cleanShellWord);
    const hasInPlaceFlag = parts.some(part => /^-.*i/.test(part));
    if (!hasInPlaceFlag) continue;
    const target = [...parts].reverse().find(part => part && !part.startsWith("-"));
    if (target) addPath(targets, target);
    else targets.unknown = true;
  }
  for (const match of command.matchAll(BASH_MUTATION_COMMAND_RE)) {
    const redirected = match[2]?.trim();
    if (redirected) {
      const cleaned = cleanShellWord(redirected);
      // D1: device sinks and bare fd duplications are not mutation targets.
      if (!DEVICE_SINKS.has(cleaned) && !cleaned.startsWith("&")) addPath(targets, cleaned);
      continue;
    }
    const parts = shellWords(match[1] ?? "");
    const commandName = match[0]
      ?.match(/(?:^|[;&|\n])\s*(?:\w+=[^\s]+\s+)*(?:sudo\s+)?(tee|touch|rm|mkdir|cp|mv|install|truncate)\b/i)?.[1]
      ?.toLowerCase();
    // D3: rm/cp/mv/install report ALL path args (sources AND destination);
    // truncate keeps destination-only.
    const targetParts = commandName === "truncate" ? parts.slice(-1) : parts;
    const destructive = commandName === "rm" || commandName === "mv";
    for (const part of targetParts) {
      const cleaned = cleanShellWord(part);
      if (!cleaned || cleaned.startsWith("-")) continue;
      addPath(targets, cleaned, destructive);
    }
  }
  return targets;
}

// ---------------------------------------------------------------------------
// router (UserPromptSubmit)
// ---------------------------------------------------------------------------
function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isWordChar(value) {
  return Boolean(value && /[a-z0-9_]/i.test(value));
}

function keywordToPattern(keyword) {
  const escaped = escapeRegex(keyword);
  const prefix = isWordChar(keyword[0]) ? "(?<![A-Za-z0-9_])" : "";
  const suffix = isWordChar(keyword[keyword.length - 1]) ? "(?![A-Za-z0-9_])" : "";
  return new RegExp(`${prefix}${escaped}${suffix}`, "i");
}

const KEYWORD_PATTERNS = KEYWORD_DEFINITIONS.map(definition => ({
  ...definition,
  pattern: keywordToPattern(definition.keyword),
}));

/**
 * First parse explicit `$skill` tokens; an explicit-like token that is not a
 * workflow skill suppresses all implicit matching. Otherwise match implicit
 * keywords; sort priority desc, keyword length desc, alphabetical.
 */
function detectPrimarySkillKeyword(text) {
  const explicitPattern = /\$((?:cat-harness:)?[a-z][a-z0-9-]*)/gi;
  let sawExplicitLike = false;
  let explicitMatch = null;
  for (const match of text.matchAll(explicitPattern)) {
    sawExplicitLike = true;
    const token = (match[1] ?? "").toLowerCase();
    const normalized = token.startsWith("cat-harness:") ? token.slice("cat-harness:".length) : token;
    if (SKILLS.includes(normalized) && !explicitMatch) {
      explicitMatch = { keyword: match[0], skill: normalized };
    }
  }
  if (explicitMatch) return explicitMatch;
  if (sawExplicitLike) return null;

  const implicit = [];
  for (const definition of KEYWORD_PATTERNS) {
    const match = text.match(definition.pattern);
    if (!match) continue;
    implicit.push({ keyword: match[0], skill: definition.skill, priority: definition.priority, length: definition.keyword.length });
  }
  implicit.sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    if (b.length !== a.length) return b.length - a.length;
    return a.keyword.localeCompare(b.keyword);
  });
  return implicit[0] ?? null;
}

function uniqueMatches(text, regex, limit) {
  const seen = new Set();
  for (const match of text.matchAll(regex)) {
    const value = match[0].toLowerCase();
    if (!seen.has(value)) seen.add(value);
    if (seen.size >= limit) break;
  }
  return [...seen];
}

// Extract design/external-resource URLs (case-preserved, deduped, capped, each
// truncated so the 4 KiB router bound is respected). Never throws.
function detectDesignSources(text, limit = 3) {
  if (typeof text !== "string" || !text) return [];
  const seen = new Set();
  const out = [];
  const re = new RegExp(DESIGN_SOURCE_RE.source, "gi");
  let match;
  while ((match = re.exec(text)) !== null) {
    let url = match[0];
    if (url.length > 120) url = `${url.slice(0, 117)}...`;
    if (!seen.has(url)) {
      seen.add(url);
      out.push(url);
    }
    if (out.length >= limit) break;
  }
  return out;
}

function sanitizeHudText(value, limit) {
  const compact = String(value)
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(/[\r\n\t]+/g, " ")
    .trim();
  return compact.length > limit ? `${compact.slice(0, limit - 1)}…` : compact;
}

function activeDescriptor(entries) {
  // D8 defense in depth: entries already in a stop-releasing phase are never
  // advertised as the active run, even if active:true was left behind.
  const live = entries.filter(entry => entry.state && !STOP_RELEASING_PHASES.includes(phaseOf(entry.state)));
  const current = currentActiveEntry(live);
  if (!current) return "none";
  const state = current.state;
  const phase = phaseOf(state) || "unknown";
  let descriptor = `${current.skill} phase=${phase}`;
  const ambiguity = Number(state.current_ambiguity);
  const threshold = Number(state.threshold);
  if (Number.isFinite(ambiguity) && Number.isFinite(threshold)) {
    descriptor += ` ambiguity=${ambiguity}/${threshold}`;
  }
  const nextAction = state.hud && typeof state.hud.nextAction === "string" ? state.hud.nextAction.trim() : "";
  if (nextAction) descriptor += ` next=${sanitizeHudText(nextAction, 80)}`;
  return `"${descriptor}"`;
}

const ROUTER_LADDER = [
  "Routing ladder — apply BEFORE acting; choose the smallest sufficient workflow:",
  "1. Pure question / discussion / trivial reversible op → answer directly, no gating.",
  "2. Implementation-shaped request with ambiguous intent, scope, or acceptance criteria → invoke cat-harness:deep-interview.",
  "3. Requirements clear but non-trivial architecture/sequencing/verification risk (migration, security, breaking change, data loss, multi-system) → invoke cat-harness:ralplan.",
  "4. Clear multi-goal / multi-step execution → invoke cat-harness:ultragoal.",
  "5. 3+ independent parallel lanes → invoke cat-harness:team.",
  'Escapes: prompt prefixed "!" or "force:" bypasses gating this turn. Explicit user workflow choice always wins.',
  'Never implement from a spec/plan marked pending-approval without the user\'s explicit approval — "just do it" does not approve.',
  "User-facing language: mirror the user's language in every question, progress update, result, and spec/plan body; state JSON stays English.",
  "Question style: write every question to the user in plain language a non-developer can follow — keep technical terms but gloss each on first use with a short parenthetical explanation, e.g. 마이그레이션(기존 데이터를 새 구조로 옮기는 작업) / build (turning code into something runnable); label options by outcome, not mechanism.",
];

function buildRouterBlock(input) {
  const lines = [];
  const { sid, dir } = input ? sessionOf(input) : { sid: null, dir: null };
  const stateRoot = sid ? `.cat/_session-${sid}` : ".cat";
  lines.push(`state_root: ${stateRoot} | helper: node "${PLUGIN_ROOT}/scripts/cat-state.mjs"`);

  let entries = [];
  try {
    entries = dir ? readAllModeStates(dir) : [];
  } catch {
    entries = [];
  }
  lines.push(`active: ${activeDescriptor(entries)}`);

  const prompt = input && typeof input.prompt === "string" ? input.prompt : "";
  const keywordMatch = prompt ? detectPrimarySkillKeyword(prompt) : null;
  if (keywordMatch) {
    lines.push(`[keyword: ${keywordMatch.skill} explicitly requested — invoke skill cat-harness:${keywordMatch.skill} now]`);
  }

  if (prompt) {
    const signals = SIGNAL_DETECTORS.filter(([, regex]) => regex.test(prompt)).map(([name]) => name);
    const cues = uniqueMatches(prompt, VAGUENESS_RE, 3);
    const risks = uniqueMatches(prompt, SCOPE_RISK_RE, 3);
    const parts = [];
    if (signals.length > 0) parts.push(`signals: ${signals.join(", ")}`);
    const advisories = [];
    if (cues.length > 0) advisories.push(`vagueness-cues: ${cues.map(cue => `"${cue}"`).join(", ")}`);
    if (risks.length > 0) advisories.push(`scope-risk: ${risks.map(risk => `"${risk}"`).join(", ")}`);
    if (advisories.length > 0) parts.push(advisories.join(", "));
    if (parts.length > 0) lines.push(`[${parts.join(" | ")}]`);

    const designSources = detectDesignSources(prompt);
    if (designSources.length > 0) {
      lines.push(
        `[design-source: ${designSources.join(", ")} — record this link VERBATIM in the spec's Design Source and the plan; UI work is design-QA gated. If the Figma/Playwright MCP (or claude-in-chrome) is not connected, the gate FAILS CLOSED and nudges install — never skip or auto-pass the design check.]`,
      );
    }
  }

  lines.push(...ROUTER_LADDER);
  let block = `<cat-harness-router>\n${lines.join("\n")}\n</cat-harness-router>`;
  if (Buffer.byteLength(block, "utf8") > ROUTER_BLOCK_LIMIT) {
    // D5: enforce the 4 KiB bound in BYTES on a clean UTF-8 boundary.
    const head = Buffer.from(block, "utf8")
      .subarray(0, ROUTER_BLOCK_LIMIT - 32)
      .toString("utf8")
      .replace(/\uFFFD+$/, "");
    block = `${head}\n</cat-harness-router>`;
  }
  return block;
}

// ---------------------------------------------------------------------------
// Dashboard auto-start (G003): project registry auto-registration + a cheap
// local liveness pre-check that spawns a detached launcher when stale/missing.
// COMPLETELY ISOLATED from the router's emitted block: this runs in its own
// try/catch, touches only ~/.cat-harness/{registry,server}.json, and NEVER
// makes a network call itself (Node has no sync HTTP client — the detached
// dashboard/server/launcher.mjs process, off this hook's timing budget, is the
// only place allowed to do the authoritative health-token HTTP probe).
//
// Shapes below MIRROR dashboard/server/{constants,singleton,registry}.mjs
// in-line rather than importing them, so a missing/broken dashboard/ tree can
// never break router/pretool/stop (matches the codebase's existing accepted
// duplication style, e.g. cat-hook.mjs's own SKILLS copy vs cat-state.mjs's).
// ---------------------------------------------------------------------------

/** Mirrors dashboard/server/constants.mjs's getHomeDir. */
function catHarnessHomeDir() {
  const override = process.env.CAT_HARNESS_HOME;
  return override ? path.resolve(override) : path.join(os.homedir(), ".cat-harness");
}

/**
 * Cheap, local, synchronous liveness pre-check (mirrors
 * dashboard/server/singleton.mjs's isLocallyLive): process.kill(pid, 0)
 * (never signals; throws if no such process) PLUS a well-formed boot_nonce
 * shape check. This is ADVISORY ONLY, not authoritative — a PID reused by an
 * unrelated process after the real server died can still read as "alive"
 * here (see DESIGN.md §10 "PID-reuse posture"). The launcher's own
 * health-token HTTP probe is what actually self-corrects that case; the
 * operator remedy for the residual edge is deleting `server.json`.
 */
function isServerLocallyLive(homeDir) {
  let record;
  try {
    record = JSON.parse(fs.readFileSync(path.join(homeDir, "server.json"), "utf8"));
  } catch {
    return false; // missing or malformed JSON → not live
  }
  if (!record || typeof record !== "object") return false;
  if (typeof record.boot_nonce !== "string" || record.boot_nonce.trim().length === 0) return false;
  if (typeof record.pid !== "number") return false;
  try {
    process.kill(record.pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Spawns dashboard/server/launcher.mjs detached + unref'd and returns
 * immediately. In test mode (CAT_HARNESS_TEST_SPAWN_CAPTURE set), the spawn
 * is captured to a file instead of actually forked, so hermetic tests can
 * assert on it without ever touching a real port or process.
 */
function spawnDetachedLauncher(pluginRoot) {
  const launcherPath = path.join(pluginRoot, "dashboard", "server", "launcher.mjs");
  const testCapture = process.env.CAT_HARNESS_TEST_SPAWN_CAPTURE;
  if (testCapture) {
    try {
      const record = { command: process.execPath, args: [launcherPath], detached: true, unref: true, ts: nowIso() };
      fs.appendFileSync(testCapture, `${JSON.stringify(record)}\n`);
    } catch {
      /* best-effort */
    }
    return;
  }
  const child = spawn(process.execPath, [launcherPath], { detached: true, stdio: "ignore" });
  child.unref();
}

/** Mirrors dashboard/server/registry.mjs's upsertRegistryRoot (atomic tmp+rename write, idempotent). */
function upsertProjectRegistry(homeDir, root) {
  const file = path.join(homeDir, "registry.json");
  let rawRoots = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (parsed && typeof parsed === "object" && Array.isArray(parsed.roots)) rawRoots = parsed.roots;
  } catch {
    /* missing/corrupt → start fresh, fail open */
  }
  // Mirrors dashboard/server/registry.mjs's readRegistry normalization EXACTLY
  // (filter non-empty strings, path.resolve-normalize, Set-dedup) so an
  // externally-written registry.json carrying an un-normalized existing root
  // (e.g. a trailing "/./" segment) can never cause a duplicate entry here.
  const existingRoots = [
    ...new Set(rawRoots.filter(r => typeof r === "string" && r.trim().length > 0).map(r => path.resolve(r))),
  ];
  const normalized = path.resolve(root);
  if (existingRoots.includes(normalized)) return; // already registered — idempotent no-op, no write
  writeJsonAtomic(file, { version: 1, roots: [...existingRoots, normalized], updated_at: nowIso() });
}

/**
 * Router auto-start step. Wrapped in its OWN try/catch so any failure here is
 * swallowed and can NEVER affect the router's emitted additionalContext block.
 */
function runAutoStart(input) {
  try {
    const cwd = typeof input.cwd === "string" && input.cwd.trim() ? input.cwd : process.cwd();
    const homeDir = catHarnessHomeDir();

    // Project auto-registration: gated on `.cat` already existing for this
    // root, so a bare `cd` into a fresh, uninitialized repo never adds a
    // dormant floor with nothing to show (matches the approved plan's
    // registration-gate rationale).
    if (fs.existsSync(path.join(cwd, ".cat"))) {
      upsertProjectRegistry(homeDir, cwd);
    }

    if (!isServerLocallyLive(homeDir)) {
      spawnDetachedLauncher(PLUGIN_ROOT);
    }
  } catch (error) {
    warn(`auto-start degraded: ${error && error.message ? error.message : error}`);
  }
}

function runRouter(input) {
  runAutoStart(input);
  let block;
  try {
    block = buildRouterBlock(input);
  } catch (error) {
    warn(`router degraded: ${error && error.message ? error.message : error}`);
    block = `<cat-harness-router>\n${ROUTER_LADDER.join("\n")}\n</cat-harness-router>`;
  }
  emit({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: block } });
  process.exit(0);
}

// ---------------------------------------------------------------------------
// pretool (PreToolUse)
// ---------------------------------------------------------------------------
const G1_DENY_REASON =
  '.cat workflow state is runtime-owned — use cat-state.mjs. Agent mutation tools cannot edit .cat state files ' +
  "(state/**, ultragoal/goals.json, ultragoal/ledger.jsonl, plans/**/index.jsonl). " +
  `Use: node "${path.join(PLUGIN_ROOT, "scripts", "cat-state.mjs")}" <subcommand>. ` +
  "Spec/plan markdown bodies under .cat/**/specs and .cat/**/plans remain writable with the normal Write tool.";

function phaseBoundaryReason(skill, phase) {
  if (skill === "ralplan") {
    return (
      `Ralplan planning phase boundary (phase=${phase}): keep refining the consensus plan and persist stage ` +
      "artifacts via `cat-state.mjs artifact write` (plan/spec markdown under .cat/ may be written with the " +
      "Write tool). Product-code mutation tools and patch execution are blocked while ralplan is active; " +
      "mutate only after the plan is approved and execution begins."
    );
  }
  if (skill === "ultragoal") {
    return (
      "Ultragoal goal-planning phase boundary: finish goal planning and record goals via `cat-state.mjs goal init` " +
      "before editing code. Product-code mutation tools and patch execution are blocked until goal planning " +
      "completes and execution begins."
    );
  }
  if (skill === "team") {
    return (
      "Team starting phase boundary: finish task-board setup (lanes, owners, evidence criteria) via cat-state.mjs " +
      "before mutating files; spawn executor lanes once the board is running."
    );
  }
  return (
    "Deep-interview phase boundary: continue gathering context/questions/risks and emit a handoff/spec before " +
    "code edits. Mutation tools and patch execution are blocked while deep-interview is active; crystallize the " +
    "spec (specs/deep-interview-{slug}.md) and hand off, or clear via `cat-state.mjs state clear --skill deep-interview`."
  );
}

function denyPretool(dir, reason, audit) {
  auditAppendIfSession(dir, { event: "guard_denial", ...audit });
  emit({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  });
  process.exit(0);
}

/** Resolve the active blocking planning skill, fail-open on corrupt state. */
function getBlockingSkill(dir) {
  if (!dir) return null;
  let entries;
  try {
    entries = readAllModeStates(dir);
  } catch (error) {
    warn(`pretool state read failed (fail open): ${error && error.message ? error.message : error}`);
    return null;
  }
  for (const entry of entries) {
    if (entry.corrupt) warn(`corrupt state at ${entry.file} (fail open)`);
  }
  const current = currentActiveEntry(entries);
  if (!current) return null;
  const phase = phaseOf(current.state);
  const blocking = BLOCKING_PHASES[current.skill];
  if (!blocking || !blocking.has(phase)) return null;
  return { skill: current.skill, phase };
}

function runSkillChainGuard(input, dir) {
  const toolInput = input.tool_input && typeof input.tool_input === "object" ? input.tool_input : {};
  const rawSkill = String(toolInput.skill ?? toolInput.name ?? "").trim().replace(/^\//, "");
  const normalized = rawSkill.toLowerCase().startsWith("cat-harness:")
    ? rawSkill.slice("cat-harness:".length).toLowerCase()
    : rawSkill.toLowerCase();
  if (!SKILLS.includes(normalized)) process.exit(0);
  if (!dir) process.exit(0);
  let current;
  try {
    current = currentActiveEntry(readAllModeStates(dir));
  } catch {
    process.exit(0);
  }
  if (!current) process.exit(0);
  if (current.skill === normalized) process.exit(0); // same-skill re-invocation allowed
  const phase = phaseOf(current.state);
  if (phase === "handoff" || STOP_RELEASING_PHASES.includes(phase)) process.exit(0);
  denyPretool(
    dir,
    `cat-harness chain guard: finish or hand off ${current.skill} first (phase=${phase}) before invoking ` +
      `cat-harness:${normalized}. Set current_phase to "handoff" via cat-state.mjs state write, or clear the ` +
      "run via cat-state.mjs state clear.",
    { tool: "Skill", kind: "chain-guard", skill: current.skill, phase, target: normalized },
  );
}

// ---------------------------------------------------------------------------
// G004 dialogue-excerpt capture (PreToolUse[Agent|Task] dispatch half +
// SubagentStop reply half). PASSIVE ONLY: never emits permissionDecision or
// additionalContext, never affects the tool call, always fails open. Disk-only
// — no LLM re-injection. Pairing is FIFO-per-agentType (architect-ratified);
// `prompt_id`/`promptId` is recorded as metadata only and never drives pairing
// (per the G001 spike findings — a single n=1 capture cannot rule out
// prompt_id being shared across concurrent same-turn dispatches).
// ---------------------------------------------------------------------------

/** Only cat-harness-namespaced subagent/agent types are captured (D-scope). */
function isNamespacedAgentType(value) {
  return typeof value === "string" && value.startsWith(DIALOGUE_NAMESPACE_PREFIX) && value.trim().length > DIALOGUE_NAMESPACE_PREFIX.length;
}

/**
 * Sentence-boundary-aware excerpt, then hard-truncate to DIALOGUE_EXCERPT_MAX_LEN:
 * collapse whitespace, take up through the first `.`/`!`/`?` followed by
 * whitespace-or-end (if any), then hard-cap the result to the max length
 * regardless of whether a sentence boundary was found.
 */
function firstSentenceExcerpt(text, maxLen = DIALOGUE_EXCERPT_MAX_LEN) {
  const collapsed = String(text ?? "").trim().replace(/\s+/g, " ");
  if (!collapsed) return "";
  const boundary = collapsed.match(/[.!?](?=\s|$)/);
  let candidate = boundary ? collapsed.slice(0, boundary.index + 1) : collapsed;
  if (candidate.length > maxLen) candidate = candidate.slice(0, maxLen);
  return candidate.trim();
}

function dialoguePendingPath(dir) {
  return path.join(dir, "state", "dialogue-pending.json");
}

function dialogueExcerptsPath(dir) {
  return path.join(dir, "state", "dialogue-excerpts.jsonl");
}

function readDialoguePending(dir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(dialoguePendingPath(dir), "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  } catch {
    /* missing/corrupt -> fresh queue map */
  }
  return {};
}

/** Bounded FIFO enqueue per agentType (~50-entry cap, oldest evicted first). */
function enqueueDialoguePending(dir, agentType, record) {
  const data = readDialoguePending(dir);
  const queue = Array.isArray(data[agentType]) ? data[agentType] : [];
  queue.push(record);
  while (queue.length > DIALOGUE_PENDING_CAP) queue.shift();
  data[agentType] = queue;
  writeJsonAtomic(dialoguePendingPath(dir), data);
}

/** FIFO pop: the OLDEST pending dispatch for this agentType pairs with this reply. */
function popDialoguePending(dir, agentType) {
  const data = readDialoguePending(dir);
  const queue = Array.isArray(data[agentType]) ? data[agentType] : [];
  if (queue.length === 0) return null;
  const popped = queue.shift();
  data[agentType] = queue;
  writeJsonAtomic(dialoguePendingPath(dir), data);
  return popped ?? null;
}

function appendDialogueExcerptLine(dir, entry) {
  const file = dialogueExcerptsPath(dir);
  let prev = "";
  try {
    prev = fs.readFileSync(file, "utf8");
  } catch {
    /* first entry */
  }
  writeAtomicRaw(file, `${prev}${JSON.stringify(entry)}\n`);
}

/**
 * PreToolUse[Agent|Task] dispatch capture. Isolated from the deny-logic
 * branches below: tool_name values are mutually exclusive, and this branch
 * NEVER calls denyPretool/emit — it only enqueues to disk then exits 0.
 */
function runDialogueDispatchCapture(input, dir) {
  try {
    if (!dir) return process.exit(0);
    const toolInput = input.tool_input && typeof input.tool_input === "object" ? input.tool_input : {};
    const agentType = typeof toolInput.subagent_type === "string" ? toolInput.subagent_type.trim() : "";
    if (!isNamespacedAgentType(agentType)) return process.exit(0);
    const promptText = typeof toolInput.prompt === "string" ? toolInput.prompt : "";
    const record = {
      roundTripId: randomUUID(),
      agentType,
      dispatchExcerpt: firstSentenceExcerpt(promptText),
      dispatchedAt: nowIso(),
      promptId: typeof input.prompt_id === "string" && input.prompt_id ? input.prompt_id : null,
    };
    enqueueDialoguePending(dir, agentType, record);
  } catch (error) {
    warn(`dialogue dispatch capture failed (fail open): ${error && error.message ? error.message : error}`);
  }
  process.exit(0);
}

/** Bounded tail-read (last maxBytes of the file), best-effort. */
function tailReadFile(filePath, maxBytes) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size === 0) return "";
    const start = Math.max(0, stat.size - maxBytes);
    const len = stat.size - start;
    const fd = fs.openSync(filePath, "r");
    try {
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, start);
      return buf.toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return "";
  }
}

/**
 * Best-effort transcript-tail fallback: scan backward for the LAST assistant
 * message (Claude Code transcript JSONL shape: {type:"assistant",
 * message:{content:[{type:"text", text:"..."}]}}), joining its text blocks.
 */
function lastAssistantTextFromTail(tailText) {
  if (!tailText) return "";
  const lines = tailText.split("\n").filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    let obj;
    try {
      obj = JSON.parse(lines[i]);
    } catch {
      continue; // partial line at the tail-read boundary, or unrelated shape
    }
    if (!obj || typeof obj !== "object" || obj.type !== "assistant") continue;
    const content = obj.message && Array.isArray(obj.message.content) ? obj.message.content : null;
    if (!content) continue;
    const text = content
      .filter(block => block && typeof block === "object" && block.type === "text" && typeof block.text === "string")
      .map(block => block.text)
      .join(" ")
      .trim();
    if (text) return text;
  }
  return "";
}

/**
 * Reply-source extraction: `last_assistant_message` is primary; a bounded
 * tail-read of agent_transcript_path (the child's own transcript) then
 * transcript_path is a fallback ONLY when last_assistant_message is absent.
 */
function extractReplyExcerpt(input) {
  const direct = typeof input.last_assistant_message === "string" ? input.last_assistant_message.trim() : "";
  if (direct) return firstSentenceExcerpt(direct);
  for (const candidatePath of [input.agent_transcript_path, input.transcript_path]) {
    if (typeof candidatePath !== "string" || !candidatePath.trim()) continue;
    const text = lastAssistantTextFromTail(tailReadFile(candidatePath, DIALOGUE_TRANSCRIPT_TAIL_BYTES));
    if (text) return firstSentenceExcerpt(text);
  }
  return "";
}

/**
 * SubagentStop reply capture. Scope-filtered on agent_type; pops the oldest
 * FIFO pending dispatch for the same agentType. Emits NOTHING to stdout (no
 * decision, no additionalContext) — disk-only, fail-open on any error.
 */
function runSubagentStop(input) {
  try {
    const { dir } = sessionOf(input);
    if (!dir) return process.exit(0);
    const agentType = typeof input.agent_type === "string" ? input.agent_type.trim() : "";
    if (!isNamespacedAgentType(agentType)) return process.exit(0);
    const replyExcerpt = extractReplyExcerpt(input);
    const repliedAt = nowIso();
    const promptId = typeof input.prompt_id === "string" && input.prompt_id ? input.prompt_id : null;
    const popped = popDialoguePending(dir, agentType);
    if (popped) {
      const roundTripId = (popped && popped.roundTripId) || randomUUID();
      appendDialogueExcerptLine(dir, {
        round_trip_id: roundTripId,
        role: "dispatch",
        agent_type: agentType,
        excerpt: (popped && popped.dispatchExcerpt) || "",
        ts: (popped && popped.dispatchedAt) || repliedAt,
        prompt_id: (popped && popped.promptId) ?? null,
        paired: true,
      });
      appendDialogueExcerptLine(dir, {
        round_trip_id: roundTripId,
        role: "reply",
        agent_type: agentType,
        excerpt: replyExcerpt,
        ts: repliedAt,
        prompt_id: promptId,
        paired: true,
      });
    } else {
      appendDialogueExcerptLine(dir, {
        round_trip_id: randomUUID(),
        role: "reply",
        agent_type: agentType,
        excerpt: replyExcerpt,
        ts: repliedAt,
        prompt_id: promptId,
        paired: false,
      });
    }
  } catch (error) {
    warn(`subagentstop dialogue capture failed (fail open): ${error && error.message ? error.message : error}`);
  }
  process.exit(0);
}

function runPretool(input) {
  const toolName = String(input.tool_name ?? "");
  const toolInput = input.tool_input && typeof input.tool_input === "object" ? input.tool_input : {};
  const { cwd, dir } = sessionOf(input);

  if (toolName === "Skill") return runSkillChainGuard(input, dir);

  if (toolName === "Agent" || toolName === "Task") return runDialogueDispatchCapture(input, dir);

  if (toolName === "Bash") {
    const command = String(toolInput.command ?? "");
    const stripped = stripShellComments(command);
    // D2: strip comments, split on separators; a segment is sanctioned iff it is
    // an anchored `node …cat-state.mjs` invocation with no mutation targets of
    // its own. Every other segment is evaluated by the normal target rules.
    const evaluated = [];
    for (const segment of splitShellSegments(stripped)) {
      if (!segment.trim()) continue;
      const segmentTargets = extractBashTargets(segment);
      if (
        CAT_STATE_SANCTIONED_SEGMENT_RE.test(segment) &&
        segmentTargets.paths.length === 0 &&
        !segmentTargets.unknown
      ) {
        continue; // sanctioned writer invocation
      }
      evaluated.push({ segment, targets: segmentTargets });
    }

    // G1 protection applies even with no active workflow.
    for (const { targets } of evaluated) {
      for (const target of targets.paths) {
        const segments = catSegments(cwd, target.path);
        if (segments && isG1Protected(segments, target.destructive)) {
          denyPretool(dir, G1_DENY_REASON, { tool: "Bash", kind: "g1-state-target", target: target.path });
        }
      }
    }
    // D3: interpreter/heredoc write commands that lexically mention ".cat/" are
    // denied EVEN WHEN IDLE (heredocs span newlines → test the whole command).
    const heredocWrite = BASH_HEREDOC_OPAQUE_INTERPRETER_WRITE_RE.test(stripped);
    const opaqueWrite =
      heredocWrite || evaluated.some(({ segment }) => BASH_OPAQUE_INTERPRETER_WRITE_RE.test(segment));
    if (opaqueWrite && stripped.includes(".cat/")) {
      denyPretool(dir, G1_DENY_REASON, { tool: "Bash", kind: "g1-opaque-interpreter-write" });
    }

    const blocking = getBlockingSkill(dir);
    if (!blocking) process.exit(0);
    const reason = phaseBoundaryReason(blocking.skill, blocking.phase);
    const unknown = !command.trim() || heredocWrite || evaluated.some(({ targets }) => targets.unknown);
    if (unknown) {
      denyPretool(dir, `${reason} (unresolvable mutation target in bash command)`, {
        tool: "Bash",
        kind: "phase-boundary-unknown-target",
        skill: blocking.skill,
        phase: blocking.phase,
      });
    }
    const paths = evaluated.flatMap(({ targets }) => targets.paths);
    if (paths.length === 0) process.exit(0); // read-only command
    const disallowed = paths.filter(target => {
      const segments = catSegments(cwd, target.path);
      return !(segments && !isG1Protected(segments, target.destructive));
    });
    if (disallowed.length === 0) process.exit(0); // all targets inside .cat, non-G1
    denyPretool(dir, reason, {
      tool: "Bash",
      kind: "phase-boundary",
      skill: blocking.skill,
      phase: blocking.phase,
      targets: disallowed.map(target => target.path).slice(0, 5),
    });
  }

  if (toolName === "Edit" || toolName === "MultiEdit" || toolName === "Write" || toolName === "NotebookEdit") {
    const target =
      toolName === "NotebookEdit" ? String(toolInput.notebook_path ?? "") : String(toolInput.file_path ?? "");
    const segments = target ? catSegments(cwd, target) : null;
    // G1 protection applies even with no active workflow.
    if (segments && isG1Protected(segments)) {
      denyPretool(dir, G1_DENY_REASON, { tool: toolName, kind: "g1-state-target", target });
    }
    const blocking = getBlockingSkill(dir);
    if (!blocking) process.exit(0);
    const reason = phaseBoundaryReason(blocking.skill, blocking.phase);
    if (!target) {
      denyPretool(dir, `${reason} (unknown mutation target)`, {
        tool: toolName,
        kind: "phase-boundary-unknown-target",
        skill: blocking.skill,
        phase: blocking.phase,
      });
    }
    if (segments) process.exit(0); // inside .cat and not G1-protected → allowed
    denyPretool(dir, reason, {
      tool: toolName,
      kind: "phase-boundary",
      skill: blocking.skill,
      phase: blocking.phase,
      target,
    });
  }

  process.exit(0);
}

// ---------------------------------------------------------------------------
// stop (Stop)
// ---------------------------------------------------------------------------
function blockStop(reason) {
  emit({ decision: "block", reason });
  process.exit(0);
}

function specOnDisk(state, cwd, dir) {
  const rawSpecPath = typeof state.spec_path === "string" ? state.spec_path.trim() : "";
  if (rawSpecPath) {
    for (const base of [cwd, dir]) {
      try {
        const resolved = path.isAbsolute(rawSpecPath) ? rawSpecPath : path.resolve(base, rawSpecPath);
        if (fs.existsSync(resolved)) return true;
      } catch {
        /* keep looking */
      }
    }
  }
  try {
    const specsDir = path.join(dir, "specs");
    return fs.readdirSync(specsDir).some(name => /^deep-interview-.+\.md$/.test(name));
  } catch {
    return false;
  }
}

/**
 * D8 abort convention: an abort is ONE deactivation write. Every remediation
 * message that offers cancellation shows the working invocation verbatim.
 */
function cancelInvocation(sid, skill) {
  return (
    `node "${path.join(PLUGIN_ROOT, "scripts", "cat-state.mjs")}" state write --session ${sid} ` +
    `--skill ${skill} --json '{"active":false,"current_phase":"cancelled"}'`
  );
}

function stopReason(skill, phase, state, cancel) {
  if (skill === "deep-interview") {
    if (phase === "interviewing") {
      const ambiguity = Number(state.current_ambiguity);
      const threshold = Number(state.threshold);
      const score =
        Number.isFinite(ambiguity) && Number.isFinite(threshold)
          ? `ambiguity ${ambiguity} > ${threshold}`
          : "ambiguity not yet scored";
      return (
        `deep-interview mid-round (${score}): ask the next question via AskUserQuestion, or crystallize the spec ` +
        "(specs/deep-interview-{slug}.md, status: pending-approval) and move to handoff via cat-state.mjs state write."
      );
    }
    if (phase === "handoff") {
      return (
        "deep-interview handoff must not stop silently: present the next step via AskUserQuestion — ralplan " +
        "(recommended) / ultragoal / team / stop here — then invoke the chosen skill or clear the run " +
        "(cat-state.mjs state clear --skill deep-interview)."
      );
    }
    return `deep-interview is still active (phase=${phase}): continue the interview, crystallize the spec, or cancel with: ${cancel}`;
  }
  if (skill === "ralplan") {
    if (phase === "handoff") {
      return (
        "ralplan handoff must not stop silently: present the execution choice via AskUserQuestion — ultragoal " +
        "(default) / team — then invoke it or clear the run (cat-state.mjs state clear --skill ralplan)."
      );
    }
    if (phase === "final") {
      return (
        "ralplan final: persist pending-approval.md and ask the structured approval question via AskUserQuestion " +
        '(Refine further / Approve execution via ultragoal / Approve execution via team / Stop here). ' +
        '"Sounds good"/"just do it" does not approve.'
      );
    }
    return (
      `ralplan ${phase}: continue the consensus loop — persist the stage artifact via cat-state.mjs artifact write, ` +
      "collect architect (CLEAR + APPROVE) and critic (OKAY) verdicts on the same artifact, then advance the " +
      `stage, or cancel with: ${cancel}`
    );
  }
  if (skill === "ultragoal") {
    if (phase === "goal-planning") {
      return `ultragoal goal-planning: decompose the brief into @goal units and run cat-state.mjs goal init — do not stop mid-planning — or cancel with: ${cancel}`;
    }
    return (
      `ultragoal ${phase}: goals are not all terminal — checkpoint via cat-state.mjs goal checkpoint (status ` +
      "complete requires --quality-gate-json), record blockers via ledger append, or pause only when the latest " +
      "ledger event is human_blocked. Verify with receipt verify before claiming done."
    );
  }
  if (phase === "starting") {
    return `team starting: initialize the task board (state/team-board.json) via cat-state.mjs and spawn executor lanes, or cancel with: ${cancel}`;
  }
  if (phase === "awaiting_integration") {
    return (
      "team awaiting_integration: lane work is merged but integration is pending — finish integration and set " +
      `phase complete, or release the run: ${cancel}`
    );
  }
  return (
    `team ${phase}: drive lanes to evidence-complete, then set the shutdown phase (complete / ` +
    `awaiting_integration / failed / cancelled) via cat-state.mjs state write, or cancel with: ${cancel}`
  );
}

/**
 * Nudge budget: persist stop_nudges (+ per-phase key) directly with atomic
 * tmp+rename writes; after 10 nudges for the same phase, fail open with an
 * audit warning instead of blocking forever.
 */
function blockWithNudgeBudget(dir, entry, phase, reason) {
  const state = entry.state;
  let count = Number.isFinite(Number(state.stop_nudges)) ? Number(state.stop_nudges) : 0;
  if (state.stop_nudges_phase !== phase) count = 0;
  if (count >= STOP_NUDGE_BUDGET) {
    auditAppend(dir, {
      event: "stop_nudge_budget_exhausted",
      level: "warning",
      skill: entry.skill,
      phase,
      stop_nudges: count,
      detail: `Stop gate fail-open: ${STOP_NUDGE_BUDGET} nudges delivered for the same phase without release.`,
    });
    return false; // budget exhausted → fail open for this skill
  }
  const next = count + 1;
  try {
    // D6 (DESIGN-sanctioned inline write): restamp the envelope exactly like
    // cat-state.mjs — revision bump + content_sha256 over key-sorted canonical JSON.
    const nudged = {
      ...state,
      stop_nudges: next,
      stop_nudges_phase: phase,
      updated_at: nowIso(),
    };
    nudged.state_revision =
      (typeof nudged.state_revision === "number" && Number.isFinite(nudged.state_revision)
        ? nudged.state_revision
        : 0) + 1;
    delete nudged.content_sha256;
    nudged.content_sha256 = sha256hex(canonicalJson(nudged));
    writeJsonAtomic(entry.file, nudged);
    touchActivityMarker(dir);
  } catch (error) {
    warn(`stop nudge persist failed: ${error && error.message ? error.message : error}`);
  }
  auditAppend(dir, { event: "stop_nudge", skill: entry.skill, phase, stop_nudges: next });
  blockStop(`cat-harness Stop gate (nudge ${next}/${STOP_NUDGE_BUDGET}): ${reason}`);
  return true;
}

function runStop(input) {
  const { cwd, sid, dir } = sessionOf(input);
  if (!dir) process.exit(0);
  try {
    if (!fs.existsSync(path.join(dir, "state"))) process.exit(0); // no state → silent
  } catch {
    process.exit(0);
  }
  const stopHookActive = input.stop_hook_active === true;
  const marker = readActivityMarker(dir);

  for (const skill of SKILLS) {
    const entry = readModeState(dir, skill);
    const cancel = cancelInvocation(sid, skill);
    if (!entry.exists) {
      // D4 fail-closed: the activity marker shows this skill ran but its state
      // file is MISSING → block (deep-interview/ralplan only); stop_hook_active
      // sanity escape still applies so a wiped file can never loop the session.
      if (!FAIL_CLOSED_SKILLS.has(skill)) continue;
      if (!markerHasSkill(marker, skill)) continue;
      if (stopHookActive) {
        auditAppend(dir, { event: "stop_fail_open_unparseable", level: "warning", skill, path: entry.file });
        continue;
      }
      auditAppend(dir, { event: "stop_block_missing_state", skill, path: entry.file });
      blockStop(
        `cat-harness Stop gate: ${skill} state at ${entry.file} is missing or corrupt while the session shows ` +
          "an active run (fail-closed). Inspect via cat-state.mjs state read, then finish the handoff or clear " +
          `it (cat-state.mjs state clear --skill ${skill}) only with user confirmation.`,
      );
    }
    if (entry.corrupt) {
      if (!FAIL_CLOSED_SKILLS.has(skill)) continue; // other skills fail open
      if (stopHookActive) {
        // stop_hook_active sanity: unparseable state + already continuing from a
        // stop hook → fail open so a corrupt file can never loop the session.
        auditAppend(dir, { event: "stop_fail_open_unparseable", level: "warning", skill, path: entry.file });
        continue;
      }
      auditAppend(dir, { event: "stop_block_corrupt_state", skill, path: entry.file });
      blockStop(
        `cat-harness Stop gate: ${skill} state at ${entry.file} is missing or corrupt while the session shows ` +
          "an active run (fail-closed). Inspect via cat-state.mjs state read, then finish the handoff or clear " +
          `it (cat-state.mjs state clear --skill ${skill}) only with user confirmation.`,
      );
    }
    const state = entry.state;
    if (state.active !== true) continue;
    const phase = phaseOf(state);
    if (STOP_RELEASING_PHASES.includes(phase)) {
      // deep-interview additionally requires a spec file on disk before release
      // (explicit abort phases remain legitimate terminals).
      if (skill === "deep-interview" && !DEEP_INTERVIEW_ABORT_PHASES.has(phase) && !specOnDisk(state, cwd, dir)) {
        blockWithNudgeBudget(
          dir,
          entry,
          phase,
          `deep-interview reached "${phase}" without a spec on disk: write specs/deep-interview-{slug}.md ` +
            "(status: pending-approval) and record it via cat-state.mjs before stopping, or cancel with: " +
            cancel,
        );
      }
      continue;
    }
    blockWithNudgeBudget(dir, entry, phase, stopReason(skill, phase, state, cancel));
  }
  process.exit(0);
}

// ---------------------------------------------------------------------------
// entry
// ---------------------------------------------------------------------------
async function main() {
  const raw = await readStdin();
  let input = null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) input = parsed;
  } catch {
    input = null;
  }
  if (MODE === "router") return runRouter(input ?? {});
  if (!input) process.exit(0);
  if (MODE === "pretool") return runPretool(input);
  if (MODE === "stop") return runStop(input);
  if (MODE === "subagentstop") return runSubagentStop(input);
  process.exit(0);
}

main().catch(error => {
  warn(`fail-open: ${error && error.stack ? error.stack : error}`);
  if (MODE === "router") {
    try {
      emit({
        hookSpecificOutput: {
          hookEventName: "UserPromptSubmit",
          additionalContext: `<cat-harness-router>\n${ROUTER_LADDER.join("\n")}\n</cat-harness-router>`,
        },
      });
    } catch {
      /* nothing left to do */
    }
  }
  process.exit(0);
});
