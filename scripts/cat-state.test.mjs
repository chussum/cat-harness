/**
 * scripts/cat-state.test.mjs — coverage for the G004 `dialogue append`
 * subcommand (the sanctioned CLI path for appending to
 * state/dialogue-excerpts.jsonl, the append-only sibling of `ledger append`
 * but scoped to state/** rather than ultragoal/). cat-state.mjs calls an
 * unconditional main() at module scope that reads stdin and calls
 * process.exit, so it is exercised as a real child process here — its actual
 * invocation contract (argv + stdin JSON, stdout JSON, exit code) — treating
 * cat-hook.mjs/cat-state.mjs as un-importable.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import zlib from "node:zlib";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CAT_STATE = path.join(HERE, "cat-state.mjs");

// WS2 (graph build/graph query) needs node:sqlite, only unflagged on Node
// 22.13.0+. The graph tests below spawn cat-state.mjs with `process.execPath`
// (whichever node is running THIS test file), so node:sqlite's availability
// in the CURRENT process is the right proxy for "can these tests run for
// real" — on the repo's default Node 20 they {skip: ...} cleanly instead of
// failing; on Node 22.13+ they run and assert real behavior.
let GRAPH_SQLITE_AVAILABLE = false;
try {
  await import("node:sqlite");
  GRAPH_SQLITE_AVAILABLE = true;
} catch {
  GRAPH_SQLITE_AVAILABLE = false;
}
const GRAPH_SKIP = GRAPH_SQLITE_AVAILABLE ? false : "node:sqlite unavailable on this Node version (needs 22.13.0+)";

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
// WS1 reviewer-diet regression: ralplan state envelope free-merges the
// risk-tiered reviewer fields (reviewer_tier / reviewer_model) without any
// schema change to cmdStateWrite — proving the existing free-merge already
// accepts these new fields (stage-18-revision.md WS1 table).
// =====================================================================

test("state write: ralplan reviewer_tier/reviewer_model fields free-merge and round-trip", () => {
  const project = mkTmpProject();
  const sid = "s1";

  const initResult = runCatState(
    ["state", "write", "--session", sid, "--skill", "ralplan", "--json",
      JSON.stringify({ skill: "ralplan", active: true, current_phase: "planner", run_id: "r1" })],
    { cwd: project }
  );
  assert.equal(initResult.status, 0, initResult.stderr);

  // Deliberately omit run_id here: it was only set by the FIRST write above. If the
  // free-merge were broken (e.g. `merged = { ...incoming }`, dropping prior state),
  // run_id would vanish from the read-back below and this test would fail.
  const reviewResult = runCatState(
    ["state", "write", "--session", sid, "--skill", "ralplan", "--json",
      JSON.stringify({
        skill: "ralplan",
        active: true,
        current_phase: "review",
        reviewer_tier: "lite",
        reviewer_model: "sonnet",
      })],
    { cwd: project }
  );
  assert.equal(reviewResult.status, 0, reviewResult.stderr);
  const receipt = JSON.parse(reviewResult.stdout);
  assert.equal(receipt.ok, true);
  assert.equal(receipt.current_phase, "review");

  const readResult = runCatState(["state", "read", "--session", sid, "--skill", "ralplan"], { cwd: project });
  assert.equal(readResult.status, 0, readResult.stderr);
  const state = JSON.parse(readResult.stdout);
  assert.equal(state.reviewer_tier, "lite");
  assert.equal(state.reviewer_model, "sonnet");
  assert.equal(state.run_id, "r1", "prior fields must survive the free-merge alongside the new ones, even when the second write omits them");

  const sessionDir = path.join(project, ".cat", `_session-${sid}`);
  const onDisk = JSON.parse(fs.readFileSync(path.join(sessionDir, "state", "ralplan-state.json"), "utf8"));
  assert.equal(onDisk.reviewer_tier, "lite");
  assert.equal(onDisk.reviewer_model, "sonnet");
});

// =====================================================================
// Design-QA measurement-matrix gate (stage-23-revision.md AC1-AC19 + sibling)
// =====================================================================

const FIGMA = "https://www.figma.com/file/abc123/Card?node-id=1-2";

function sessionRoot(project, sid) {
  return path.join(project, ".cat", `_session-${sid}`);
}

/** Real >=4096-byte PNG fixture (8-byte PNG magic + padding). Deliberately
 *  UNDECODABLE (no valid IHDR/IDAT) — used ONLY for the generic
 *  qa.artifacts screenshot-magic/byte-floor check, never for the visual
 *  (pixel-diff) gate, which needs a REAL decodable PNG (see makeTestPng
 *  below, written independently of cat-state.mjs's decodePng so the decoder
 *  is proven against an outside encoder, not a self-consistent round-trip). */
function writePng(project, name = "shot.png") {
  const p = path.join(project, name);
  const magic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  fs.writeFileSync(p, Buffer.concat([magic, Buffer.alloc(5000)]));
  return p;
}

// =====================================================================
// Real PNG encoder for the design-QA VISUAL gate's decoder tests. Written
// independently of scripts/cat-state.mjs's decodePng() (own CRC32, own PNG
// chunk framing, own scanline filter math) so decode correctness is proven
// against an OUTSIDE encoder, not a self-consistent round-trip that could
// hide a shared bug. Uses an adaptive per-row filter heuristic (minimum
// sum-of-absolute-values, the standard PNG reference-encoder strategy) so a
// noisy/varied fixture naturally exercises all 5 filter types (None/Sub/Up/
// Average/Paeth) across its rows — see "decoder proof" tests below, which
// assert the encoder actually chose more than filter type 0.
// =====================================================================

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function paethPredictorForEncode(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

const PNG_TEST_CHANNELS = { 0: 1, 2: 3, 4: 2, 6: 4 };

/**
 * Encode a real, decodable PNG. `pixelFn(x, y)` returns [r,g,b,a] (only the
 * channels the colorType needs are used). `colorType`: 0 gray, 2 RGB, 4
 * gray+alpha, 6 RGBA. Adaptively picks the byte-minimizing filter per row
 * (proving the decoder's Sub/Up/Average/Paeth un-filter paths, not just None).
 * Returns { buffer, filterCounts } (filterCounts[0..4] = rows using that filter).
 */
function encodeTestPngRaw(width, height, colorType, pixelFn) {
  const channels = PNG_TEST_CHANNELS[colorType];
  const stride = width * channels;
  const unfiltered = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const rgba = pixelFn(x, y);
      const idx = y * stride + x * channels;
      if (colorType === 0) {
        unfiltered[idx] = rgba[0];
      } else if (colorType === 2) {
        unfiltered[idx] = rgba[0]; unfiltered[idx + 1] = rgba[1]; unfiltered[idx + 2] = rgba[2];
      } else if (colorType === 4) {
        unfiltered[idx] = rgba[0]; unfiltered[idx + 1] = rgba[3];
      } else if (colorType === 6) {
        unfiltered[idx] = rgba[0]; unfiltered[idx + 1] = rgba[1]; unfiltered[idx + 2] = rgba[2]; unfiltered[idx + 3] = rgba[3];
      }
    }
  }
  const bpp = channels;
  const raw = Buffer.alloc((stride + 1) * height);
  let prevRowStart = -1;
  const filterCounts = [0, 0, 0, 0, 0];
  for (let y = 0; y < height; y++) {
    const rowStart = y * stride;
    let best = null;
    for (let ft = 0; ft <= 4; ft++) {
      const filtered = Buffer.alloc(stride);
      let sum = 0;
      for (let x = 0; x < stride; x++) {
        const rawByte = unfiltered[rowStart + x];
        const a = x >= bpp ? unfiltered[rowStart + x - bpp] : 0;
        const b = prevRowStart >= 0 ? unfiltered[prevRowStart + x] : 0;
        const c = prevRowStart >= 0 && x >= bpp ? unfiltered[prevRowStart + x - bpp] : 0;
        let v;
        switch (ft) {
          case 0: v = rawByte; break;
          case 1: v = (rawByte - a) & 0xff; break;
          case 2: v = (rawByte - b) & 0xff; break;
          case 3: v = (rawByte - ((a + b) >> 1)) & 0xff; break;
          case 4: v = (rawByte - paethPredictorForEncode(a, b, c)) & 0xff; break;
        }
        filtered[x] = v;
        sum += v < 128 ? v : 256 - v; // signed-magnitude heuristic (standard reference-encoder choice)
      }
      if (!best || sum < best.sum) best = { ft, filtered, sum };
    }
    filterCounts[best.ft]++;
    raw[y * (stride + 1)] = best.ft;
    best.filtered.copy(raw, y * (stride + 1) + 1);
    prevRowStart = rowStart;
  }
  const compressed = zlib.deflateSync(raw);
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData.writeUInt8(8, 8); // bitDepth
  ihdrData.writeUInt8(colorType, 9);
  ihdrData.writeUInt8(0, 10); // compression
  ihdrData.writeUInt8(0, 11); // filter method
  ihdrData.writeUInt8(0, 12); // interlace: none
  const buffer = Buffer.concat([
    PNG_MAGIC,
    pngChunk("IHDR", ihdrData),
    pngChunk("IDAT", compressed),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
  return { buffer, filterCounts };
}

/** Pad a PNG buffer to >= minBytes with a harmless ancillary chunk before IEND
 *  (decodePng ignores unknown chunk types) — needed because the generic
 *  qa.artifacts screenshot check requires >= 4096 bytes on ANY *.png path,
 *  and a flat/simple fixture can compress well under that floor. */
function padPngToMinBytes(buf, minBytes) {
  if (buf.length >= minBytes) return buf;
  const need = Math.max(minBytes - buf.length - 12, 0);
  const data = Buffer.alloc(need, 0x41);
  const chunk = pngChunk("teXt", data);
  const iendStart = buf.length - 12; // IEND is always the last 12 bytes (0-length data)
  return Buffer.concat([buf.subarray(0, iendStart), chunk, buf.subarray(iendStart)]);
}

/** Deterministic per-pixel pseudo-random noise generator (LCG), reproducible
 *  from a seed — used so "identical" fixture pairs are byte-identical and
 *  "different" pairs are exactly reproducible across test runs. */
function noisePixelFn(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    const r = (state >>> 16) & 0xff;
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    const g = (state >>> 16) & 0xff;
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    const b = (state >>> 16) & 0xff;
    return [r, g, b, 255];
  };
}

