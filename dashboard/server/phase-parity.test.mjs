/**
 * dashboard/server/phase-parity.test.mjs — the phase-model parity fixture.
 *
 * Asserts that FOUR independent sources agree on the canonical phase model
 * (architect finding A5 / plan §"Expanded test plan"):
 *   1. hooks/cat-hook.mjs   — its own SKILLS + STOP_RELEASING_PHASES literals
 *   2. scripts/cat-state.mjs — its own SKILLS + PHASE_EDGES (+ derived STOP_RELEASING_PHASES) literals
 *   3. dashboard/server/phase-model.mjs — this server's mirrored copy
 *   4. DESIGN.md §3's "Canonical phases" table + its STOP_RELEASING_PHASES line
 *
 * Each source is read from its own file as TEXT and parsed with a small,
 * dependency-free extractor (never `import`ed/executed — both cat-hook.mjs and
 * cat-state.mjs call an unconditional main() at module scope that reads stdin
 * and calls process.exit, so importing them directly would hang or exit the
 * test process). Any drift fails loudly and names the divergent source(s).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { SKILLS as MIRROR_SKILLS, PHASE_EDGES as MIRROR_PHASE_EDGES, STOP_RELEASING_PHASES as MIRROR_STOP } from "./phase-model.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const DESIGN_MD = path.join(REPO_ROOT, "DESIGN.md");
const CAT_HOOK = path.join(REPO_ROOT, "hooks", "cat-hook.mjs");
const CAT_STATE = path.join(REPO_ROOT, "scripts", "cat-state.mjs");

// ---------------------------------------------------------------------------
// Generic const-literal extractor: finds `const NAME = <literal>;` in raw JS
// source text and returns the parsed value, WITHOUT importing/executing the
// file. Handles nested [] / {} and quoted strings (so it tolerates unquoted
// object keys like `ralplan: "planner"` alongside quoted ones like
// `"deep-interview": "interviewing"`).
// ---------------------------------------------------------------------------
function extractConstLiteral(source, name) {
  const marker = `const ${name} = `;
  const start = source.indexOf(marker);
  if (start === -1) throw new Error(`could not find "const ${name} ="`);
  let i = start + marker.length;
  const openChar = source[i];
  if (openChar !== "[" && openChar !== "{") {
    throw new Error(`"${name}" does not start with [ or { at offset ${i}`);
  }
  const closeChar = openChar === "[" ? "]" : "}";
  let depth = 0;
  let inString = null; // active quote char, or null
  let escaped = false;
  let end = -1;
  for (let j = i; j < source.length; j++) {
    const ch = source[j];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === inString) {
        inString = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inString = ch;
      continue;
    }
    if (ch === openChar) depth++;
    else if (ch === closeChar) {
      depth--;
      if (depth === 0) {
        end = j;
        break;
      }
    }
  }
  if (end === -1) throw new Error(`unterminated literal for "${name}"`);
  const literalText = source.slice(i, end + 1);
  // eslint-disable-next-line no-new-func -- trusted, repo-local static source, test-only.
  return new Function(`"use strict"; return (${literalText});`)();
}

function readSource(file) {
  return fs.readFileSync(file, "utf8");
}

// ---------------------------------------------------------------------------
// DESIGN.md §3 table + STOP_RELEASING_PHASES parser.
// ---------------------------------------------------------------------------
function parseDesignMd(designMdText) {
  const stopMatch = designMdText.match(/STOP_RELEASING_PHASES\s*=\s*(\[[^\]]*\])/);
  if (!stopMatch) throw new Error("DESIGN.md: could not find STOP_RELEASING_PHASES literal");
  const stopReleasingPhases = JSON.parse(stopMatch[1]);

  const tableStart = designMdText.indexOf("Canonical phases:");
  if (tableStart === -1) throw new Error("DESIGN.md: could not find 'Canonical phases:' section");
  const tableEnd = designMdText.indexOf("PHASE_EDGES loop-backs", tableStart);
  const block = designMdText.slice(tableStart, tableEnd === -1 ? undefined : tableEnd);

  const rows = block
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("|") && l.endsWith("|") && !/^\|\s*-+/.test(l) && !/^\|\s*skill\s*\|/.test(l));

  const phasesBySkill = {};
  const initialBySkill = {};
  const skillOrder = [];
  for (const row of rows) {
    const cells = row
      .split("|")
      .slice(1, -1)
      .map((c) => c.trim());
    const [skillCell, phasesCell, initialCell] = cells;
    const skill = skillCell.trim();
    skillOrder.push(skill);
    const codeTokens = [...phasesCell.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
    const chain = codeTokens[0].split("→").map((s) => s.trim());
    const extraAlts = codeTokens.slice(1);
    phasesBySkill[skill] = new Set([...chain, ...extraAlts]);
    const initialMatch = initialCell.match(/`([^`]+)`/);
    initialBySkill[skill] = initialMatch ? initialMatch[1] : initialCell;
  }
  return { skillOrder, phasesBySkill, initialBySkill, stopReleasingPhases };
}

// ---------------------------------------------------------------------------
// Cross-source comparison — exported as a pure function so it can be exercised
// both against the real repo files AND against a deliberately-mutated synthetic
// input (below) to prove the fixture actually fails loudly on drift.
// ---------------------------------------------------------------------------
export function computeParity({ hookSkills, hookStop, stateSkills, statePhaseEdges, mirrorSkills, mirrorPhaseEdges, mirrorStop, design }) {
  const mismatches = [];

  // SKILLS: cat-hook.mjs, cat-state.mjs, phase-model.mjs (mirror), and DESIGN.md's table
  // row order must all agree.
  const skillSources = { "cat-hook.mjs": hookSkills, "cat-state.mjs": stateSkills, "phase-model.mjs": mirrorSkills, "DESIGN.md": design.skillOrder };
  const skillsJson = JSON.stringify(hookSkills);
  for (const [name, list] of Object.entries(skillSources)) {
    if (JSON.stringify(list) !== skillsJson) {
      mismatches.push(`SKILLS mismatch: cat-hook.mjs=${skillsJson} vs ${name}=${JSON.stringify(list)}`);
    }
  }

  // STOP_RELEASING_PHASES: only cat-hook.mjs, phase-model.mjs (mirror), and DESIGN.md
  // define this constant; cat-state.mjs does not (it derives phase-boundary decisions
  // from PHASE_EDGES instead, checked separately below).
  const stopSources = { "phase-model.mjs": mirrorStop, "DESIGN.md": design.stopReleasingPhases };
  const stopJson = JSON.stringify([...hookStop].sort());
  for (const [name, list] of Object.entries(stopSources)) {
    if (JSON.stringify([...list].sort()) !== stopJson) {
      mismatches.push(`STOP_RELEASING_PHASES mismatch: cat-hook.mjs=${stopJson} vs ${name}=${JSON.stringify([...list].sort())}`);
    }
  }

  for (const skill of hookSkills) {
    const statePhases = new Set(Object.keys(statePhaseEdges[skill] ?? {}));
    const mirrorPhases = new Set(Object.keys(mirrorPhaseEdges[skill] ?? {}));
    const designPhases = design.phasesBySkill[skill] ?? new Set();

    const stateSet = JSON.stringify([...statePhases].sort());
    if (JSON.stringify([...mirrorPhases].sort()) !== stateSet) {
      mismatches.push(`${skill} phase set mismatch: cat-state.mjs=${stateSet} vs phase-model.mjs=${JSON.stringify([...mirrorPhases].sort())}`);
    }
    if (JSON.stringify([...designPhases].sort()) !== stateSet) {
      mismatches.push(`${skill} phase set mismatch: cat-state.mjs=${stateSet} vs DESIGN.md=${JSON.stringify([...designPhases].sort())}`);
    }

    const stateInitial = Object.keys(statePhaseEdges[skill] ?? {})[0];
    const designInitial = design.initialBySkill[skill];
    if (stateInitial !== designInitial) {
      mismatches.push(`${skill} initial-phase mismatch: cat-state.mjs first-edge-key=${stateInitial} vs DESIGN.md=${designInitial}`);
    }
  }

  return { ok: mismatches.length === 0, mismatches };
}

test("phase-parity: cat-hook.mjs, cat-state.mjs, phase-model.mjs, DESIGN.md §3 all agree", () => {
  const hookSource = readSource(CAT_HOOK);
  const stateSource = readSource(CAT_STATE);
  const designSource = readSource(DESIGN_MD);

  const hookSkills = extractConstLiteral(hookSource, "SKILLS");
  const hookStop = extractConstLiteral(hookSource, "STOP_RELEASING_PHASES");
  const stateSkills = extractConstLiteral(stateSource, "SKILLS");
  const statePhaseEdges = extractConstLiteral(stateSource, "PHASE_EDGES");

  const design = parseDesignMd(designSource);

  const result = computeParity({
    hookSkills,
    hookStop,
    stateSkills,
    statePhaseEdges,
    mirrorSkills: MIRROR_SKILLS,
    mirrorPhaseEdges: MIRROR_PHASE_EDGES,
    mirrorStop: MIRROR_STOP,
    design,
  });

  assert.equal(result.ok, true, `phase-model drift detected:\n${result.mismatches.join("\n")}`);
});

test("phase-parity: computeParity fails loudly and names the divergent source on a deliberate mutation", () => {
  // Synthetic inputs modeled on the real shapes, with ONE deliberate mutation
  // (ultragoal's STOP_RELEASING_PHASES-adjacent DESIGN.md set drops "complete")
  // to prove the comparison genuinely detects and names drift, not just passes
  // vacuously.
  const baseSkills = ["deep-interview", "ralplan", "ultragoal", "team"];
  const baseStop = ["complete", "completed", "failed", "cancelled", "canceled", "inactive"];
  const basePhaseEdges = {
    "deep-interview": { interviewing: [], handoff: [], complete: [] },
    ralplan: { planner: [], review: [], revision: [], "post-interview": [], adr: [], final: [], handoff: [], complete: [] },
    ultragoal: { "goal-planning": [], executing: [], review: [], complete: [] },
    team: { starting: [], running: [], complete: [], awaiting_integration: [], failed: [], cancelled: [] },
  };
  const baseDesign = {
    skillOrder: baseSkills,
    stopReleasingPhases: baseStop,
    initialBySkill: { "deep-interview": "interviewing", ralplan: "planner", ultragoal: "goal-planning", team: "starting" },
    phasesBySkill: {
      "deep-interview": new Set(["interviewing", "handoff", "complete"]),
      ralplan: new Set(["planner", "review", "revision", "post-interview", "adr", "final", "handoff", "complete"]),
      // MUTATED: drops "complete" relative to cat-state.mjs's PHASE_EDGES.ultragoal keys.
      ultragoal: new Set(["goal-planning", "executing", "review"]),
      team: new Set(["starting", "running", "complete", "awaiting_integration", "failed", "cancelled"]),
    },
  };

  const result = computeParity({
    hookSkills: baseSkills,
    hookStop: baseStop,
    stateSkills: baseSkills,
    statePhaseEdges: basePhaseEdges,
    mirrorSkills: baseSkills,
    mirrorPhaseEdges: basePhaseEdges,
    mirrorStop: baseStop,
    design: baseDesign,
  });

  assert.equal(result.ok, false);
  assert.ok(
    result.mismatches.some((m) => m.includes("ultragoal") && m.includes("DESIGN.md")),
    `expected a named ultragoal/DESIGN.md mismatch, got: ${JSON.stringify(result.mismatches)}`,
  );
});
