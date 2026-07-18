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