/**
 * Write a real, decodable PNG fixture to `project/name` and return its
 * absolute path. `opts.minBytes` (default 4096) pads it so it also clears
 * the generic qa.artifacts screenshot floor when registered there.
 */
function makeTestPng(project, name, { width = 64, height = 64, colorType = 6, pixelFn, minBytes = 4096 } = {}) {
  const fn = pixelFn ?? noisePixelFn(name.split("").reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7));
  const { buffer, filterCounts } = encodeTestPngRaw(width, height, colorType, fn);
  const padded = padPngToMinBytes(buffer, minBytes);
  const p = path.join(project, name);
  fs.writeFileSync(p, padded);
  return { path: p, filterCounts, size: padded.length };
}

/** A cheap, DEFAULT visual fixture pair for tests that only care about the
 *  numeric matrix and need the new visual[] structural requirement satisfied
 *  without opinion: identical pixels (same seed) → raw/adjusted ratio 0 →
 *  severity "None", registered nowhere near the numeric assertions under test. */
function defaultVisualFixture(project, surfaceName) {
  const seed = `visual-${surfaceName}`.split("").reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7);
  const figma = makeTestPng(project, `visual-figma-${surfaceName}.png`, { pixelFn: noisePixelFn(seed) });
  const impl = makeTestPng(project, `visual-impl-${surfaceName}.png`, { pixelFn: noisePixelFn(seed) });
  return { figma: figma.path, impl: impl.path };
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

/**
 * Merge a qa.design object into a gate. AUTO-MIGRATION for the visual gate:
 * when `design.surfaces` is present and the caller did not already supply
 * `design.visual` (and this isn't a not_applicable hatch), synthesize a
 * passing qa.design.visual[] entry per declared surface — an identical
 * (raw_diff_ratio 0) makeTestPng pair, per defaultVisualFixture above — and
 * register both PNGs in qa.artifacts. This keeps every PRE-EXISTING numeric-
 * gate test passing unchanged now that qa.design.visual[] is a mandatory
 * structural requirement; tests that care about the visual gate itself pass
 * `design.visual` explicitly and this auto-injection is skipped.
 */
function withDesign(gate, design) {
  let mergedDesign = { ...design };
  let extraArtifacts = [];
  if (Array.isArray(mergedDesign.surfaces) && mergedDesign.visual === undefined && !mergedDesign.not_applicable) {
    const firstArtifactPath = gate.qa && Array.isArray(gate.qa.artifacts) && gate.qa.artifacts[0] ? gate.qa.artifacts[0].path : null;
    if (firstArtifactPath) {
      const project = path.dirname(firstArtifactPath);
      const visual = [];
      for (const s of mergedDesign.surfaces) {
        if (!s || typeof s.name !== "string") continue;
        const { figma, impl } = defaultVisualFixture(project, s.name);
        visual.push({
          surface: s.name,
          figma_export: figma,
          impl_screenshot: impl,
          raw_diff_ratio: 0,
          diff_ratio: 0,
          severity: "None",
          exclude_regions: [],
        });
        extraArtifacts.push({ kind: "screenshot", path: figma }, { kind: "screenshot", path: impl });
      }
      mergedDesign.visual = visual;
    }
  }
  return {
    ...gate,
    qa: {
      ...gate.qa,
      design: mergedDesign,
      artifacts: extraArtifacts.length ? [...(gate.qa.artifacts || []), ...extraArtifacts] : gate.qa.artifacts,
    },
  };
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

// ===========================================================================
// design-QA VISUAL gate (mechanical PNG pixel-diff) — stage-11-revision.md.
// Covers: pure-Node PNG decode (colorType 0/2/4/6, all 5 filter types, proven
// against an independently-written encoder — see encodeTestPngRaw above, NOT
// cat-state.mjs's decodePng); structural fail-closed checks (missing/blank/
// undecodable/JPEG/one-sided/unregistered/too-small, all non-waivable, exit
// 2); the 3-band magnitude classification (None/Major/Blocking) with Major
// waivable exactly like numeric Major and Blocking un-waivable exactly like
// numeric Critical; the pass-11 raw-vs-adjusted-ratio invariant that closes
// the exclude_regions-vs-low-override bypass (the b=0.50 regression); the
// settings.json designQa.visualDiffBlockThreshold override (valid/invalid/
// absent); and recompute-authoritative (server always recomputes from the
// real PNGs, never trusts a submitted raw_diff_ratio/diff_ratio/severity).
// ===========================================================================

function writeSettings(project, obj) {
  const dir = path.join(project, ".cat");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify(obj));
}

/** A real JPEG-magic file, padded past the generic qa.artifacts >=4096-byte
 *  floor — proves the visual gate rejects JPEG on its OWN (PNG-only decoder)
 *  even though the generic screenshot-artifact check would have accepted it. */
function writeJpeg(project, name = "shot.jpg") {
  const p = path.join(project, name);
  const magic = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
  fs.writeFileSync(p, Buffer.concat([magic, Buffer.alloc(5000)]));
  return p;
}

/**
 * A 100x100 (10,000px) PNG whose TOP `diffRows` rows differ (by a
 * well-above-AA_TOLERANCE per-channel delta) between the figma/impl pair and
 * whose remaining rows are identical — gives an EXACT, hand-computable
 * raw_diff_ratio of diffRows/100 with no downscaling (100 < TARGET_LONG_EDGE
 * 480, so resampleBoxAverage is a no-op and the ratio is exact, not
 * approximated by box-average rounding).
 */
function halfDiffPngPair(project, name, diffRows, colorType = 2) {
  const figmaFn = (x, y) => (y < diffRows ? [200, 200, 200, 255] : [100, 100, 100, 255]);
  const implFn = (x, y) => (y < diffRows ? [40, 40, 40, 255] : [100, 100, 100, 255]);
  const figma = makeTestPng(project, `${name}-figma.png`, { width: 100, height: 100, colorType, pixelFn: figmaFn });
  const impl = makeTestPng(project, `${name}-impl.png`, { width: 100, height: 100, colorType, pixelFn: implFn });
  return { figma: figma.path, impl: impl.path };
}

/**
 * A 100x100 colorType-4 (gray+alpha) PNG pair whose TOP `diffRows` rows
 * differ ONLY in alpha (gray=0 on BOTH sides; alpha 255 [opaque black] on
 * figma vs 0 [fully transparent, composites to white] on impl) and whose
 * remaining rows are identical (opaque gray=100 both sides). Proves
 * decodePng reads the alpha byte at srcIdx+1 (colorType-4's second channel,
 * NOT just the gray channel) and that compositeOverWhite blends it — a
 * decoder that ignored/misread the alpha byte would report raw_diff_ratio 0.
 * Gives an EXACT hand-computable raw_diff_ratio of diffRows/100 (100 <
 * TARGET_LONG_EDGE 480, so no downscaling rounding).
 */
function halfDiffGrayAlphaPngPair(project, name, diffRows) {
  const figmaFn = (x, y) => (y < diffRows ? [0, 0, 0, 255] : [100, 0, 0, 255]);
  const implFn = (x, y) => (y < diffRows ? [0, 0, 0, 0] : [100, 0, 0, 255]);
  const figma = makeTestPng(project, `${name}-figma.png`, { width: 100, height: 100, colorType: 4, pixelFn: figmaFn });
  const impl = makeTestPng(project, `${name}-impl.png`, { width: 100, height: 100, colorType: 4, pixelFn: implFn });
  return { figma: figma.path, impl: impl.path };
}

/**
 * Build a minimal, structurally-parseable-but-undecodable PNG for exercising
 * decodePng's format-support guards (bitDepth !== 8, interlace !== 0,
 * colorType === 3/indexed). Those guards fire BEFORE zlib.inflateSync is
 * ever reached, so a zero-length IDAT chunk is sufficient — decodePng only
 * requires idatChunks.length > 0 (an IDAT chunk was present), not that its
 * bytes are valid deflate data, before it reaches the guards. `overrides`
 * sets exactly the IHDR field(s) under test; everything else defaults to an
 * otherwise-valid 8-bit, non-interlaced, colorType-6 (RGBA) header.
 */
