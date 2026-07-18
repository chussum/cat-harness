/**
 * scripts/cat-state.test.mjs — coverage for the G004 `dialogue append`
 * subcommand (the sanctioned CLI path for appending to
 * state/dialogue-excerpts.jsonl, the append-only sibling of `ledger append`
 * but scoped to state/** rather than ultragoal/). cat-state.mjs calls an
 * unconditional main() at module scope that reads stdin and calls
 * process.exit, so it is exercised as a real child process here — its actual
 * invocation contract (argv + stdin JSON, stdout JSON, exit code) — matching
 * dashboard/server/phase-parity.test.mjs's documented rationale for treating
 * cat-hook.mjs/cat-state.mjs as un-importable.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CAT_STATE = path.join(HERE, "cat-state.mjs");

function mkTmpProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cat-harness-catstate-project-"));
}

function runCatState(args, { cwd, input } = {}) {
  return spawnSync(process.execPath, [CAT_STATE, ...args], {
    cwd,
    input: input !== undefined ? input : "",
    encoding: "utf8",
    timeout: 10000,
  });
}

function readExcerpts(sessionDir) {
  try {
    return fs
      .readFileSync(path.join(sessionDir, "state", "dialogue-excerpts.jsonl"), "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(line => JSON.parse(line));
  } catch {
    return [];
  }
}

test("dialogue append: writes one JSONL row to state/dialogue-excerpts.jsonl and prints an ok receipt", () => {
  const project = mkTmpProject();
  const entry = { role: "dispatch", round_trip_id: "rt-1", agent_type: "cat-harness:planner", excerpt: "Draft the plan.", paired: true };
  const result = runCatState(["dialogue", "append", "--session", "s1", "--json", JSON.stringify(entry)], { cwd: project });
  assert.equal(result.status, 0, result.stderr);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.ok, true);
  assert.equal(receipt.role, "dispatch");

  const sessionDir = path.join(project, ".cat", "_session-s1");
  const lines = readExcerpts(sessionDir);
  assert.equal(lines.length, 1);
  assert.deepEqual(lines[0], entry);
});

test("dialogue append: appends multiple entries in order without clobbering prior rows", () => {
  const project = mkTmpProject();
  const first = { role: "dispatch", round_trip_id: "rt-1", excerpt: "first" };
  const second = { role: "reply", round_trip_id: "rt-1", excerpt: "second" };
  runCatState(["dialogue", "append", "--session", "s1", "--json", JSON.stringify(first)], { cwd: project });
  runCatState(["dialogue", "append", "--session", "s1", "--json", JSON.stringify(second)], { cwd: project });

  const sessionDir = path.join(project, ".cat", "_session-s1");
  const lines = readExcerpts(sessionDir);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].excerpt, "first");
  assert.equal(lines[1].excerpt, "second");
});

test("dialogue append: refuses a role other than dispatch/reply (contract refusal, exit 2)", () => {
  const project = mkTmpProject();
  const result = runCatState(["dialogue", "append", "--session", "s1", "--json", JSON.stringify({ role: "bogus" })], { cwd: project });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /role.*to be "dispatch" or "reply"/);
  const sessionDir = path.join(project, ".cat", "_session-s1");
  assert.equal(readExcerpts(sessionDir).length, 0, "a refused entry must never be written");
});

test("dialogue append: refuses non-object JSON (contract refusal, exit 2)", () => {
  const project = mkTmpProject();
  const result = runCatState(["dialogue", "append", "--session", "s1", "--json", '"just a string"'], { cwd: project });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /must be a JSON object/);
});

test("dialogue append: refuses unparseable JSON (contract refusal, exit 2)", () => {
  const project = mkTmpProject();
  const result = runCatState(["dialogue", "append", "--session", "s1", "--json", "{not json"], { cwd: project });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /not valid JSON/);
});

test("dialogue append: --json - reads the entry from stdin", () => {
  const project = mkTmpProject();
  const entry = { role: "reply", round_trip_id: "rt-2", excerpt: "via stdin", paired: false };
  const result = runCatState(["dialogue", "append", "--session", "s1", "--json", "-"], { cwd: project, input: JSON.stringify(entry) });
  assert.equal(result.status, 0, result.stderr);
  const sessionDir = path.join(project, ".cat", "_session-s1");
  const lines = readExcerpts(sessionDir);
  assert.equal(lines.length, 1);
  assert.deepEqual(lines[0], entry);
});

test("dialogue append: missing --json is a usage error (exit 1)", () => {
  const project = mkTmpProject();
  const result = runCatState(["dialogue", "append", "--session", "s1"], { cwd: project });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--json/);
});

// =====================================================================
// Design-QA measurement-matrix gate (stage-23-revision.md AC1-AC19 + sibling)
// =====================================================================

const FIGMA = "https://www.figma.com/file/abc123/Card?node-id=1-2";

function sessionRoot(project, sid) {
  return path.join(project, ".cat", `_session-${sid}`);
}

/** Real >=4096-byte PNG fixture (8-byte PNG magic + padding). */
function writePng(project, name = "shot.png") {
  const p = path.join(project, name);
  const magic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  fs.writeFileSync(p, Buffer.concat([magic, Buffer.alloc(5000)]));
  return p;
}