function buildRejectPng(overrides, { withPalette = false } = {}) {
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(overrides.width ?? 64, 0);
  ihdrData.writeUInt32BE(overrides.height ?? 64, 4);
  ihdrData.writeUInt8(overrides.bitDepth ?? 8, 8);
  ihdrData.writeUInt8(overrides.colorType ?? 6, 9);
  ihdrData.writeUInt8(0, 10); // compression method
  ihdrData.writeUInt8(0, 11); // filter method
  ihdrData.writeUInt8(overrides.interlace ?? 0, 12);
  const parts = [PNG_MAGIC, pngChunk("IHDR", ihdrData)];
  if (withPalette) parts.push(pngChunk("PLTE", Buffer.from([0, 0, 0]))); // minimal 1-entry (black) palette
  parts.push(pngChunk("IDAT", Buffer.alloc(0))); // empty — never reached, the guard throws first
  parts.push(pngChunk("IEND", Buffer.alloc(0)));
  return Buffer.concat(parts);
}

function writeRejectPng(project, name, overrides, opts) {
  const p = path.join(project, name);
  fs.writeFileSync(p, buildRejectPng(overrides, opts));
  return p;
}

function visualDesignGate({ project, png, surfaces, rows, visual, waived }) {
  const gate = baseGate(png);
  gate.qa.artifacts.push(
    ...visual.flatMap((v) => [{ kind: "screenshot", path: v.figma_export }, { kind: "screenshot", path: v.impl_screenshot }])
  );
  const design = { source: FIGMA, surfaces, rows, visual };
  if (waived) design.waived = waived;
  gate.qa.design = design;
  return gate;
}

function runDesignVisualCli(project, figma, impl, extraArgs = [], { sid = "s" } = {}) {
  const r = runCatState(["design", "visual", "--session", sid, "--figma", figma, "--impl", impl, ...extraArgs], { cwd: project });
  return { ...r, json: (() => { try { return JSON.parse(r.stdout); } catch { return null; } })() };
}

// --- Decoder proof: an independently-encoded, multi-filter, colorType-6 pair
// decodes correctly (not just "diff=0 by symmetry" — a self-consistent-but-
// wrong decoder could also report 0 for identical inputs). The encoder's
// adaptive per-row filter heuristic is asserted to have actually used more
// than filter type 0 across this 64x64 noisy image, so this exercises
// Sub/Up/Average/Paeth un-filtering, not just the trivial None path.
test("VISUAL decoder proof: colorType 6 (RGBA), multi-filter noisy fixture decodes identically for an identical pair", () => {
  const project = mkTmpProject();
  const built = makeTestPng(project, "noise.png", { width: 64, height: 64, colorType: 6 });
  assert.ok(built.filterCounts.some((c, ft) => ft !== 0 && c > 0), `expected filter types other than None to be used: ${built.filterCounts}`);
  const r = runDesignVisualCli(project, built.path, built.path);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.raw_diff_ratio, 0);
  assert.equal(r.json.severity, "None");
});

test("VISUAL decoder proof: colorType 2 (RGB, no alpha) with a precisely engineered non-trivial diff decodes the EXACT expected ratio", () => {
  const project = mkTmpProject();
  const { figma, impl } = halfDiffPngPair(project, "half20", 20, 2); // 20/100 rows differ = exactly 0.20
  const r = runDesignVisualCli(project, figma, impl);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.raw_diff_ratio, 0.2, "a wrong/self-consistent decoder would not land on this exact hand-computed ratio");
  assert.equal(r.json.diff_ratio, 0.2);
  assert.equal(r.json.severity, "None"); // 0.20 < VISUAL_DIFF_MAJOR_THRESHOLD 0.45
});

test("VISUAL decoder proof: mismatched figma/impl dimensions letterbox onto a common canvas without crashing", () => {
  const project = mkTmpProject();
  const figma = makeTestPng(project, "wide-figma.png", { width: 80, height: 40, colorType: 6 });
  const impl = makeTestPng(project, "wide-impl.png", { width: 60, height: 50, colorType: 6 }); // default noise fill — non-blank
  const r = runDesignVisualCli(project, figma.path, impl.path);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.canvas.width, 80); // max(80,60)
  assert.equal(r.json.canvas.height, 50); // max(40,50)
  assert.ok(r.json.raw_diff_ratio > 0); // different pixel content — must not silently report 0
});

test("VISUAL decoder proof: colorType 0 (grayscale) non-blank pair decodes to the EXACT expected raw_diff_ratio", () => {
  const project = mkTmpProject();
  // reuses halfDiffPngPair (already colorType-parameterized) with colorType 0
  // instead of its default 2 — 15/100 rows differ = exactly 0.15.
  const { figma, impl } = halfDiffPngPair(project, "gray15", 15, 0);
  const r = runDesignVisualCli(project, figma, impl);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.raw_diff_ratio, 0.15, "a wrong/self-consistent decoder would not land on this exact hand-computed ratio");
  assert.equal(r.json.diff_ratio, 0.15);
  assert.equal(r.json.severity, "None"); // 0.15 < VISUAL_DIFF_MAJOR_THRESHOLD 0.45
});

test("VISUAL decoder proof: colorType 4 (grayscale+alpha) pair decodes to the EXACT expected raw_diff_ratio (alpha composited over white, then dropped)", () => {
  const project = mkTmpProject();
  const { figma, impl } = halfDiffGrayAlphaPngPair(project, "grayalpha25", 25); // 25/100 rows differ = exactly 0.25
  const r = runDesignVisualCli(project, figma, impl);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(
    r.json.raw_diff_ratio, 0.25,
    "gray is 0 on BOTH sides of every diff row — only alpha differs (255 vs 0); a decoder that ignored the alpha byte would report raw_diff_ratio 0"
  );
  assert.equal(r.json.diff_ratio, 0.25);
  assert.equal(r.json.severity, "None"); // 0.25 < VISUAL_DIFF_MAJOR_THRESHOLD 0.45
});

test("VISUAL decoder proof: colorType 3 (indexed/palette) PNG fails closed with the named-remedy message, exit 2 not a crash", () => {
  const project = mkTmpProject();
  const palette = writeRejectPng(project, "palette.png", { colorType: 3 }, { withPalette: true });
  const impl = makeTestPng(project, "palette-impl.png", { width: 64, height: 64, colorType: 6 });
  const r = runDesignVisualCli(project, palette, impl.path);
  assert.equal(r.status, 2, r.stdout);
  assert.match(r.stderr, /unsupported PNG color type 3 \(indexed\/palette\) — re-export as an 8-bit RGBA PNG \(disable palette\/indexed export\)/);
});

test("VISUAL decoder proof: 16-bit and interlaced PNGs each fail closed with their named-remedy messages, exit 2 not a crash", () => {
  const project = mkTmpProject();
  const impl = makeTestPng(project, "depth-impl.png", { width: 64, height: 64, colorType: 6 });

  const sixteenBit = writeRejectPng(project, "16bit.png", { bitDepth: 16 });
  const r16 = runDesignVisualCli(project, sixteenBit, impl.path);
  assert.equal(r16.status, 2, r16.stdout);
  assert.match(r16.stderr, /unsupported PNG bit depth 16 \(only 8-bit is supported\) — re-export as an 8-bit RGBA PNG/);

  const interlaced = writeRejectPng(project, "interlaced.png", { interlace: 1 });
  const rInt = runDesignVisualCli(project, interlaced, impl.path);
  assert.equal(rInt.status, 2, rInt.stdout);
  assert.match(rInt.stderr, /unsupported interlaced \(Adam7\) PNG — re-export as a non-interlaced 8-bit RGBA PNG/);
});

test("VISUAL: hot_blocks is always a fixed 8x8 (64-cell) grid", () => {
  const project = mkTmpProject();
  const built = makeTestPng(project, "noise2.png", { width: 64, height: 64, colorType: 6 });
  const r = runDesignVisualCli(project, built.path, built.path);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.hot_blocks.length, 64);
  const rows = new Set(r.json.hot_blocks.map((b) => b.row));
  const cols = new Set(r.json.hot_blocks.map((b) => b.col));
  assert.equal(rows.size, 8);
  assert.equal(cols.size, 8);
});

// --- classifyVisualSeverity arg-order regression: rawRatio decides Blocking
// WITHOUT reading adjustedRatio — drive adjustedRatio to the literal extreme
// 0 (all diff pixels excluded) while keeping rawRatio above a (diagnostic-
// only, intentionally low) block threshold. A version that swapped the
// raw/adjusted argument order would evaluate adjustedRatio(0) against the
// threshold and report "None", not "Blocking".
test("VISUAL classifyVisualSeverity arg order: adjustedRatio=0 (fully excluded) does not override a raw ratio at/above the block threshold", () => {
  const project = mkTmpProject();
  const { figma, impl } = halfDiffPngPair(project, "argorder", 10, 2); // raw_diff_ratio exactly 0.10, all within rows 0-9
  const r = runDesignVisualCli(project, figma, impl, [
    "--block-threshold", "0.05",
    "--exclude", JSON.stringify([{ x: 0, y: 0, w: 1, h: 0.10 }]), // covers exactly the 10 diff rows, 10% <= 15% cap
  ]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.raw_diff_ratio, 0.1);
  assert.equal(r.json.diff_ratio, 0, "adjustedRatio should be driven to the literal extreme 0");
  assert.equal(r.json.capped, false);
  assert.equal(r.json.severity, "Blocking", "rawRatio (0.1) >= blockThreshold (0.05) must decide Blocking regardless of adjustedRatio");
});

test("VISUAL classifyVisualSeverity: exclude_regions over EXCLUDE_REGION_MAX_FRACTION (0.15) is dropped entirely (capped:true, recompute on the full frame)", () => {
  const project = mkTmpProject();
  const { figma, impl } = halfDiffPngPair(project, "overcap", 50, 2); // raw_diff_ratio 0.5
  const r = runDesignVisualCli(project, figma, impl, [
    "--block-threshold", "0.99",
    "--exclude", JSON.stringify([{ x: 0, y: 0, w: 1, h: 0.20 }]), // 20% > 15% cap
  ]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.capped, true);
  assert.equal(r.json.excluded_fraction, 0, "an over-cap exclusion is dropped, not partially applied");
  assert.equal(r.json.diff_ratio, r.json.raw_diff_ratio, "post-cap-drop, adjusted must equal raw (recomputed on the full frame)");
});

test("VISUAL: --exclude regions boundary — exactly at EXCLUDE_REGION_MAX_FRACTION (0.15) is applied, not capped", () => {
  const project = mkTmpProject();
  const { figma, impl } = halfDiffPngPair(project, "atcap", 50, 2); // raw_diff_ratio 0.5
  const r = runDesignVisualCli(project, figma, impl, [
    "--block-threshold", "0.99",
    "--exclude", JSON.stringify([{ x: 0, y: 0, w: 1, h: 0.15 }]), // exactly 15%
  ]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.capped, false);
  assert.equal(r.json.excluded_fraction, 0.15);
  // (5000 - 1500) / (10000 - 1500) = 3500/8500 = 0.4118 (matches stage-11-revision's oracle number)
  assert.equal(r.json.diff_ratio, 0.4118);
});

// --- structural fail-closed: non-waivable, exit 2, per case ---

test("VISUAL structural: qa.design.visual missing entirely is a hard, non-waivable exit 2", () => {
  const project = mkTmpProject();
  seedSession(project, "s", { specSource: FIGMA });
  const png = writePng(project);
  // built by hand (no visual key at all) — withDesign's auto-injection is
  // deliberately bypassed here to prove the requirement fires on its own.
  const gate = baseGate(png);
  gate.qa.design = { source: FIGMA, surfaces: [{ name: "card" }], rows: cleanRows() };
  const r = runComplete(project, "s", gate);
  assert.equal(r.status, 2, r.stdout);
  assert.match(r.stderr, /qa\.design\.visual is missing/);
});

test("VISUAL structural: a surface with no matching qa.design.visual[] entry is rejected by name", () => {
  const project = mkTmpProject();
  seedSession(project, "s", { specSource: FIGMA });
  const png = writePng(project);
  const gate = baseGate(png);
  gate.qa.design = { source: FIGMA, surfaces: [{ name: "card" }], rows: cleanRows(), visual: [] };
  const r = runComplete(project, "s", gate);
  assert.equal(r.status, 2, r.stdout);
  assert.match(r.stderr, /surface "card" is missing a qa\.design\.visual\[\] entry/);
});

test("VISUAL structural: one-sided (impl_screenshot missing) fails closed, exit 2", () => {
  const project = mkTmpProject();
  seedSession(project, "s", { specSource: FIGMA });
  const png = writePng(project);
  const { figma } = defaultVisualFixture(project, "card");
  const gate = visualDesignGate({
    project, png, surfaces: [{ name: "card" }], rows: cleanRows(),
    visual: [{ surface: "card", figma_export: figma, impl_screenshot: "", raw_diff_ratio: 0, diff_ratio: 0, severity: "None" }],
  });
  const r = runComplete(project, "s", gate);
  assert.equal(r.status, 2, r.stdout);
  assert.match(r.stderr, /is missing impl_screenshot/);
});

test("VISUAL structural: figma_export/impl_screenshot not registered in qa.artifacts is rejected", () => {
  const project = mkTmpProject();
  seedSession(project, "s", { specSource: FIGMA });
  const png = writePng(project);
  const { figma, impl } = defaultVisualFixture(project, "card");
  const gate = baseGate(png); // note: figma/impl PNGs deliberately NOT pushed into qa.artifacts
  gate.qa.design = {
    source: FIGMA, surfaces: [{ name: "card" }], rows: cleanRows(),
    visual: [{ surface: "card", figma_export: figma, impl_screenshot: impl, raw_diff_ratio: 0, diff_ratio: 0, severity: "None" }],
  };
  const r = runComplete(project, "s", gate);
  assert.equal(r.status, 2, r.stdout);
  assert.match(r.stderr, /is not registered in qa\.artifacts/);
});

test("VISUAL structural: JPEG is rejected (decoder is PNG-only) even though it clears the generic screenshot magic/byte floor", () => {
  const project = mkTmpProject();
  seedSession(project, "s", { specSource: FIGMA });
  const png = writePng(project);
  const jpeg = writeJpeg(project);
  const { impl } = defaultVisualFixture(project, "card");
  const gate = visualDesignGate({
    project, png, surfaces: [{ name: "card" }], rows: cleanRows(),
    visual: [{ surface: "card", figma_export: jpeg, impl_screenshot: impl, raw_diff_ratio: 0, diff_ratio: 0, severity: "None" }],
  });
  const r = runComplete(project, "s", gate);
  assert.equal(r.status, 2, r.stdout);
  assert.match(r.stderr, /is a JPEG — the visual-diff decoder only supports PNG/);
});

test("VISUAL structural: an undecodable PNG (corrupt/truncated) fails closed with a self-describing message", () => {
  const project = mkTmpProject();
  seedSession(project, "s", { specSource: FIGMA });
  const png = writePng(project);
  const { impl } = defaultVisualFixture(project, "card");
  const corruptPath = path.join(project, "corrupt.png");
  const magic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  fs.writeFileSync(corruptPath, Buffer.concat([magic, Buffer.alloc(5000)])); // magic + garbage, no real IHDR/IDAT
  const gate = visualDesignGate({
    project, png, surfaces: [{ name: "card" }], rows: cleanRows(),
    visual: [{ surface: "card", figma_export: corruptPath, impl_screenshot: impl, raw_diff_ratio: 0, diff_ratio: 0, severity: "None" }],
  });
  const r = runComplete(project, "s", gate);
  assert.equal(r.status, 2, r.stdout);
  assert.match(r.stderr, /failed to decode/);
});

test("VISUAL structural: a blank capture (all channels within BLANK_RANGE_EPSILON) fails closed", () => {
  const project = mkTmpProject();
  seedSession(project, "s", { specSource: FIGMA });
  const png = writePng(project);
  const blank = makeTestPng(project, "blank.png", { width: 64, height: 64, colorType: 0, pixelFn: () => [128] });
  const { impl } = defaultVisualFixture(project, "card");
  const gate = visualDesignGate({
    project, png, surfaces: [{ name: "card" }], rows: cleanRows(),
    visual: [{ surface: "card", figma_export: blank.path, impl_screenshot: impl, raw_diff_ratio: 0, diff_ratio: 0, severity: "None" }],
  });
  const r = runComplete(project, "s", gate);
  assert.equal(r.status, 2, r.stdout);
  assert.match(r.stderr, /is blank/);
});

test("VISUAL structural: below MIN_DIMENSION (32px) fails closed", () => {
  const project = mkTmpProject();
  seedSession(project, "s", { specSource: FIGMA });
  const png = writePng(project);
  const tiny = makeTestPng(project, "tiny.png", { width: 16, height: 16, colorType: 6 });
  const { impl } = defaultVisualFixture(project, "card");
  const gate = visualDesignGate({
    project, png, surfaces: [{ name: "card" }], rows: cleanRows(),
    visual: [{ surface: "card", figma_export: tiny.path, impl_screenshot: impl, raw_diff_ratio: 0, diff_ratio: 0, severity: "None" }],
  });
  const r = runComplete(project, "s", gate);
  assert.equal(r.status, 2, r.stdout);
  assert.match(r.stderr, /16x16.*must be >= 32px/);
});

// --- magnitude bands: None / Major (waivable) / Blocking (never waivable) ---

test("VISUAL: a real Major-band diff blocks without a waiver, and passes once properly user-waived", () => {
  const project = mkTmpProject();
  seedSession(project, "s", { specSource: FIGMA });
  const png = writePng(project);
  const { figma, impl } = halfDiffPngPair(project, "major", 50, 2); // raw/adjusted 0.5, within [0.45,0.75)
  const visual = [{ surface: "card", figma_export: figma, impl_screenshot: impl, raw_diff_ratio: 0.5, diff_ratio: 0.5, severity: "Major" }];
  // unwaived → blocks
  const unwaived = visualDesignGate({ project, png, surfaces: [{ name: "card" }], rows: cleanRows(), visual });
  const r1 = runComplete(project, "s", unwaived);
  assert.equal(r1.status, 2, r1.stdout);
  assert.match(r1.stderr, /visual diff computes Major/);
  assert.match(r1.stderr, /resolve it, or record a user-acknowledged/);

  // properly waived → passes
  const waived = visualDesignGate({
    project, png, surfaces: [{ name: "card" }], rows: cleanRows(), visual,
    waived: { reason: "Product accepted this visual delta after reviewing the capture this sprint.", surfaces: ["card"], user_acknowledged: true },
  });
  const r2 = runComplete(project, "s", waived);
  assert.equal(r2.status, 0, r2.stderr);
});