function readAudit(project, sid) {
  try {
    return fs
      .readFileSync(path.join(sessionRoot(project, sid), "state", "audit.jsonl"), "utf8")
      .trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

function readLedger(project, sid) {
  try {
    return fs
      .readFileSync(path.join(sessionRoot(project, sid), "ultragoal", "ledger.jsonl"), "utf8")
      .trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

/**
 * Seed a session: init, optional spec/plan design source, goal init from a brief.
 * `brief` overrides the default single-goal brief (used for @goal multi-goal).
 */
function seedSession(project, sid, { specSource, planSource, brief } = {}) {
  runCatState(["init", "--session", sid], { cwd: project });
  const root = sessionRoot(project, sid);
  if (specSource) {
    fs.mkdirSync(path.join(root, "specs"), { recursive: true });
    fs.writeFileSync(path.join(root, "specs", "spec.md"), `# Spec\n\n- Design Source: ${specSource}\n`);
  }
  if (planSource) {
    const pdir = path.join(root, "plans", "ralplan", "run1");
    fs.mkdirSync(pdir, { recursive: true });
    fs.writeFileSync(path.join(pdir, "pending-approval.md"), `# Approved plan\n\nDesign reference: ${planSource}\n`);
  }
  const briefText = brief ?? "Build the card widget";
  const briefPath = path.join(project, `${sid}-brief.txt`);
  fs.writeFileSync(briefPath, briefText);
  runCatState(["goal", "init", "--session", sid, "--brief", briefPath], { cwd: project });
  return root;
}

/** active then complete; returns the complete-checkpoint spawn result. */
function runComplete(project, sid, gate, goalId = "G001") {
  runCatState(["goal", "checkpoint", "--session", sid, "--goal", goalId, "--status", "active"], { cwd: project });
  return runCatState(
    ["goal", "checkpoint", "--session", sid, "--goal", goalId, "--status", "complete", "--quality-gate-json", "-"],
    { cwd: project, input: JSON.stringify(gate) }
  );
}

function baseGate(pngPath) {
  return {
    architect_review: {
      verdicts: { architecture: "CLEAR" },
      recommendation: "APPROVE",
      evidence: "Reviewed the full implementation against the design and confirmed every lane is clear.",
      blockers: [],
    },
    qa: {
      status: "passed",
      commands: ["node --test scripts/cat-state.test.mjs"],
      evidence: "Executed the targeted suite and the measured design matrix matches the expected values.",
      artifacts: pngPath ? [{ kind: "screenshot", path: pngPath }] : [],
      blockers: [],
    },
  };
}

function cleanRows(surface = "card") {
  return [
    { surface, element: "title", property: "font-size", figma_expected: "16px", impl_actual: "16px", severity: "None" },
    { surface, element: "title", property: "line-height", figma_expected: "24px", impl_actual: "24px", severity: "None" },
    { surface, element: "title", property: "font-weight", figma_expected: "700", impl_actual: "700", severity: "None" },
    { surface, element: "box", property: "padding", figma_expected: "16px", impl_actual: "16px", severity: "None" },
  ];
}

function withDesign(gate, design) {
  return { ...gate, qa: { ...gate.qa, design } };
}

// --- AC1: source on record, complete clean matrix → exit 0, receipt minted ---
test("AC1: complete clean matrix passes and mints a receipt", () => {
  const project = mkTmpProject();
  seedSession(project, "s", { specSource: FIGMA });
  const png = writePng(project);
  const gate = withDesign(baseGate(png), { source: FIGMA, surfaces: [{ name: "card" }], rows: cleanRows() });
  const r = runComplete(project, "s", gate);
  assert.equal(r.status, 0, r.stderr);
  const receipt = JSON.parse(r.stdout);
  assert.equal(receipt.status, "complete");
  assert.ok(receipt.receipt.quality_gate_sha256);
});

// --- AC2: mandatory property missing → exit 2 naming surface+property ---
test("AC2: missing mandatory font-weight row rejects, naming surface+property", () => {
  const project = mkTmpProject();
  seedSession(project, "s", { specSource: FIGMA });
  const png = writePng(project);
  const rows = cleanRows().filter((row) => row.property !== "font-weight");
  const gate = withDesign(baseGate(png), { source: FIGMA, surfaces: [{ name: "card" }], rows });
  const r = runComplete(project, "s", gate);
  assert.equal(r.status, 2, r.stdout);
  assert.match(r.stderr, /surface "card" is missing a mandatory font-weight/);
});

// --- AC3: delta exceeds tolerance but submitted "Trivial" → exit 2, recomputed Major ---
test("AC3: severity downgrade rejects with the recomputed severity", () => {
  const project = mkTmpProject();
  seedSession(project, "s", { specSource: FIGMA });
  const png = writePng(project);
  const rows = cleanRows();
  rows[0] = { surface: "card", element: "title", property: "font-size", figma_expected: "14px", impl_actual: "16px", severity: "Trivial" };
  const gate = withDesign(baseGate(png), { source: FIGMA, surfaces: [{ name: "card" }], rows });
  const r = runComplete(project, "s", gate);
  assert.equal(r.status, 2, r.stdout);
  assert.match(r.stderr, /more lenient than the CLI-recomputed "Major"/);
});

// --- AC4: AC3 unresolved rejects; corrected within tolerance passes (loop forced) ---
test("AC4: reject then fix-to-pass loop", () => {
  const project = mkTmpProject();
  seedSession(project, "s", { specSource: FIGMA });
  const png = writePng(project);
  const bad = cleanRows();
  bad[0] = { surface: "card", element: "title", property: "font-size", figma_expected: "14px", impl_actual: "16px", severity: "Trivial" };
  const r1 = runComplete(project, "s", withDesign(baseGate(png), { source: FIGMA, surfaces: [{ name: "card" }], rows: bad }));
  assert.equal(r1.status, 2, r1.stdout);
  // corrected: impl now matches expected
  const good = cleanRows();
  good[0] = { surface: "card", element: "title", property: "font-size", figma_expected: "14px", impl_actual: "14px", severity: "None" };
  const r2 = runCatState(
    ["goal", "checkpoint", "--session", "s", "--goal", "G001", "--status", "complete", "--quality-gate-json", "-"],
    { cwd: project, input: JSON.stringify(withDesign(baseGate(png), { source: FIGMA, surfaces: [{ name: "card" }], rows: good })) }
  );
  assert.equal(r2.status, 0, r2.stderr);
});

// --- AC5: no design source → behaves exactly as today (today-shaped gate accepts) ---
test("AC5: no design source on record → today-shaped gate accepts (non-trigger identical)", () => {
  const project = mkTmpProject();
  seedSession(project, "s"); // no spec/plan/goal design URL
  const png = writePng(project);
  const gate = baseGate(png); // NO qa.design — would fail if the gate fired
  const r = runComplete(project, "s", gate);
  assert.equal(r.status, 0, r.stderr);
  const receipt = JSON.parse(r.stdout);
  assert.equal(receipt.status, "complete");
});

// --- AC6: source on record, NO screenshot → qa.design STILL required ---
test("AC6: source on record + no screenshot, qa.design absent → exit 2", () => {
  const project = mkTmpProject();
  seedSession(project, "s", { specSource: FIGMA });
  const gate = baseGate(null); // no artifacts at all
  const r = runComplete(project, "s", gate);
  assert.equal(r.status, 2, r.stdout);
  assert.match(r.stderr, /qa\.design is missing/);
});

// --- AC6b: source recorded ONLY in the approved plan → gate fires ---
test("AC6b: plan-only design source fires the gate", () => {
  const project = mkTmpProject();
  seedSession(project, "s", { planSource: FIGMA }); // no spec, no goal URL
  const png = writePng(project);
  const r = runComplete(project, "s", baseGate(png)); // no qa.design
  assert.equal(r.status, 2, r.stdout);
  assert.match(r.stderr, /qa\.design is missing/);
});

// --- AC6c: source recorded ONLY in the goal brief → gate fires ---
test("AC6c: goal-brief-only design source fires the gate", () => {
  const project = mkTmpProject();
  seedSession(project, "s", { brief: `Build the card UI to match ${FIGMA}` });
  const png = writePng(project);
  const r = runComplete(project, "s", baseGate(png)); // no qa.design
  assert.equal(r.status, 2, r.stdout);
  assert.match(r.stderr, /qa\.design is missing/);
});

// --- AC7: source on record, qa.design absent, no hatch → exit 2 ---
test("AC7: source on record, qa.design absent (screenshot present), no hatch → exit 2", () => {
  const project = mkTmpProject();
  seedSession(project, "s", { specSource: FIGMA });
  const png = writePng(project);
  const r = runComplete(project, "s", baseGate(png));
  assert.equal(r.status, 2, r.stdout);
  assert.match(r.stderr, /qa\.design is missing/);
});

// --- AC8a: not_applicable with reason + no screenshot + nested architect ack → passes ---
test("AC8a: valid not_applicable hatch passes", () => {
  const project = mkTmpProject();
  seedSession(project, "s", { specSource: FIGMA });
  const gate = baseGate(null); // NO screenshot
  gate.architect_review.design_not_applicable_acknowledged = true;
  gate.qa.design = { not_applicable: { reason: "This goal is a pure backend migration with no rendered UI surface to measure." } };
  const r = runComplete(project, "s", gate);
  assert.equal(r.status, 0, r.stderr);
});

// --- AC8a2: not_applicable ack missing / screenshot present / placeholder reason → exit 2 ---
test("AC8a2: not_applicable invalid forms reject", () => {
  const na = "This goal is a pure backend migration with no rendered UI surface to measure.";
  // (i) ack missing
  {
    const project = mkTmpProject();
    seedSession(project, "s", { specSource: FIGMA });
    const gate = baseGate(null);
    gate.qa.design = { not_applicable: { reason: na } };
    const r = runComplete(project, "s", gate);
    assert.equal(r.status, 2, r.stdout);
    assert.match(r.stderr, /design_not_applicable_acknowledged/);
  }
  // (ii) screenshot present
  {
    const project = mkTmpProject();
    seedSession(project, "s", { specSource: FIGMA });
    const png = writePng(project);
    const gate = baseGate(png);
    gate.architect_review.design_not_applicable_acknowledged = true;
    gate.qa.design = { not_applicable: { reason: na } };
    const r = runComplete(project, "s", gate);
    assert.equal(r.status, 2, r.stdout);
    assert.match(r.stderr, /a screenshot artifact is present/);
  }
  // (iii) placeholder reason
  {
    const project = mkTmpProject();
    seedSession(project, "s", { specSource: FIGMA });
    const gate = baseGate(null);
    gate.architect_review.design_not_applicable_acknowledged = true;
    gate.qa.design = { not_applicable: { reason: "n/a" } };
    const r = runComplete(project, "s", gate);
    assert.equal(r.status, 2, r.stdout);
    assert.match(r.stderr, /not_applicable\.reason must be substantive/);
  }
});

// --- AC8b: waived Major with/without user_acknowledged + missing surface ---
test("AC8b: waived Major hatch — user_acknowledged + surface listed gates the outcome", () => {
  const reason = "Product accepted the 3px title size delta this sprint; a follow-up ticket tracks the exact match.";
  function majorGate(png) {
    const rows = cleanRows();
    rows[0] = { surface: "card", element: "title", property: "font-size", figma_expected: "14px", impl_actual: "17px", severity: "Major" };
    return withDesign(baseGate(png), { source: FIGMA, surfaces: [{ name: "card" }], rows });
  }
  // passes: user_acknowledged + surface listed
  {
    const project = mkTmpProject();
    seedSession(project, "s", { specSource: FIGMA });
    const gate = majorGate(writePng(project));
    gate.qa.design.waived = { reason, surfaces: ["card"], user_acknowledged: true };
    const r = runComplete(project, "s", gate);
    assert.equal(r.status, 0, r.stderr);
  }
  // rejects: without user_acknowledged
  {
    const project = mkTmpProject();
    seedSession(project, "s", { specSource: FIGMA });
    const gate = majorGate(writePng(project));
    gate.qa.design.waived = { reason, surfaces: ["card"] };
    const r = runComplete(project, "s", gate);
    assert.equal(r.status, 2, r.stdout);
    assert.match(r.stderr, /user_acknowledged must be true/);
  }
  // rejects: surface not listed
  {
    const project = mkTmpProject();
    seedSession(project, "s", { specSource: FIGMA });
    const gate = majorGate(writePng(project));
    gate.qa.design.waived = { reason, surfaces: ["other"], user_acknowledged: true };
    const r = runComplete(project, "s", gate);
    assert.equal(r.status, 2, r.stdout);
    assert.match(r.stderr, /does not list surface "card"/);
  }
});

// --- AC8c: waived clearing a computed CRITICAL → exit 2 regardless of user_acknowledged ---
test("AC8c: waived can never clear a computed Critical", () => {
  const project = mkTmpProject();
  seedSession(project, "s", { specSource: FIGMA });
  const png = writePng(project);
  const rows = cleanRows();
  rows.push({ surface: "card", element: "bg", property: "color", figma_expected: "#ff0000", impl_actual: "#00ff00", severity: "Critical" });
  const gate = withDesign(baseGate(png), { source: FIGMA, surfaces: [{ name: "card" }], rows });
  gate.qa.design.waived = { reason: "Team asked to ship despite the color mismatch for the demo deadline tonight.", surfaces: ["card"], user_acknowledged: true };
  const r = runComplete(project, "s", gate);
  assert.equal(r.status, 2, r.stdout);
  assert.match(r.stderr, /can NEVER be waived/);
});

// --- AC9: placeholder/blank in a MANDATORY row → exit 2 naming row ---
test("AC9: placeholder value in a mandatory row rejects", () => {
  const project = mkTmpProject();
  seedSession(project, "s", { specSource: FIGMA });
  const png = writePng(project);
  const rows = cleanRows();
  rows[0] = { surface: "card", element: "title", property: "font-size", figma_expected: "16px", impl_actual: "", severity: "None" };
  const gate = withDesign(baseGate(png), { source: FIGMA, surfaces: [{ name: "card" }], rows });
  const r = runComplete(project, "s", gate);
  assert.equal(r.status, 2, r.stdout);
  assert.match(r.stderr, /unparseable measured value/);
});

// --- AC10: parser boundaries ---
test("AC10: parser boundaries (rgb/rgba, rem, sub-pixel, normal, 2px vs 2.01px)", () => {
  // pass case: rgb==hex, 1rem==16px, 15.999px==16px, letter-spacing normal==0, padding delta exactly 2px
  {
    const project = mkTmpProject();
    seedSession(project, "s", { specSource: FIGMA });
    const png = writePng(project);
    const rows = [
      { surface: "card", element: "title", property: "font-size", figma_expected: "16px", impl_actual: "1rem", severity: "None" },
      { surface: "card", element: "title", property: "line-height", figma_expected: "16px", impl_actual: "15.999px", severity: "None" },
      { surface: "card", element: "title", property: "font-weight", figma_expected: "700", impl_actual: "700", severity: "None" },
      { surface: "card", element: "title", property: "letter-spacing", figma_expected: "normal", impl_actual: "0", severity: "None" },
      { surface: "card", element: "bg", property: "background-color", figma_expected: "#ff0000", impl_actual: "rgb(255, 0, 0)", severity: "None" },
      { surface: "card", element: "box", property: "padding", figma_expected: "10px", impl_actual: "12px", severity: "None" },
    ];
    const gate = withDesign(baseGate(png), { source: FIGMA, surfaces: [{ name: "card" }], rows });
    const r = runComplete(project, "s", gate);
    assert.equal(r.status, 0, r.stderr);
  }
  // reject: padding delta 2.01px → Major (submitted None is a downgrade)
  {
    const project = mkTmpProject();
    seedSession(project, "s", { specSource: FIGMA });
    const png = writePng(project);
    const rows = cleanRows();
    rows[3] = { surface: "card", element: "box", property: "padding", figma_expected: "10px", impl_actual: "12.01px", severity: "None" };
    const gate = withDesign(baseGate(png), { source: FIGMA, surfaces: [{ name: "card" }], rows });
    const r = runComplete(project, "s", gate);
    assert.equal(r.status, 2, r.stdout);
    assert.match(r.stderr, /recomputed "Major"/);
  }
  // reject: one-channel color mismatch → Critical (submitted None is a downgrade)
  {
    const project = mkTmpProject();
    seedSession(project, "s", { specSource: FIGMA });
    const png = writePng(project);
    const rows = cleanRows();
    rows.push({ surface: "card", element: "bg", property: "color", figma_expected: "#ff0000", impl_actual: "#fe0000", severity: "None" });
    const gate = withDesign(baseGate(png), { source: FIGMA, surfaces: [{ name: "card" }], rows });
    const r = runComplete(project, "s", gate);
    assert.equal(r.status, 2, r.stdout);
    assert.match(r.stderr, /Critical/);
  }
});

// --- AC11: a design source in a DIFFERENT session is NOT scanned ---
test("AC11: cross-session spec design source is not scanned (inert)", () => {
  const project = mkTmpProject();
  // other session HAS a design source
  seedSession(project, "other", { specSource: FIGMA });
  // target session has none
  seedSession(project, "s");
  const png = writePng(project);
  const r = runComplete(project, "s", baseGate(png)); // no qa.design
  assert.equal(r.status, 0, r.stderr); // gate did NOT fire despite the other session's URL
});

// --- AC12: unparseable OPTIONAL skipped; unparseable MANDATORY rejects ---
test("AC12: optional unparseable skipped, mandatory unparseable rejects", () => {
  // optional (letter-spacing auto) skipped → passes
  {
    const project = mkTmpProject();
    seedSession(project, "s", { specSource: FIGMA });
    const png = writePng(project);
    const rows = cleanRows();
    rows.push({ surface: "card", element: "title", property: "letter-spacing", figma_expected: "0.5px", impl_actual: "auto", severity: "None" });
    const gate = withDesign(baseGate(png), { source: FIGMA, surfaces: [{ name: "card" }], rows });
    const r = runComplete(project, "s", gate);
    assert.equal(r.status, 0, r.stderr);
  }
  // mandatory (font-size auto) rejects
  {
    const project = mkTmpProject();
    seedSession(project, "s", { specSource: FIGMA });
    const png = writePng(project);
    const rows = cleanRows();
    rows[0] = { surface: "card", element: "title", property: "font-size", figma_expected: "16px", impl_actual: "auto", severity: "None" };
    const gate = withDesign(baseGate(png), { source: FIGMA, surfaces: [{ name: "card" }], rows });
    const r = runComplete(project, "s", gate);
    assert.equal(r.status, 2, r.stdout);
    assert.match(r.stderr, /unparseable measured value/);
  }
});

// --- AC13: accepted hatch anchored in ledger.jsonl; rejected attempt in audit.jsonl ---
test("AC13: accepted waived anchors qa.design in ledger; rejected attempt lands in audit", () => {
  const reason = "Product accepted the title size delta this sprint; a follow-up ticket tracks the exact match.";
  const project = mkTmpProject();
  seedSession(project, "s", { specSource: FIGMA });
  const png = writePng(project);
  const rows = cleanRows();
  rows[0] = { surface: "card", element: "title", property: "font-size", figma_expected: "14px", impl_actual: "17px", severity: "Major" };
  // rejected attempt first (no user_acknowledged)
  const bad = withDesign(baseGate(png), { source: FIGMA, surfaces: [{ name: "card" }], rows });
  bad.qa.design.waived = { reason, surfaces: ["card"] };
  const r1 = runComplete(project, "s", bad);
  assert.equal(r1.status, 2, r1.stdout);
  const audit = readAudit(project, "s");
  assert.ok(audit.some((a) => a.verb === "quality_gate_refused" && JSON.stringify(a.reasons).includes("user_acknowledged")), "refusal recorded in audit.jsonl");
  // accepted attempt
  const good = withDesign(baseGate(png), { source: FIGMA, surfaces: [{ name: "card" }], rows });
  good.qa.design.waived = { reason, surfaces: ["card"], user_acknowledged: true };
  const r2 = runCatState(
    ["goal", "checkpoint", "--session", "s", "--goal", "G001", "--status", "complete", "--quality-gate-json", "-"],
    { cwd: project, input: JSON.stringify(good) }
  );
  assert.equal(r2.status, 0, r2.stderr);
  const ledger = readLedger(project, "s");
  const row = ledger.find((e) => e.event === "goal_checkpointed" && e.status === "complete");
  assert.ok(row, "goal_checkpointed complete row present");
  assert.equal(row.quality_gate.qa.design.waived.user_acknowledged, true);
  assert.deepEqual(row.quality_gate.qa.design.waived.surfaces, ["card"]);
});

// --- AC15: optional-skip writes an auditAppend note AND the checkpoint passes ---
test("AC15: optional-row skip writes a design_optional_row_skipped audit note and passes", () => {
  const project = mkTmpProject();
  seedSession(project, "s", { specSource: FIGMA });
  const png = writePng(project);
  const rows = cleanRows();
  rows.push({ surface: "card", element: "title", property: "letter-spacing", figma_expected: "0.5px", impl_actual: "auto", severity: "None" });
  const gate = withDesign(baseGate(png), { source: FIGMA, surfaces: [{ name: "card" }], rows });
  const r = runComplete(project, "s", gate);
  assert.equal(r.status, 0, r.stderr);
  const note = readAudit(project, "s").find((a) => a.verb === "design_optional_row_skipped");
  assert.ok(note, "audit note written");
  assert.equal(note.surface, "card");
  assert.equal(note.property, "letter-spacing");
});

// --- AC16: computed-Critical fixture — waived AND not_applicable both exit 2 ---
test("AC16: a computed Critical cannot be bypassed by waived or not_applicable", () => {
  const na = "This surface is non-UI backend glue with no rendered output to measure.";
  const criticalRows = () => {
    const rows = cleanRows();
    rows.push({ surface: "card", element: "bg", property: "color", figma_expected: "#ff0000", impl_actual: "#00ff00", severity: "Critical" });
    return rows;
  };
  // waived path
  {
    const project = mkTmpProject();
    seedSession(project, "s", { specSource: FIGMA });
    const png = writePng(project);
    const gate = withDesign(baseGate(png), { source: FIGMA, surfaces: [{ name: "card" }], rows: criticalRows() });
    gate.qa.design.waived = { reason: "Team asked to ship despite the color mismatch for tonight's demo deadline.", surfaces: ["card"], user_acknowledged: true };
    const r = runComplete(project, "s", gate);
    assert.equal(r.status, 2, r.stdout);
    assert.match(r.stderr, /can NEVER be waived/);
  }
  // not_applicable path (screenshot present → invalid)
  {
    const project = mkTmpProject();
    seedSession(project, "s", { specSource: FIGMA });
    const png = writePng(project);
    const gate = baseGate(png);
    gate.architect_review.design_not_applicable_acknowledged = true;
    gate.qa.design = { not_applicable: { reason: na } };
    const r = runComplete(project, "s", gate);
    assert.equal(r.status, 2, r.stdout);
    assert.match(r.stderr, /a screenshot artifact is present/);
  }
});

// --- AC17: alias-form gate carrying a not_applicable → exit 2 ---
test("AC17: alias-form gate cannot express the not_applicable acknowledgement → exit 2", () => {
  const project = mkTmpProject();
  seedSession(project, "s", { specSource: FIGMA });
  const gate = {
    architect_verdicts: { architecture: "CLEAR" },
    architect_recommendation: "APPROVE",
    architect_evidence: "Reviewed the change end to end and confirmed the non-UI lane is clear.",
    architect_blockers: [],
    qa: {
      status: "passed",
      commands: ["node --test"],
      evidence: "Executed the suite and confirmed the backend-only change is complete and correct.",
      artifacts: [],
      blockers: [],
      design: { not_applicable: { reason: "This goal is a pure backend migration with no rendered UI surface to measure." } },
    },
  };
  const r = runComplete(project, "s", gate);
  assert.equal(r.status, 2, r.stdout);
  assert.match(r.stderr, /design_not_applicable_acknowledged/);
});

// --- AC18: waived Major with user_acknowledged passes with NO architect ack ---
test("AC18: waiver authority is the USER — waived Major passes with no architect ack", () => {
  const project = mkTmpProject();
  seedSession(project, "s", { specSource: FIGMA });
  const png = writePng(project);
  const rows = cleanRows();
  rows[0] = { surface: "card", element: "title", property: "font-size", figma_expected: "14px", impl_actual: "17px", severity: "Major" };
  const gate = withDesign(baseGate(png), { source: FIGMA, surfaces: [{ name: "card" }], rows });
  // NOTE: no architect_review.design_not_applicable_acknowledged anywhere
  gate.qa.design.waived = { reason: "Product accepted the title size delta this sprint; a follow-up ticket tracks the exact match.", surfaces: ["card"], user_acknowledged: true };
  assert.equal(gate.architect_review.design_not_applicable_acknowledged, undefined);
  const r = runComplete(project, "s", gate);
  assert.equal(r.status, 0, r.stderr);
});

// --- AC19: plan-sourced + clean matrix → exit 0 ---
test("AC19: plan-sourced design + clean matrix passes", () => {
  const project = mkTmpProject();
  seedSession(project, "s", { planSource: FIGMA });
  const png = writePng(project);
  const gate = withDesign(baseGate(png), { source: FIGMA, surfaces: [{ name: "card" }], rows: cleanRows() });
  const r = runComplete(project, "s", gate);
  assert.equal(r.status, 0, r.stderr);
});

// --- NEW sibling-goal AC: a URL only in an unrelated sibling goal does NOT trigger ---
test("AC-sibling: a design URL only in a sibling goal's objective does not gate the non-UI goal", () => {
  const project = mkTmpProject();
  const brief = `@goal Migrate the orders database to the new schema\n@goal Build the card UI to match ${FIGMA}`;
  seedSession(project, "s", { brief });
  const png = writePng(project);
  // Checkpoint G001 (the non-UI, no-URL goal) with a today-shaped gate, no qa.design.
  const r = runComplete(project, "s", baseGate(png), "G001");
  assert.equal(r.status, 0, r.stderr); // sibling G002's URL must not trigger the gate for G001
});

// =====================================================================
// RED-TEAM (G001 QA lane): adversarial probes against the mechanical gate.
// The two "KNOWN GAP" tests below assert the CURRENT (bypassable) behavior
// as a trip-wire, not as endorsed behavior — see the finding comment on
// each. If the gate is hardened to close a gap, the matching test's
// assertion must flip (exit 0 -> exit 2) as part of that fix, not be
// deleted silently.
// =====================================================================

// --- REGRESSION (FIX 1, was KNOWN GAP): a duplicate surface name used to let
// the LAST no_text win in a last-wins Map, silently dropping mandatory
// typography (font-size/line-height/font-weight) coverage for a surface first
// declared no_text:false. The gate now rejects a duplicate surface name as a
// malformed matrix (exit 2), naming the duplicated surface.
test("FIX 1: duplicate surface name is rejected as a malformed matrix (exit 2)", () => {
  const project = mkTmpProject();
  seedSession(project, "s", { specSource: FIGMA });
  const png = writePng(project);
  const rows = [{ surface: "card", element: "box", property: "padding", figma_expected: "16px", impl_actual: "16px", severity: "None" }];
  const gate = withDesign(baseGate(png), {
    source: FIGMA,
    surfaces: [{ name: "card", no_text: false }, { name: "card", no_text: true }],
    rows,
  });
  const r = runComplete(project, "s", gate);
  assert.equal(r.status, 2, r.stdout);
  assert.match(r.stderr, /duplicate surface name "card"/);
});

// --- DOCUMENTED RESIDUAL [R9] (coverage-floor): mandatory coverage is enforced
// per SURFACE, not per ELEMENT. A surface with two rendered elements — one
// clean, one carrying a real unresolved font-size mismatch — can pass by
// submitting rows ONLY for the clean element; the defective element's rows are
// simply omitted and per-surface coverage is still satisfied.
//
// This is NOT mechanically fixable in a zero-dep CLI: the CLI cannot enumerate
// which elements a surface actually renders, so it cannot know a row is missing.
// DISCLOSED coverage-floor residual [R9]: mitigated by design-qa.md
// per-variant/per-element enumeration doctrine + architect spot-check, not
// mechanically enforceable. This test pins the honest documented exit-0 limit
// so it stays a KNOWN, DISCLOSED behavior rather than a silent regression.
test("DOCUMENTED RESIDUAL [R9]: per-surface (not per-element) coverage — honest exit 0 limit", () => {
  const project = mkTmpProject();
  seedSession(project, "s", { specSource: FIGMA });
  const png = writePng(project);
  const rows = [
    // only the clean "title-good" element is measured; a sibling "subtitle"
    // element with a real 16px-designed/30px-shipped Major gap never appears.
    { surface: "card", element: "title-good", property: "font-size", figma_expected: "16px", impl_actual: "16px", severity: "None" },
    { surface: "card", element: "title-good", property: "line-height", figma_expected: "24px", impl_actual: "24px", severity: "None" },
    { surface: "card", element: "title-good", property: "font-weight", figma_expected: "700", impl_actual: "700", severity: "None" },
    { surface: "card", element: "title-good", property: "padding", figma_expected: "16px", impl_actual: "16px", severity: "None" },
  ];
  const gate = withDesign(baseGate(png), { source: FIGMA, surfaces: [{ name: "card" }], rows });
  const r = runComplete(project, "s", gate);
  // Asserts the DISCLOSED residual [R9]: a zero-dep CLI cannot enumerate a
  // surface's elements, so an omitted element's defect cannot be mechanically
  // caught. Kept green intentionally as a documented limit, not a hidden bypass.
  assert.equal(r.status, 0, r.stderr);
});

// --- Hardening check (HOLDS): not_applicable with a screenshot present is
// still rejected even through a mixed alias/nested gate shape (top-level
// architect_* aliases combined with a nested architect_review carrying
// ONLY the ack field) — confirms the screenshot-presence check is not
// alias-form-dependent.
test("mixed alias/nested gate: not_applicable still rejects when a screenshot is present", () => {
  const project = mkTmpProject();
  seedSession(project, "s", { specSource: FIGMA });
  const png = writePng(project);
  const gate = {
    architect_verdicts: { architecture: "CLEAR" },
    architect_recommendation: "APPROVE",
    architect_evidence: "Reviewed the change end to end and confirmed the non-UI lane is clear.",
    architect_blockers: [],
    architect_review: { design_not_applicable_acknowledged: true }, // ack lives only here
    qa: {
      status: "passed",
      commands: ["node --test"],
      evidence: "Executed the suite and confirmed the backend-only change is complete and correct.",
      artifacts: [{ kind: "screenshot", path: png }],
      blockers: [],
      design: { not_applicable: { reason: "This goal is a pure backend migration with no rendered UI surface to measure." } },
    },
  };
  const r = runComplete(project, "s", gate);
  assert.equal(r.status, 2, r.stdout);
  assert.match(r.stderr, /a screenshot artifact is present/);
});

// --- FIX 2: a per-side spacing row (padding-left) is a RECOGNIZED property AND
// satisfies the mandatory per-surface spacing coverage floor. A doctrine-faithful
// matrix using padding-left instead of aggregate padding must be passable.
test("FIX 2: per-side padding-left is recognized and satisfies spacing coverage", () => {
  const project = mkTmpProject();
  seedSession(project, "s", { specSource: FIGMA });
  const png = writePng(project);
  const rows = [
    { surface: "card", element: "title", property: "font-size", figma_expected: "16px", impl_actual: "16px", severity: "None" },
    { surface: "card", element: "title", property: "line-height", figma_expected: "24px", impl_actual: "24px", severity: "None" },
    { surface: "card", element: "title", property: "font-weight", figma_expected: "700", impl_actual: "700", severity: "None" },
    // per-side spacing only — no aggregate padding/margin/gap row present.
    { surface: "card", element: "box", property: "padding-left", figma_expected: "16px", impl_actual: "16px", severity: "None" },
  ];
  const gate = withDesign(baseGate(png), { source: FIGMA, surfaces: [{ name: "card" }], rows });
  const r = runComplete(project, "s", gate);
  assert.equal(r.status, 0, r.stderr);
});

// --- FIX 2b: a per-side spacing delta beyond ±2px computes Major (same class as
// aggregate spacing) and is caught if submitted more leniently.
test("FIX 2b: per-side margin-top over tolerance computes Major", () => {
  const project = mkTmpProject();
  seedSession(project, "s", { specSource: FIGMA });
  const png = writePng(project);
  const rows = cleanRows();
  rows.push({ surface: "card", element: "box", property: "margin-top", figma_expected: "8px", impl_actual: "20px", severity: "Minor" });
  const gate = withDesign(baseGate(png), { source: FIGMA, surfaces: [{ name: "card" }], rows });
  const r = runComplete(project, "s", gate);
  assert.equal(r.status, 2, r.stdout);
  assert.match(r.stderr, /more lenient than the CLI-recomputed "Major"/);
});

// --- FIX 3: border-radius reconciled to a ±2px LENGTH / Major contract (not
// exact-px Critical). Within tolerance → None (passes as an optional row);
// beyond tolerance → Major (waivable), never Critical.
test("FIX 3: border-radius within ±2px passes (None), not Critical", () => {
  const project = mkTmpProject();
  seedSession(project, "s", { specSource: FIGMA });
  const png = writePng(project);
  const rows = cleanRows();
  // 8px designed vs 9px shipped — 1px delta, within ±2px → None.
  rows.push({ surface: "card", element: "box", property: "border-radius", figma_expected: "8px", impl_actual: "9px", severity: "None" });
  const gate = withDesign(baseGate(png), { source: FIGMA, surfaces: [{ name: "card" }], rows });
  const r = runComplete(project, "s", gate);
  assert.equal(r.status, 0, r.stderr);
});

test("FIX 3b: border-radius beyond ±2px computes Major (waivable), not Critical", () => {
  const project = mkTmpProject();
  seedSession(project, "s", { specSource: FIGMA });
  const png = writePng(project);
  const rows = cleanRows();
  // 8px designed vs 16px shipped — 8px delta → Major; submitting "Minor" is caught.
  rows.push({ surface: "card", element: "box", property: "border-radius", figma_expected: "8px", impl_actual: "16px", severity: "Minor" });
  const gate = withDesign(baseGate(png), { source: FIGMA, surfaces: [{ name: "card" }], rows });
  const r = runComplete(project, "s", gate);
  assert.equal(r.status, 2, r.stdout);
  assert.match(r.stderr, /more lenient than the CLI-recomputed "Major"/);
  assert.doesNotMatch(r.stderr, /Critical/);
});

// =====================================================================
// RE-VERIFY (G001 QA re-verify pass): confirms FIX 1 and FIX 3 closed the
// bypasses honestly (not just the exact fixture that first exposed them) and
// that the new per-side/border-radius surface didn't open a fresh one.
// =====================================================================

// --- FIX 1b: duplicate surface names are rejected even when BOTH entries
// agree on no_text (the original fixture only exercised the false/true mix;
// this pins that any duplicate — not just a disagreeing pair — is malformed).
test("FIX 1b: duplicate surface name rejected even when both entries agree on no_text", () => {
  const project = mkTmpProject();
  seedSession(project, "s", { specSource: FIGMA });
  const png = writePng(project);
  const rows = [{ surface: "card", element: "box", property: "padding", figma_expected: "16px", impl_actual: "16px", severity: "None" }];
  const gate = withDesign(baseGate(png), {
    source: FIGMA,
    surfaces: [{ name: "card", no_text: false }, { name: "card", no_text: false }],
    rows,
  });
  const r = runComplete(project, "s", gate);
  assert.equal(r.status, 2, r.stdout);
  assert.match(r.stderr, /duplicate surface name "card"/);
});

// --- isSpacingProperty does not over-accept: a made-up "padding-foo" side is
// not a recognized property at all, so it can neither satisfy the mandatory
// spacing floor nor slip through unnoticed — it hard-rejects the row.
test("RE-VERIFY: made-up per-side property (padding-foo) is rejected as unrecognized, not accepted as spacing", () => {
  const project = mkTmpProject();
  seedSession(project, "s", { specSource: FIGMA });
  const png = writePng(project);
  const rows = [
    ...cleanRows().filter((r) => r.property !== "padding"),
    { surface: "card", element: "box", property: "padding-foo", figma_expected: "16px", impl_actual: "16px", severity: "None" },
  ];
  const gate = withDesign(baseGate(png), { source: FIGMA, surfaces: [{ name: "card" }], rows });
  const r = runComplete(project, "s", gate);
  assert.equal(r.status, 2, r.stdout);
  assert.match(r.stderr, /not a recognized design property/);
});

// --- RE-VERIFY: a real border-radius Major gap, submitted with the correct
// (non-downgraded) severity, still BLOCKS without a proper user-gated waiver —
// the ±2px/Major reclassification (FIX 3) only made it waivable, not free.
test("RE-VERIFY: border-radius Major with correct severity but no waiver still blocks", () => {
  const project = mkTmpProject();
  seedSession(project, "s", { specSource: FIGMA });
  const png = writePng(project);
  const rows = cleanRows();
  rows.push({ surface: "card", element: "box", property: "border-radius", figma_expected: "8px", impl_actual: "20px", severity: "Major" });
  const gate = withDesign(baseGate(png), { source: FIGMA, surfaces: [{ name: "card" }], rows });
  const r = runComplete(project, "s", gate);
  assert.equal(r.status, 2, r.stdout);
  assert.match(r.stderr, /resolve it, or record a user-acknowledged/);
});

// --- RE-VERIFY: the same border-radius Major DOES pass once properly waived
// (user_acknowledged + surface listed) — confirms the waivable path actually
// works end to end, not just that the unwaived path blocks.
test("RE-VERIFY: border-radius Major passes once properly user-waived", () => {
  const project = mkTmpProject();
  seedSession(project, "s", { specSource: FIGMA });
  const png = writePng(project);
  const rows = cleanRows();
  rows.push({ surface: "card", element: "box", property: "border-radius", figma_expected: "8px", impl_actual: "20px", severity: "Major" });
  const gate = withDesign(baseGate(png), { source: FIGMA, surfaces: [{ name: "card" }], rows });
  gate.qa.design.waived = { reason: "Team accepted the larger border-radius for this sprint per design review notes.", surfaces: ["card"], user_acknowledged: true };
  const r = runComplete(project, "s", gate);
  assert.equal(r.status, 0, r.stderr);
});

// --- RE-VERIFY: Critical is NEVER waivable even when it shares a surface with
// a properly-waived Major — the two severities are independent gates, and a
// waiver naming the surface for its Major gap must not spill over to a
// co-located Critical gap on the same surface.
test("RE-VERIFY: Critical still blocks even alongside a properly-waived Major on the same surface", () => {
  const project = mkTmpProject();
  seedSession(project, "s", { specSource: FIGMA });
  const png = writePng(project);
  const rows = cleanRows();
  rows.push({ surface: "card", element: "bg", property: "color", figma_expected: "#ff0000", impl_actual: "#00ff00", severity: "Critical" });
  rows.push({ surface: "card", element: "box", property: "border-radius", figma_expected: "8px", impl_actual: "20px", severity: "Major" });
  const gate = withDesign(baseGate(png), { source: FIGMA, surfaces: [{ name: "card" }], rows });
  gate.qa.design.waived = { reason: "Team accepted the border-radius delta for this sprint per design review notes.", surfaces: ["card"], user_acknowledged: true };
  const r = runComplete(project, "s", gate);
  assert.equal(r.status, 2, r.stdout);
  assert.match(r.stderr, /can NEVER be waived/);
});

// --- AC14: the full pre-existing suite stays green — covered by running this file. ---