test("VISUAL: Blocking (default 0.75 threshold) is refused and audited even with waived.user_acknowledged:true", () => {
  const project = mkTmpProject();
  seedSession(project, "s", { specSource: FIGMA });
  const png = writePng(project);
  const { figma, impl } = halfDiffPngPair(project, "blockdefault", 80, 2); // raw/adjusted 0.8 >= default 0.75
  const visual = [{ surface: "card", figma_export: figma, impl_screenshot: impl, raw_diff_ratio: 0.8, diff_ratio: 0.8, severity: "Major" }];
  const gate = visualDesignGate({
    project, png, surfaces: [{ name: "card" }], rows: cleanRows(), visual,
    waived: { reason: "Team acknowledged the mismatch and waived it explicitly for this release.", surfaces: ["card"], user_acknowledged: true },
  });
  const r = runComplete(project, "s", gate);
  assert.equal(r.status, 2, r.stdout);
  assert.match(r.stderr, /computes Blocking/);
  assert.match(r.stderr, /can NEVER be waived or reduced by exclude_regions/);
  const audit = readAudit(project, "s");
  const blockingNote = audit.find((a) => a.verb === "design_visual_blocking");
  assert.ok(blockingNote, "design_visual_blocking audit entry written");
  assert.equal(blockingNote.raw_diff_ratio, 0.8);
  assert.equal(blockingNote.block_threshold, 0.75);
});

// --- pass 11's headline regression: low settings.json override + saturated
// exclude_regions can no longer bypass Blocking via the adjusted ratio ---

test("VISUAL pass-11 regression (b=0.50): a low designQa.visualDiffBlockThreshold override + a saturated 15% exclude_region covering diff pixels STILL classifies Blocking (raw-ratio invariant closes the bypass)", () => {
  const project = mkTmpProject();
  writeSettings(project, { designQa: { visualDiffBlockThreshold: 0.5 } });
  seedSession(project, "s", { specSource: FIGMA });
  const png = writePng(project);
  const { figma, impl } = halfDiffPngPair(project, "b050", 50, 2); // raw_diff_ratio exactly 0.5 == the override threshold
  const excludeRegions = [{ x: 0, y: 0, w: 1, h: 0.15 }]; // saturates the 0.15 cap, covers diff pixels only
  const visual = [{
    surface: "card", figma_export: figma, impl_screenshot: impl,
    exclude_regions: excludeRegions,
    raw_diff_ratio: 0.5, diff_ratio: 0.4118, // (0.5-0.15)/(1-0.15) — the exact stage-11 bypass number, submitted as informational
    severity: "Major", // even the MORE severe self-report can't help — recompute is authoritative regardless
  }];
  const gate = visualDesignGate({
    project, png, surfaces: [{ name: "card" }], rows: cleanRows(), visual,
    waived: { reason: "Team explicitly accepted this mismatch and waived it after reviewing the capture.", surfaces: ["card"], user_acknowledged: true },
  });
  const r = runComplete(project, "s", gate);
  assert.equal(r.status, 2, r.stdout);
  assert.match(r.stderr, /computes Blocking \(raw_diff_ratio 0\.5 \[pre-exclude_regions\], adjusted_diff_ratio 0\.4118/);
  assert.match(r.stderr, /block threshold 0\.5 \[source \.cat\/settings\.json designQa\.visualDiffBlockThreshold\]/);
  const audit = readAudit(project, "s");
  const excludeNote = audit.find((a) => a.verb === "design_visual_exclude_regions_applied");
  assert.ok(excludeNote, "exclude_regions application is unconditionally audited");
  assert.equal(excludeNote.excluded_fraction, 0.15);
  assert.equal(excludeNote.capped, false);
  const blockingNote = audit.find((a) => a.verb === "design_visual_blocking");
  assert.equal(blockingNote.raw_diff_ratio, 0.5);
  assert.equal(blockingNote.diff_ratio, 0.4118);
  assert.equal(blockingNote.block_threshold, 0.5);
});

test("VISUAL settings.json override: a valid override changes the enforced threshold (Major at default 0.75, but Blocking once lowered to 0.6)", () => {
  const project = mkTmpProject();
  seedSession(project, "s", { specSource: FIGMA });
  const png = writePng(project);
  const { figma, impl } = halfDiffPngPair(project, "override06", 65, 2); // raw 0.65: below default 0.75 (Major), at/above 0.6 override (Blocking)
  const visual = [{ surface: "card", figma_export: figma, impl_screenshot: impl, raw_diff_ratio: 0.65, diff_ratio: 0.65, severity: "Major" }];
  const waived = { reason: "Product accepted this visual delta after reviewing the capture this sprint.", surfaces: ["card"], user_acknowledged: true };

  // default 0.75 threshold: 0.65 is Major, and a proper waiver passes it
  const gateDefault = visualDesignGate({ project, png, surfaces: [{ name: "card" }], rows: cleanRows(), visual, waived });
  const rDefault = runComplete(project, "s", gateDefault);
  assert.equal(rDefault.status, 0, rDefault.stderr);

  // now lower the override to 0.6 in a FRESH project/session — the same 0.65 raw ratio is now Blocking
  const project2 = mkTmpProject();
  writeSettings(project2, { designQa: { visualDiffBlockThreshold: 0.6 } });
  seedSession(project2, "s", { specSource: FIGMA });
  const png2 = writePng(project2);
  const pair2 = halfDiffPngPair(project2, "override06b", 65, 2);
  const visual2 = [{ surface: "card", figma_export: pair2.figma, impl_screenshot: pair2.impl, raw_diff_ratio: 0.65, diff_ratio: 0.65, severity: "Major" }];
  const gateLowered = visualDesignGate({ project: project2, png: png2, surfaces: [{ name: "card" }], rows: cleanRows(), visual: visual2, waived });
  const rLowered = runComplete(project2, "s", gateLowered);
  assert.equal(rLowered.status, 2, rLowered.stdout);
  assert.match(rLowered.stderr, /computes Blocking/);
});

test("VISUAL settings.json override: an invalid override (out of range) falls back to the default AND audits once", () => {
  const project = mkTmpProject();
  writeSettings(project, { designQa: { visualDiffBlockThreshold: 0.2 } }); // <= major threshold — invalid
  seedSession(project, "s", { specSource: FIGMA });
  const png = writePng(project);
  const { figma, impl } = halfDiffPngPair(project, "invalidoverride", 50, 2); // 0.5 — Major under the default 0.75, would be Blocking under 0.2
  const visual = [{ surface: "card", figma_export: figma, impl_screenshot: impl, raw_diff_ratio: 0.5, diff_ratio: 0.5, severity: "Major" }];
  const gate = visualDesignGate({
    project, png, surfaces: [{ name: "card" }], rows: cleanRows(), visual,
    waived: { reason: "Product accepted this visual delta after reviewing the capture this sprint.", surfaces: ["card"], user_acknowledged: true },
  });
  const r = runComplete(project, "s", gate);
  assert.equal(r.status, 0, r.stderr, "an invalid override must fall back to the default (0.75), not the invalid 0.2");
  const audit = readAudit(project, "s");
  const invalidNote = audit.find((a) => a.verb === "design_visual_block_threshold_override_invalid");
  assert.ok(invalidNote, "invalid override is audited once");
  assert.equal(invalidNote.raw, 0.2);
});

test("VISUAL settings.json: file present but key absent behaves exactly like no override (no audit note)", () => {
  const project = mkTmpProject();
  writeSettings(project, { deepInterview: { ambiguityThreshold: 0.2 } }); // unrelated key present
  seedSession(project, "s", { specSource: FIGMA });
  const png = writePng(project);
  const gate = withDesign(baseGate(png), { source: FIGMA, surfaces: [{ name: "card" }], rows: cleanRows() });
  const r = runComplete(project, "s", gate);
  assert.equal(r.status, 0, r.stderr);
  const audit = readAudit(project, "s");
  assert.ok(!audit.some((a) => a.verb === "design_visual_block_threshold_override_invalid"), "an unset key is normal, not an invalid-override audit event");
});

// --- recompute-authoritative: the server recomputes both ratios AND the
// severity from the real PNGs; a submitted value never wins. ---

test("VISUAL recompute-authoritative: a submitted severity more lenient than the CLI recompute is rejected", () => {
  const project = mkTmpProject();
  seedSession(project, "s", { specSource: FIGMA });
  const png = writePng(project);
  const { figma, impl } = halfDiffPngPair(project, "downgrade", 50, 2); // real ratio 0.5 → Major
  const visual = [{ surface: "card", figma_export: figma, impl_screenshot: impl, raw_diff_ratio: 0.01, diff_ratio: 0.01, severity: "None" }]; // lies
  const gate = visualDesignGate({ project, png, surfaces: [{ name: "card" }], rows: cleanRows(), visual });
  const r = runComplete(project, "s", gate);
  assert.equal(r.status, 2, r.stdout);
  assert.match(r.stderr, /submitted severity "None" is more lenient than the CLI-recomputed "Major"/);
});

test("VISUAL recompute-authoritative: an unrecognized submitted severity value is rejected", () => {
  const project = mkTmpProject();
  seedSession(project, "s", { specSource: FIGMA });
  const png = writePng(project);
  const { figma, impl } = defaultVisualFixture(project, "card");
  const visual = [{ surface: "card", figma_export: figma, impl_screenshot: impl, raw_diff_ratio: 0, diff_ratio: 0, severity: "Critical" }]; // not a visual-severity enum value
  const gate = visualDesignGate({ project, png, surfaces: [{ name: "card" }], rows: cleanRows(), visual });
  const r = runComplete(project, "s", gate);
  assert.equal(r.status, 2, r.stdout);
  assert.match(r.stderr, /severity "Critical" must be one of None, Major, Blocking/);
});

// --- `design visual` CLI end-to-end (the exact re-runnable qa.commands form) ---

test("VISUAL CLI: `design visual` prints raw_diff_ratio, diff_ratio, severity, and resolves the block threshold like the gate", () => {
  const project = mkTmpProject();
  const { figma, impl } = halfDiffPngPair(project, "cli", 50, 2);
  const r = runDesignVisualCli(project, figma, impl);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.raw_diff_ratio, 0.5);
  assert.equal(r.json.diff_ratio, 0.5);
  assert.equal(r.json.severity, "Major");
  assert.equal(r.json.block_threshold, 0.75);
  assert.match(r.json.block_threshold_source, /default/);
});

test("VISUAL CLI: `design visual` resolves the same settings.json override the gate would use when --block-threshold is omitted", () => {
  const project = mkTmpProject();
  writeSettings(project, { designQa: { visualDiffBlockThreshold: 0.6 } });
  const { figma, impl } = halfDiffPngPair(project, "cli-override", 65, 2);
  const r = runDesignVisualCli(project, figma, impl);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.block_threshold, 0.6);
  assert.equal(r.json.block_threshold_source, ".cat/settings.json designQa.visualDiffBlockThreshold");
  assert.equal(r.json.severity, "Blocking");
});

test("VISUAL CLI: missing --figma/--impl is a usage error (exit 1)", () => {
  const project = mkTmpProject();
  const r = runCatState(["design", "visual", "--session", "s"], { cwd: project });
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /requires --figma <path> and --impl <path>/);
});

// --- pass 09/10 → pass 11 additive-only confirmation: exclude_regions EMPTY
// (or absent) makes raw_diff_ratio and diff_ratio always equal, and the
// magnitude gate is purely additive on top of the numeric gate (proven by
// the untouched full existing suite above staying green with only the
// shared withDesign() helper migrated, per stage-11-revision's acceptance
// criteria — "numeric assertions preserved, NOT unchanged").
test("VISUAL: raw_diff_ratio equals diff_ratio whenever exclude_regions is empty/absent", () => {
  const project = mkTmpProject();
  const { figma, impl } = halfDiffPngPair(project, "noexclude", 30, 2);
  const r = runDesignVisualCli(project, figma, impl);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.raw_diff_ratio, r.json.diff_ratio);
});

// ===========================================================================
// `design diff` — mechanical Figma↔impl measurement diff (design-qa lane aid).
// Covers the "two-numbers rule" (no row without BOTH numbers) and the "no
// sampling / no omission" enforcement (every extracted sized node must carry a
// measured counterpart), sharing computeSeverity() with the checkpoint gate.
// ===========================================================================

function runDesignDiff(project, figma, impl, { sid = "s" } = {}) {
  const fp = path.join(project, "figma.json");
  const ip = path.join(project, "impl.json");
  fs.writeFileSync(fp, JSON.stringify(figma));
  fs.writeFileSync(ip, JSON.stringify(impl));
  const r = runCatState(["design", "diff", "--session", sid, "--figma", fp, "--impl", ip], { cwd: project });
  return { ...r, json: (() => { try { return JSON.parse(r.stdout); } catch { return null; } })() };
}

test("design diff: fully-paired, well-formed manifests → ok:true, exit 0, gate-ready rows with CLI severity", () => {
  const project = mkTmpProject();
  const r = runDesignDiff(
    project,
    [
      { surface: "banner", element: "pill", property: "width", figma_expected: "103px" },
      { surface: "banner", element: "title", property: "font-size", figma_expected: "20px" },
    ],
    [
      { surface: "banner", element: "pill", property: "width", impl_actual: "103px" },
      { surface: "banner", element: "title", property: "font-size", impl_actual: "20px" },
    ]
  );
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.summary.paired, 2);
  assert.equal(r.json.summary.blocking, 0);
  assert.equal(r.json.rows.every((row) => row.figma_expected && row.impl_actual && row.severity), true);
});

test("design diff: a REAL gap on a well-formed pair is a finding (ok:true, exit 0), severity computed like the gate", () => {
  const project = mkTmpProject();
  const r = runDesignDiff(
    project,
    [{ surface: "banner", element: "pill", property: "width", figma_expected: "103px" }],
    [{ surface: "banner", element: "pill", property: "width", impl_actual: "140px" }]
  );
  // A real gap is the tool WORKING, not a tool error — exit 0, surfaced in summary.
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.rows[0].severity, "Major");
  assert.equal(r.json.summary.blocking, 1);
});

test("design diff: an extracted-but-unmeasured Figma node (the pill-omission bug) → unmeasured, ok:false, exit 2", () => {
  const project = mkTmpProject();
  const r = runDesignDiff(
    project,
    [
      { surface: "banner", element: "title", property: "font-size", figma_expected: "20px" },
      { surface: "banner", element: "badge", property: "border-radius", figma_expected: "8px" },
    ],
    [{ surface: "banner", element: "title", property: "font-size", impl_actual: "20px" }]
  );
  assert.equal(r.status, 2, r.stdout);
  assert.equal(r.json.ok, false);
  assert.equal(r.json.summary.unmeasured, 1);
  assert.equal(r.json.unmeasured[0].element, "badge");
});

test("design diff: a paired-but-unparseable value (would-be guess) → malformed, ok:false, exit 2", () => {
  const project = mkTmpProject();
  const r = runDesignDiff(
    project,
    [{ surface: "banner", element: "pill", property: "width", figma_expected: "103px" }],
    [{ surface: "banner", element: "pill", property: "width", impl_actual: "not-a-length" }]
  );
  assert.equal(r.status, 2, r.stdout);
  assert.equal(r.json.ok, false);
  assert.equal(r.json.summary.malformed, 1);
  assert.equal(r.json.rows.length, 0);
});

test("design diff: an impl measurement with no Figma spec → unexpected, NON-blocking (exit 0)", () => {
  const project = mkTmpProject();
  const r = runDesignDiff(
    project,
    [{ surface: "banner", element: "pill", property: "width", figma_expected: "103px" }],
    [
      { surface: "banner", element: "pill", property: "width", impl_actual: "103px" },
      { surface: "banner", element: "stray", property: "gap", impl_actual: "8px" },
    ]
  );
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.summary.unexpected, 1);
  assert.equal(r.json.unexpected[0].element, "stray");
});

test("design diff: --impl - reads the impl manifest from stdin", () => {
  const project = mkTmpProject();
  const fp = path.join(project, "f.json");
  fs.writeFileSync(fp, JSON.stringify([{ surface: "b", element: "pill", property: "width", figma_expected: "103px" }]));
  const r = runCatState(["design", "diff", "--session", "s", "--figma", fp, "--impl", "-"], {
    cwd: project,
    input: JSON.stringify([{ surface: "b", element: "pill", property: "width", impl_actual: "103px" }]),
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).summary.paired, 1);
});

test("design diff: a duplicate (surface,element,property) key is a contract refusal (exit 2)", () => {
  const project = mkTmpProject();
  const r = runDesignDiff(
    project,
    [
      { surface: "b", element: "pill", property: "width", figma_expected: "1px" },
      { surface: "b", element: "pill", property: "width", figma_expected: "2px" },
    ],
    [{ surface: "b", element: "pill", property: "width", impl_actual: "1px" }]
  );
  assert.equal(r.status, 2, r.stdout);
  assert.match(r.stderr, /duplicate \(surface,element,property\) key/);
});

test("design diff: a row missing a required field is a contract refusal (exit 2)", () => {
  const project = mkTmpProject();
  const r = runDesignDiff(
    project,
    [{ surface: "b", element: "pill", property: "width" }], // no figma_expected
    [{ surface: "b", element: "pill", property: "width", impl_actual: "1px" }]
  );
  assert.equal(r.status, 2, r.stdout);
  assert.match(r.stderr, /missing a non-empty "figma_expected"/);
});

test("design diff: missing --impl is a usage error (exit 1)", () => {
  const project = mkTmpProject();
  const fp = path.join(project, "f.json");
  fs.writeFileSync(fp, JSON.stringify([{ surface: "b", element: "pill", property: "width", figma_expected: "1px" }]));
  const r = runCatState(["design", "diff", "--session", "s", "--figma", fp], { cwd: project });
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /requires --figma .* and --impl/);
});

test("design diff: non-array manifest is a contract refusal (exit 2)", () => {
  const project = mkTmpProject();
  const r = runDesignDiff(project, { not: "an array" }, [{ surface: "b", element: "p", property: "width", impl_actual: "1px" }]);
  assert.equal(r.status, 2, r.stdout);
  assert.match(r.stderr, /--figma must be a JSON array/);
});

// --- AC14: the full pre-existing suite stays green — covered by running this file. ---

// =====================================================================
// WS2 (code-review-graph, Option B): `graph build` / `graph query`
// (stage-18-revision.md WS2 section). Both subcommands require Node
// 22.13.0+ (node:sqlite unflagged at that floor) and the vendored
// web-tree-sitter WASM runtime under scripts/vendor/tree-sitter/. The
// fixture/concurrency/API-self-check tests below need node:sqlite in the
// CURRENT test-runner process and are skipped when it is unavailable (see
// GRAPH_SKIP above) so `node --test` on the repo's default Node 20 still
// passes green with these skipped, not failed. The version-guard test is
// deliberately NOT gated on GRAPH_SKIP — it is designed to prove the guard
// itself, so it must be exercisable on a below-floor Node.
// =====================================================================

/** A tmp project graph build can scan: git-init'd (graph build uses `git ls-files`) with the given files written and staged. */
function mkGraphProject(files) {
  const project = mkTmpProject();
  execFileSync("git", ["init", "-q"], { cwd: project });
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(project, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  execFileSync("git", ["add", "-A"], { cwd: project });
  return project;
}

function runGraphBuild(project, { sid = "s1", changedOnly = false } = {}) {
  const args = ["graph", "build", "--session", sid];
  if (changedOnly) args.push("--changed-only");
  const r = runCatState(args, { cwd: project });
  return { ...r, json: r.status === 0 && r.stdout ? JSON.parse(r.stdout) : null };
}

function runGraphQuery(project, file, { sid = "s1", depth } = {}) {
  const args = ["graph", "query", "--session", sid, "--file", file];
  if (depth !== undefined) args.push("--depth", String(depth));
  const r = runCatState(args, { cwd: project });
  return { ...r, json: r.status === 0 && r.stdout ? JSON.parse(r.stdout) : null };
}

/** Async spawn (real concurrency, unlike spawnSync) — resolves with {status, stdout, stderr}. */
function spawnCatStateAsync(args, { cwd } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CAT_STATE, ...args], { cwd });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

test(
  "graph build + graph query: fixture project (cross-file export/import/call) resolves nodes, callers, and stale correctly",
  { skip: GRAPH_SKIP },
  () => {
    const project = mkGraphProject({
      "fileA.js": "export function funcX() {\n  return 1;\n}\n",
      "fileB.js": "import { funcX } from './fileA.js';\nexport function callsIt() {\n  return funcX();\n}\n",
      "fileC.js": "import { funcX } from './fileA.js';\nexport function alsoCallsIt() {\n  return funcX() + 1;\n}\n",
    });

    const build = runGraphBuild(project);
    assert.equal(build.status, 0, build.stderr);
    assert.equal(build.json.ok, true);
    assert.equal(build.json.files_scanned, 3);
    assert.equal(build.json.total_nodes, 3); // funcX, callsIt, alsoCallsIt

    // fileA's own node — plus two distinct external callers (fan-in) at distance 1
    const qa = runGraphQuery(project, "fileA.js", { depth: 2 });
    assert.equal(qa.status, 0, qa.stderr);
    assert.equal(qa.json.ok, true);
    assert.equal(qa.json.file, "fileA.js");
    assert.equal(qa.json.parse_status, "ok");
    assert.equal(qa.json.stale, false);
    assert.equal(qa.json.nodes.length, 1);
    assert.equal(qa.json.nodes[0].symbol, "funcX");
    assert.equal(qa.json.nodes[0].exported, true);
    // Each of fileB/fileC contributes TWO edges into funcX: the `import`
    // edge (from_id = the importing file itself, module scope) and the
    // `call` edge (from_id = the specific function that calls funcX) — both
    // kinds count toward callers/fan-in per the pinned query shape.
    const callerIds = qa.json.callers.map((c) => c.id).sort();
    assert.deepEqual(callerIds, ["fileB.js", "fileB.js::callsIt", "fileC.js", "fileC.js::alsoCallsIt"]);
    const functionCallers = qa.json.callers.filter((c) => c.kind === "function").map((c) => c.id).sort();
    assert.deepEqual(functionCallers, ["fileB.js::callsIt", "fileC.js::alsoCallsIt"]);
    for (const c of qa.json.callers) assert.equal(c.distance, 1);
    assert.deepEqual(qa.json.dependents, qa.json.callers);

    // fileB's own node — no callers of its own (nothing calls callsIt)
    const qb = runGraphQuery(project, "fileB.js", { depth: 2 });
    assert.equal(qb.json.nodes.length, 1);
    assert.equal(qb.json.nodes[0].symbol, "callsIt");
    assert.deepEqual(qb.json.callers, []);

    // depth 0 — own nodes only, no traversal
    const qaDepth0 = runGraphQuery(project, "fileA.js", { depth: 0 });
    assert.equal(qaDepth0.json.depth, 0);
    assert.deepEqual(qaDepth0.json.callers, []);
    assert.equal(qaDepth0.json.nodes.length, 1);

    // a file never scanned/built — parse_status "missing", stale true, no crash
    const missing = runGraphQuery(project, "nope.js", { depth: 2 });
    assert.equal(missing.status, 0, missing.stderr);
    assert.equal(missing.json.ok, true);
    assert.equal(missing.json.parse_status, "missing");
    assert.equal(missing.json.stale, true);
    assert.deepEqual(missing.json.nodes, []);

    // editing fileA.js without rebuilding flips stale to true
    fs.writeFileSync(path.join(project, "fileA.js"), "export function funcX() {\n  return 2;\n}\n");
    const qaStale = runGraphQuery(project, "fileA.js", { depth: 1 });
    assert.equal(qaStale.json.stale, true);

    // --changed-only: rebuilding with nothing re-staged skips the unchanged files and
    // leaves their sha256/node_count/edge_count untouched (files_changed stays 0 for them)
    execFileSync("git", ["add", "-A"], { cwd: project }); // re-stage fileA.js edit made above
    const rebuild1 = runGraphBuild(project, { changedOnly: true });
    assert.equal(rebuild1.json.files_changed, 1); // only fileA.js changed
    assert.equal(rebuild1.json.files_unchanged, 2);

    const rebuild2 = runGraphBuild(project, { changedOnly: true });
    assert.equal(rebuild2.json.files_changed, 0); // nothing changed since rebuild1
    assert.equal(rebuild2.json.files_unchanged, 3);
    assert.equal(rebuild2.json.total_nodes, 3);
  }
);

test(
  "graph query: incremental_since_full_build flags cross-file staleness after a --changed-only build, and clears on a subsequent full build",
  { skip: GRAPH_SKIP },
  () => {
    // Reproduces the QA-confirmed false negative: renaming an exported
    // symbol in fileA.js and running `graph build --changed-only` (fileB.js,
    // the dependent, is NOT reparsed since its own sha256 is unchanged)
    // leaves fileB.js's old caller edge into the now-renamed symbol dangling.
    // `graph query --file fileA.js` still reports `stale:false` (fileA.js's
    // OWN sha256 matches what was just built) with no callers — silently
    // hiding that fileB.js still references the old symbol name. The new
    // `incremental_since_full_build` field is the honesty signal that
    // surfaces this without the expensive full inbound-edge recompute.
    const project = mkGraphProject({
      "fileA.js": "export function funcX() {\n  return 1;\n}\n",
      "fileB.js": "import { funcX } from './fileA.js';\nexport function callsIt() {\n  return funcX();\n}\n",
    });

    // 1. Full build: meta records mode "full", flag is false everywhere.
    const build1 = runGraphBuild(project);
    assert.equal(build1.status, 0, build1.stderr);
    assert.equal(build1.json.changed_only, false);
    assert.equal(build1.json.incremental_since_full_build, false);

    const q1 = runGraphQuery(project, "fileA.js", { depth: 2 });
    assert.equal(q1.json.stale, false);
    assert.equal(q1.json.incremental_since_full_build, false);
    assert.deepEqual(q1.json.callers.map((c) => c.id).sort(), ["fileB.js", "fileB.js::callsIt"]);

    // 2. Rename the exported symbol in fileA.js; re-stage ONLY fileA.js so
    // fileB.js's sha256 is unchanged and --changed-only skips reparsing it —
    // fileB.js keeps its stale `call`/`import` edges into the old funcX id.
    fs.writeFileSync(path.join(project, "fileA.js"), "export function funcY() {\n  return 1;\n}\n");
    execFileSync("git", ["add", "-A"], { cwd: project });
    const build2 = runGraphBuild(project, { changedOnly: true });
    assert.equal(build2.status, 0, build2.stderr);
    assert.equal(build2.json.changed_only, true);
    assert.equal(build2.json.incremental_since_full_build, true); // build-side signal too

    // 3. The load-bearing assertion: fileA.js's OWN stale check is false
    // (freshly built) yet the new field flags that cross-file caller data
    // (fileB.js's edges into the OLD funcX) may be stale/dangling.
    const q2 = runGraphQuery(project, "fileA.js", { depth: 2 });
    assert.equal(q2.status, 0, q2.stderr);
    assert.equal(q2.json.stale, false); // the misleading part of the false negative — proven still true
    assert.equal(q2.json.incremental_since_full_build, true); // the honesty signal QA needed
    assert.equal(q2.json.nodes[0].symbol, "funcY");
    // fileB.js's OLD call/import edges targeted the previous funcX node id,
    // which no longer exists post-rename — the dangling edges are simply
    // gone from fileA's fan-in (a --changed-only build never re-resolves
    // fileB's imports since fileB itself was skipped), reproducing the
    // "callers:[]" silent hiding QA observed.
    assert.deepEqual(q2.json.callers, []);

    // 4. Fix the caller too (fileB.js now imports the renamed funcY — this
    // is exactly what the new "Known Limitations" doc tells a developer to
    // do: after a cross-file rename, run a full build), then a subsequent
    // FULL build reparses fileB.js, resolves its import against funcY, and
    // the honesty signal clears back to false.
    fs.writeFileSync(path.join(project, "fileB.js"), "import { funcY } from './fileA.js';\nexport function callsIt() {\n  return funcY();\n}\n");
    execFileSync("git", ["add", "-A"], { cwd: project });
    const build3 = runGraphBuild(project);
    assert.equal(build3.status, 0, build3.stderr);
    assert.equal(build3.json.changed_only, false);
    assert.equal(build3.json.incremental_since_full_build, false);

    const q3 = runGraphQuery(project, "fileA.js", { depth: 2 });
    assert.equal(q3.json.stale, false);
    assert.equal(q3.json.incremental_since_full_build, false);
    assert.deepEqual(q3.json.callers.map((c) => c.id).sort(), ["fileB.js", "fileB.js::callsIt"]);
  }
);

test(
  "graph build: --changed-only as the very first build ever (empty DB, cold start) still sets incremental_since_full_build:true despite 100% complete data — the empty-DB false positive a run-start FULL build must avoid",
  { skip: GRAPH_SKIP },
  () => {
    const project = mkGraphProject({
      "fileA.js": "export function funcX() {\n  return 1;\n}\n",
      "fileB.js": "import { funcX } from './fileA.js';\nexport function callsIt() {\n  return funcX();\n}\n",
    });

    // Cold start: skip the usual first FULL build and call --changed-only
    // directly against a brand-new (empty) graph.db.
    const build1 = runGraphBuild(project, { changedOnly: true });
    assert.equal(build1.status, 0, build1.stderr);
    assert.equal(build1.json.ok, true);
    assert.equal(build1.json.changed_only, true);
    // Every file was freshly parsed from empty — data is 100% complete, no
    // dangling cross-file edges are even possible yet at this point.
    assert.equal(build1.json.files_changed, build1.json.total_files);
    assert.equal(build1.json.files_pruned, 0);
    // Yet the build-side honesty signal still reports incremental, because
    // last_build_mode is derived from the --changed-only flag alone, not
    // from whether the DB was actually empty beforehand.
    assert.equal(build1.json.incremental_since_full_build, true);

    const q1 = runGraphQuery(project, "fileA.js", { depth: 2 });
    assert.equal(q1.status, 0, q1.stderr);
    assert.equal(q1.json.stale, false);
    // The false positive this test proves necessary to avoid: the query-side
    // honesty signal is ALSO true even though nothing could possibly be
    // stale — this is a cold start, there was no prior build to diverge from.
    assert.equal(q1.json.incremental_since_full_build, true);
    assert.deepEqual(q1.json.callers.map((c) => c.id).sort(), ["fileB.js", "fileB.js::callsIt"]);

    // The mitigation this fixture validates: a run-start FULL build (no
    // --changed-only) clears the signal back to false, proving orchestrators
    // must run one full build at run-start rather than trusting
    // --changed-only from a cold DB (skills/{ralplan,ultragoal,team}/SKILL.md).
    const build2 = runGraphBuild(project);
    assert.equal(build2.status, 0, build2.stderr);
    assert.equal(build2.json.changed_only, false);
    assert.equal(build2.json.incremental_since_full_build, false);

    const q2 = runGraphQuery(project, "fileA.js", { depth: 2 });
    assert.equal(q2.status, 0, q2.stderr);
    assert.equal(q2.json.incremental_since_full_build, false);
    assert.deepEqual(q2.json.callers.map((c) => c.id).sort(), ["fileB.js", "fileB.js::callsIt"]);
  }
);

test("graph build: a file with unparseable syntax does not crash the build (parse_status skipped/partial)", { skip: GRAPH_SKIP }, () => {
  const project = mkGraphProject({
    "good.js": "export function ok() { return 1; }\n",
    "bad.js": "function broken( {\n  this is not valid javascript at all ][\n",
  });
  const build = runGraphBuild(project);
  assert.equal(build.status, 0, build.stderr);
  assert.equal(build.json.ok, true);

  const q = runGraphQuery(project, "bad.js", { depth: 1 });
  assert.equal(q.status, 0, q.stderr);
  assert.ok(["skipped", "partial"].includes(q.json.parse_status), q.json.parse_status);

  const qGood = runGraphQuery(project, "good.js", { depth: 1 });
  assert.equal(qGood.json.parse_status, "ok");
  assert.equal(qGood.json.nodes[0].symbol, "ok");
});

test(
  "graph build: two concurrent builds do not corrupt the DB (WAL + busy_timeout, fail-open on lock contention)",
  { skip: GRAPH_SKIP },
  async () => {
    const project = mkGraphProject({
      "a.js": "export function a() { return 1; }\n",
      "b.js": "export function b() { return 2; }\n",
    });

    const [r1, r2] = await Promise.all([
      spawnCatStateAsync(["graph", "build", "--session", "s1"], { cwd: project }),
      spawnCatStateAsync(["graph", "build", "--session", "s1"], { cwd: project }),
    ]);
    // fail-open contract: BOTH invocations exit 0 — either they both fully
    // committed (serialized by SQLite) or one hit the busy_timeout window
    // and reported {ok:false, skipped:"locked"} instead of crashing/corrupting.
    assert.equal(r1.status, 0, `build #1 stderr: ${r1.stderr}`);
    assert.equal(r2.status, 0, `build #2 stderr: ${r2.stderr}`);
    for (const r of [r1, r2]) {
      const parsed = JSON.parse(r.stdout);
      assert.ok(parsed.ok === true || (parsed.ok === false && parsed.skipped === "locked"), r.stdout);
    }

    // the DB must still be a valid, fully-queryable SQLite file with correct
    // content afterward — no corruption, no lost update.
    const qa = runGraphQuery(project, "a.js", { depth: 0 });
    assert.equal(qa.status, 0, qa.stderr);
    assert.equal(qa.json.ok, true);
    assert.equal(qa.json.parse_status, "ok");
    assert.equal(qa.json.nodes[0].symbol, "a");
    const qb = runGraphQuery(project, "b.js", { depth: 0 });
    assert.equal(qb.json.nodes[0].symbol, "b");
  }
);

test(
  "node:sqlite API self-check: DatabaseSync exposes prepare/run/all/exec (fails loudly on experimental API drift)",
  { skip: GRAPH_SKIP },
  async () => {
    const { DatabaseSync } = await import("node:sqlite");
    assert.equal(typeof DatabaseSync, "function");
    const db = new DatabaseSync(":memory:");
    try {
      assert.equal(typeof db.exec, "function");
      assert.equal(typeof db.prepare, "function");
      db.exec("CREATE TABLE t (a TEXT)");
      const insertStmt = db.prepare("INSERT INTO t (a) VALUES (?)");
      assert.equal(typeof insertStmt.run, "function");
      insertStmt.run("x");
      const selectStmt = db.prepare("SELECT * FROM t");
      assert.equal(typeof selectStmt.all, "function");
      assert.equal(typeof selectStmt.get, "function");
      const rows = selectStmt.all();
      assert.equal(rows.length, 1);
      assert.equal(rows[0].a, "x");
    } finally {
      db.close();
    }
  }
);

/**
 * Locates a below-floor (< 22.13.0) Node binary to prove the guard fires for
 * real, without hardcoding a machine-specific path into the assertions
 * themselves: prefers an explicit override (CAT_STATE_TEST_OLD_NODE, for
 * developers with an unusual nvm layout), then this dev environment's known
 * nvm path, then falls back to the CURRENT test-runner's own node if THAT
 * happens to already be below-floor (e.g. this repo's default Node 20).
 * Returns null (test skips) if no below-floor runtime can be found at all.
 */
function findBelowFloorNode() {
  const candidates = [
    process.env.CAT_STATE_TEST_OLD_NODE,
    path.join(os.homedir(), ".nvm", "versions", "node", "v22.12.0", "bin", "node"),
  ].filter(Boolean);
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return GRAPH_SQLITE_AVAILABLE ? null : process.execPath;
}

const belowFloorNode = findBelowFloorNode();
test(
  "graph build/graph query: below-floor Node exits 1 with the guard message; non-graph subcommands (state read) keep working",
  { skip: belowFloorNode ? false : "no below-floor (<22.13.0) Node runtime found — set CAT_STATE_TEST_OLD_NODE to exercise this" },
  () => {
    const project = mkTmpProject();
    const runOld = (args) => spawnSync(belowFloorNode, [CAT_STATE, ...args], { cwd: project, encoding: "utf8", timeout: 10000 });

    const build = runOld(["graph", "build", "--session", "s1"]);
    assert.equal(build.status, 1, build.stderr);
    assert.match(build.stderr, /cat-state: graph build requires Node 22\.13\.0 or newer, found /);

    const query = runOld(["graph", "query", "--session", "s1", "--file", "x.js"]);
    assert.equal(query.status, 1, query.stderr);
    assert.match(query.stderr, /cat-state: graph query requires Node 22\.13\.0 or newer, found /);

    // a non-graph subcommand must be completely unaffected by the guard
    const stateRead = runOld(["state", "read", "--session", "s1", "--skill", "ultragoal"]);
    assert.equal(stateRead.status, 0, stateRead.stderr);
    const receipt = JSON.parse(stateRead.stdout);
    assert.equal(typeof receipt, "object");
  }
);
