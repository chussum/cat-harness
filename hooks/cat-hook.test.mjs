/**
 * hooks/cat-hook.test.mjs — regression + G003 auto-start coverage for
 * hooks/cat-hook.mjs. cat-hook.mjs's main() calls process.exit(0) directly, so
 * every case here spawns it as a real child process (matching its actual
 * invocation contract: JSON on stdin, JSON on stdout, exit 0) rather than
 * importing its functions in-process.
 *
 * G003 hermeticism: CAT_HARNESS_HOME always points at a fresh tmp dir (never
 * the real ~/.cat-harness) and CAT_HARNESS_TEST_SPAWN_CAPTURE always points at
 * a tmp file, so the router's detached-launcher spawn is CAPTURED to that file
 * instead of an actual process fork ever happening — no real port is ever
 * touched and no real network call is ever possible from these tests (the
 * auto-start code path itself contains no http/net import at all — see the
 * dedicated source-inspection test below).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { upsertRegistryRoot } from "../dashboard/server/registry.mjs";
import { isLocallyLive, writeServerJson } from "../dashboard/server/singleton.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOOK_PATH = path.join(HERE, "cat-hook.mjs");
const LAUNCHER_PATH = path.join(HERE, "..", "dashboard", "server", "launcher.mjs");

function mkTmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cat-harness-hook-home-"));
}

function mkTmpProject({ withCat = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cat-harness-hook-project-"));
  if (withCat) fs.mkdirSync(path.join(dir, ".cat"), { recursive: true });
  return dir;
}

let anonymousCaptureHome = null;

/**
 * Runs cat-hook.mjs as a real child process — its actual invocation contract.
 * ALWAYS defaults CAT_HARNESS_TEST_SPAWN_CAPTURE to a throwaway tmp file
 * unless the caller overrides it, so NO test invocation here can ever trigger
 * a real detached spawn by omission — hermeticism must not depend on every
 * call site remembering to opt in.
 */
function runHook(mode, input, envOverrides = {}) {
  if (!anonymousCaptureHome) anonymousCaptureHome = mkTmpHome();
  const defaultCapture = path.join(anonymousCaptureHome, `unused-capture-${Math.random().toString(36).slice(2)}.jsonl`);
  const result = spawnSync(process.execPath, [HOOK_PATH, mode], {
    input: JSON.stringify(input),
    env: { ...process.env, CAT_HARNESS_TEST_SPAWN_CAPTURE: defaultCapture, ...envOverrides },
    encoding: "utf8",
    timeout: 10000,
  });
  return result;
}

function readSpawnCaptures(file) {
  try {
    return fs
      .readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(line => JSON.parse(line));
  } catch {
    return [];
  }
}

function readRegistry(homeDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(homeDir, "registry.json"), "utf8"));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Regression guard: the router's emitted block is IDENTICAL regardless of
// what the auto-start step decides to do (spawn or not, register or not).
// ---------------------------------------------------------------------------

test("regression: router emits the same additionalContext block whether or not auto-start spawns a launcher", () => {
  const projectNoCat = mkTmpProject({ withCat: false });
  const homeMissing = mkTmpHome(); // triggers a spawn (no server.json)
  const homeLive = mkTmpHome(); // will NOT trigger a spawn (fresh live self-record)
  fs.writeFileSync(
    path.join(homeLive, "server.json"),
    JSON.stringify({ port: 9223, pid: process.pid, token: "t", boot_nonce: "live-nonce", started_at: "x" }),
  );
  const capture1 = path.join(mkTmpHome(), "spawn-capture-1.jsonl");
  const capture2 = path.join(mkTmpHome(), "spawn-capture-2.jsonl");
  const input = { cwd: projectNoCat, session_id: "testsid", prompt: "hello" };

  const a = runHook("router", input, { CAT_HARNESS_HOME: homeMissing, CAT_HARNESS_TEST_SPAWN_CAPTURE: capture1 });
  const b = runHook("router", input, { CAT_HARNESS_HOME: homeLive, CAT_HARNESS_TEST_SPAWN_CAPTURE: capture2 });

  assert.equal(a.status, 0);
  assert.equal(b.status, 0);
  assert.equal(a.stdout, b.stdout, "the emitted router block must never be affected by the auto-start outcome");
  assert.ok(a.stdout.includes("<cat-harness-router>"));

  // Sanity: the two scenarios really did diverge on the auto-start decision itself.
  assert.equal(readSpawnCaptures(capture1).length, 1, "missing server.json must trigger a spawn");
  assert.equal(readSpawnCaptures(capture2).length, 0, "a live self-record must NOT trigger a spawn");
});

test("regression: pretool mutation-guard (Write to .cat/state) is unaffected by CAT_HARNESS_HOME/auto-start", () => {
  const projectWithCat = mkTmpProject({ withCat: true });
  const sessionDir = path.join(projectWithCat, ".cat", "_session-testsid");
  fs.mkdirSync(sessionDir, { recursive: true });
  const home = mkTmpHome();
  const input = {
    cwd: projectWithCat,
    session_id: "testsid",
    tool_name: "Write",
    tool_input: { file_path: ".cat/_session-testsid/state/foo.json" },
  };
  const result = runHook("pretool", input, { CAT_HARNESS_HOME: home });
  assert.equal(result.status, 0);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.hookSpecificOutput.permissionDecision, "deny");
  assert.match(parsed.hookSpecificOutput.permissionDecisionReason, /runtime-owned/);
});

// ---------------------------------------------------------------------------
// Regression: the phase-boundary Bash mutation guard must NOT misread the ASCII
// arrow operators `=>` / `->` as an output redirect (`> file`). Before the fix,
// `BASH_MUTATION_COMMAND_RE`'s redirect alternative allowed any non-`<>` char
// before `>`, so `d=>x`, `a->b`, JS arrow functions in `node -e`, and `->`/`=>`
// inside heredoc/echo text all looked like a redirect to a phantom file and got
// denied during ralplan/ultragoal planning phases.
// ---------------------------------------------------------------------------
function seedBlockingRalplan(sid = "testsid") {
  const project = mkTmpProject({ withCat: true });
  const stateDir = path.join(project, ".cat", `_session-${sid}`, "state");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, "ralplan-state.json"),
    JSON.stringify({ skill: "ralplan", active: true, current_phase: "review", updated_at: "2026-01-01T00:00:00.000Z" }),
  );
  return { project, sid };
}

function bashPretool(project, sid, command) {
  return runHook("pretool", { cwd: project, session_id: sid, tool_name: "Bash", tool_input: { command } });
}

test("regression: `=>`/`->` arrows are NOT misread as a redirect and NOT denied during a blocking ralplan phase", () => {
  const { project, sid } = seedBlockingRalplan();
  for (const command of [
    `node -e 'process.stdin.on("data", d => { globalThis.x = d })'`, // JS arrow function
    `echo "planner -> critic consensus pass"`, // ASCII arrow in echo text
    `printf 'a=>b and c->d\\n'`, // both arrows in a literal
  ]) {
    const result = bashPretool(project, sid, command);
    assert.equal(result.status, 0, `hook must exit 0 for: ${command}`);
    assert.equal(result.stdout.trim(), "", `arrow-only command must NOT be denied (no permissionDecision) for: ${command}`);
  }
});

test("regression: a REAL output redirect to a non-.cat path is STILL denied during a blocking ralplan phase", () => {
  const { project, sid } = seedBlockingRalplan();
  const outside = path.join(os.tmpdir(), "cat-hook-redirect-regression.txt");
  const result = bashPretool(project, sid, `echo hi > ${outside}`);
  assert.equal(result.status, 0);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.hookSpecificOutput.permissionDecision, "deny", "a real `> file` redirect must still be caught as a mutation");
  assert.match(parsed.hookSpecificOutput.permissionDecisionReason, /planning phase boundary/i);
});

test("regression: stop with no state dir is a silent no-op regardless of CAT_HARNESS_HOME", () => {
  const projectWithCat = mkTmpProject({ withCat: true });
  const home = mkTmpHome();
  const input = { cwd: projectWithCat, session_id: "testsid" };
  const result = runHook("stop", input, { CAT_HARNESS_HOME: home });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
});

// ---------------------------------------------------------------------------
// G003: liveness pre-check → spawn decision
// ---------------------------------------------------------------------------

test("auto-start: fresh self-written server.json with a live pid + well-formed nonce → NO spawn", () => {
  const home = mkTmpHome();
  fs.writeFileSync(
    path.join(home, "server.json"),
    JSON.stringify({ port: 9223, pid: process.pid, token: "t", boot_nonce: "well-formed", started_at: "x" }),
  );
  const capture = path.join(mkTmpHome(), "capture.jsonl");
  const result = runHook(
    "router",
    { cwd: mkTmpProject(), session_id: "s1", prompt: "hi" },
    { CAT_HARNESS_HOME: home, CAT_HARNESS_TEST_SPAWN_CAPTURE: capture },
  );
  assert.equal(result.status, 0);
  assert.equal(readSpawnCaptures(capture).length, 0);
});

test("auto-start: missing server.json → spawn requested (correct launcher path, detached, unref)", () => {
  const home = mkTmpHome();
  const capture = path.join(mkTmpHome(), "capture.jsonl");
  const result = runHook(
    "router",
    { cwd: mkTmpProject(), session_id: "s1", prompt: "hi" },
    { CAT_HARNESS_HOME: home, CAT_HARNESS_TEST_SPAWN_CAPTURE: capture },
  );
  assert.equal(result.status, 0);
  const captures = readSpawnCaptures(capture);
  assert.equal(captures.length, 1);
  assert.equal(path.resolve(captures[0].args[0]), path.resolve(LAUNCHER_PATH));
  assert.equal(captures[0].detached, true);
  assert.equal(captures[0].unref, true);
});

test("auto-start: dead-pid server.json → spawn requested", () => {
  const home = mkTmpHome();
  fs.writeFileSync(
    path.join(home, "server.json"),
    JSON.stringify({ port: 9223, pid: 999999, token: "t", boot_nonce: "well-formed", started_at: "x" }),
  );
  const capture = path.join(mkTmpHome(), "capture.jsonl");
  const result = runHook(
    "router",
    { cwd: mkTmpProject(), session_id: "s1", prompt: "hi" },
    { CAT_HARNESS_HOME: home, CAT_HARNESS_TEST_SPAWN_CAPTURE: capture },
  );
  assert.equal(result.status, 0);
  assert.equal(readSpawnCaptures(capture).length, 1);
});

test("auto-start: malformed (missing) boot_nonce with a live pid → spawn requested", () => {
  const home = mkTmpHome();
  fs.writeFileSync(path.join(home, "server.json"), JSON.stringify({ port: 9223, pid: process.pid, token: "t" }));
  const capture = path.join(mkTmpHome(), "capture.jsonl");
  const result = runHook(
    "router",
    { cwd: mkTmpProject(), session_id: "s1", prompt: "hi" },
    { CAT_HARNESS_HOME: home, CAT_HARNESS_TEST_SPAWN_CAPTURE: capture },
  );
  assert.equal(result.status, 0);
  assert.equal(readSpawnCaptures(capture).length, 1);
});

test("auto-start: corrupt (non-JSON) server.json → spawn requested (fail-open)", () => {
  const home = mkTmpHome();
  fs.writeFileSync(path.join(home, "server.json"), "not json at all");
  const capture = path.join(mkTmpHome(), "capture.jsonl");
  const result = runHook(
    "router",
    { cwd: mkTmpProject(), session_id: "s1", prompt: "hi" },
    { CAT_HARNESS_HOME: home, CAT_HARNESS_TEST_SPAWN_CAPTURE: capture },
  );
  assert.equal(result.status, 0);
  assert.equal(readSpawnCaptures(capture).length, 1);
});

// ---------------------------------------------------------------------------
// G003: registry auto-registration
// ---------------------------------------------------------------------------

test("registry upsert: router adds the cwd when .cat exists, and is idempotent (no dupes) across repeated calls", () => {
  const home = mkTmpHome();
  const project = mkTmpProject({ withCat: true });
  const input = { cwd: project, session_id: "s1", prompt: "hi" };

  runHook("router", input, { CAT_HARNESS_HOME: home });
  const first = readRegistry(home);
  assert.deepEqual(first.roots, [path.resolve(project)]);

  runHook("router", input, { CAT_HARNESS_HOME: home });
  const second = readRegistry(home);
  assert.deepEqual(second.roots, [path.resolve(project)], "re-running the router must not duplicate the root");
});

test("registry upsert: writes are atomic (tmp+rename, no leftover .tmp.* files, valid JSON on every write)", () => {
  const home = mkTmpHome();
  const project = mkTmpProject({ withCat: true });
  runHook("router", { cwd: project, session_id: "s1", prompt: "hi" }, { CAT_HARNESS_HOME: home });
  const entries = fs.readdirSync(home);
  assert.ok(!entries.some(name => name.includes(".tmp.")), "no atomic-write temp file should survive");
  const parsed = readRegistry(home);
  assert.equal(parsed.version, 1);
  assert.ok(typeof parsed.updated_at === "string" && parsed.updated_at.length > 0);
});

test("registry gate: a project WITHOUT .cat is never auto-registered", () => {
  const home = mkTmpHome();
  const project = mkTmpProject({ withCat: false });
  runHook("router", { cwd: project, session_id: "s1", prompt: "hi" }, { CAT_HARNESS_HOME: home });
  assert.equal(readRegistry(home), null, "no registry.json should be written for an uninitialized project");
});

// ---------------------------------------------------------------------------
// G003: integration — one router call triggers BOTH registry upsert AND a
// detached-spawn stub, and never makes a real network call.
// ---------------------------------------------------------------------------

test("integration: a single UserPromptSubmit triggers registry upsert AND a detached launcher spawn (via the test stub)", () => {
  const home = mkTmpHome();
  const project = mkTmpProject({ withCat: true });
  const capture = path.join(mkTmpHome(), "capture.jsonl");
  const result = runHook(
    "router",
    { cwd: project, session_id: "s1", prompt: "hello" },
    { CAT_HARNESS_HOME: home, CAT_HARNESS_TEST_SPAWN_CAPTURE: capture },
  );
  assert.equal(result.status, 0);

  const registry = readRegistry(home);
  assert.deepEqual(registry.roots, [path.resolve(project)]);

  const captures = readSpawnCaptures(capture);
  assert.equal(captures.length, 1);
  assert.equal(captures[0].command, process.execPath);
  assert.equal(path.resolve(captures[0].args[0]), path.resolve(LAUNCHER_PATH));
  assert.equal(captures[0].detached, true);
  assert.equal(captures[0].unref, true);
});

test("source inspection: the router auto-start code path imports no HTTP/network module — it CANNOT make a network call", () => {
  const source = fs.readFileSync(HOOK_PATH, "utf8");
  assert.ok(!/from\s+["']node:https?["']/.test(source), "cat-hook.mjs must never import node:http or node:https");
  assert.ok(!/from\s+["']node:net["']/.test(source), "cat-hook.mjs must never import node:net");
});

// ---------------------------------------------------------------------------
// Parity guards (architect review, MEDIUM finding): hooks/cat-hook.mjs
// deliberately MIRRORS dashboard/server/{registry,singleton}.mjs's shapes
// inline rather than importing them (isolation — a broken dashboard/ tree
// must never break the hook). Nothing else pins those two copies together,
// so if the canonical modules' shape/semantics drift (a field rename, a
// dedup-semantics change, a tightened nonce check, ...) the hook's copy could
// silently diverge. These two tests cross-check the hook's BLACK-BOX behavior
// (subprocess, test-mode) against the CANONICAL functions' actual output for
// the same inputs, so a drift in either direction fails loudly here instead
// of only being caught by human review.
// ---------------------------------------------------------------------------

function seedRawRegistry(homeDir, rawRoots) {
  if (rawRoots === null) return; // exercises the "missing registry.json" case
  fs.mkdirSync(homeDir, { recursive: true });
  fs.writeFileSync(
    path.join(homeDir, "registry.json"),
    `${JSON.stringify({ version: 1, roots: rawRoots, updated_at: "2020-01-01T00:00:00.000Z" }, null, 2)}\n`,
  );
}

function readRawRegistryFile(homeDir) {
  return JSON.parse(fs.readFileSync(path.join(homeDir, "registry.json"), "utf8"));
}

test("parity: registry upsert — hook's inline mirror matches canonical dashboard/server/registry.mjs (empty / fresh / duplicate / un-normalized-existing-root)", () => {
  const freshProject = mkTmpProject({ withCat: true }); // the NEW root every scenario registers
  const otherProjectDir = path.join(mkTmpHome(), "other-project"); // an unrelated EXISTING root

  const scenarios = [
    { name: "empty/missing registry.json", initialRaw: null },
    { name: "fresh root added alongside an existing normalized root", initialRaw: [path.resolve(otherProjectDir)] },
    { name: "duplicate root (already present, exact resolved form)", initialRaw: [path.resolve(freshProject)] },
    {
      // A literal, deliberately un-normalized string (NOT built via path.join,
      // which would normalize it away before it ever reached the file) —
      // exactly the shape an externally-written registry.json could carry.
      name: "externally-written registry.json with an UN-NORMALIZED existing root path",
      initialRaw: [`${otherProjectDir}/./`],
    },
  ];

  for (const scenario of scenarios) {
    const hookHome = mkTmpHome();
    const canonicalHome = mkTmpHome();
    seedRawRegistry(hookHome, scenario.initialRaw);
    seedRawRegistry(canonicalHome, scenario.initialRaw);

    // Canonical side: dashboard/server/registry.mjs's OWN upsert, called directly.
    upsertRegistryRoot(canonicalHome, freshProject);

    // Hook side: the SAME operation via the router hook's inline mirror (real
    // subprocess, test-mode spawn capture so no real launcher is forked).
    const result = runHook("router", { cwd: freshProject, session_id: "s1", prompt: "hi" }, { CAT_HARNESS_HOME: hookHome });
    assert.equal(result.status, 0, `[${scenario.name}] router subprocess must exit 0`);

    const hookFile = readRawRegistryFile(hookHome);
    const canonicalFile = readRawRegistryFile(canonicalHome);
    assert.equal(hookFile.version, canonicalFile.version, `[${scenario.name}] version field must match canonical`);
    assert.deepEqual(
      hookFile.roots,
      canonicalFile.roots,
      `[${scenario.name}] hook-written registry.json roots must be IDENTICAL to canonical registry.mjs's own upsert output (same normalization + dedup semantics)`,
    );
  }
});

test("parity: server.json liveness pre-check — hook's spawn decision matches canonical singleton.mjs's isLocallyLive (live / dead-pid / malformed-nonce / missing)", () => {
  const cases = [
    {
      name: "live self pid + well-formed nonce",
      setup: home => writeServerJson(home, { port: 9223, pid: process.pid, token: "t", bootNonce: "well-formed", startedAt: "x" }),
    },
    {
      name: "dead pid",
      setup: home => writeServerJson(home, { port: 9223, pid: 999999, token: "t", bootNonce: "well-formed", startedAt: "x" }),
    },
    {
      name: "malformed (empty) boot_nonce",
      setup: home => writeServerJson(home, { port: 9223, pid: process.pid, token: "t", bootNonce: "", startedAt: "x" }),
    },
    {
      name: "missing server.json",
      setup: () => {},
    },
  ];

  for (const c of cases) {
    const home = mkTmpHome();
    c.setup(home);
    const canonicalLive = isLocallyLive(home); // dashboard/server/singleton.mjs's own verdict

    const capture = path.join(mkTmpHome(), "capture.jsonl");
    const result = runHook(
      "router",
      { cwd: mkTmpProject(), session_id: "s1", prompt: "hi" },
      { CAT_HARNESS_HOME: home, CAT_HARNESS_TEST_SPAWN_CAPTURE: capture },
    );
    assert.equal(result.status, 0, `[${c.name}] router subprocess must exit 0`);
    const spawned = readSpawnCaptures(capture).length > 0;

    assert.equal(
      spawned,
      !canonicalLive,
      `[${c.name}] hook's spawn decision (spawned=${spawned}) must be the exact inverse of canonical isLocallyLive (${canonicalLive})`,
    );
  }
});

// ---------------------------------------------------------------------------
// G004: dialogue-excerpt capture (PreToolUse[Agent|Task] dispatch half +
// SubagentStop reply half). Passive, disk-only, fail-open — never emits
// permissionDecision/additionalContext, never affects the tool call.
// ---------------------------------------------------------------------------

function mkSession(sessionId = "testsid") {
  const project = mkTmpProject({ withCat: true });
  const dir = path.join(project, ".cat", `_session-${sessionId}`);
  fs.mkdirSync(path.join(dir, "state"), { recursive: true });
  return { project, dir, sessionId };
}

function readPending(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "state", "dialogue-pending.json"), "utf8"));
  } catch {
    return null;
  }
}

function readExcerpts(dir) {
  try {
    return fs
      .readFileSync(path.join(dir, "state", "dialogue-excerpts.jsonl"), "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(line => JSON.parse(line));
  } catch {
    return [];
  }
}

function dispatchInput({ project, sessionId, agentType, prompt, promptId = "p1", toolName = "Agent", parentAgentType, parentAgentId }) {
  const input = {
    cwd: project,
    session_id: sessionId,
    prompt_id: promptId,
    tool_name: toolName,
    tool_input: { description: "d", prompt, subagent_type: agentType },
  };
  // Feature B: a nested dispatch (PreToolUse[Agent] firing INSIDE a running
  // subagent) carries that dispatcher's own identity in agent_type/agent_id.
  if (parentAgentType !== undefined) input.agent_type = parentAgentType;
  if (parentAgentId !== undefined) input.agent_id = parentAgentId;
  return input;
}

function subagentStopInput({ project, sessionId, agentType, lastAssistantMessage, promptId = "p1", agentId = "aXXX" }) {
  const out = { cwd: project, session_id: sessionId, prompt_id: promptId, agent_type: agentType, agent_id: agentId };
  if (lastAssistantMessage !== undefined) out.last_assistant_message = lastAssistantMessage;
  return out;
}

test("G004 scope filter: cat-harness-namespaced subagent_type is captured; general-purpose is skipped silently", () => {
  const { project, dir, sessionId } = mkSession();
  const captured = runHook("pretool", dispatchInput({ project, sessionId, agentType: "cat-harness:planner", prompt: "Draft the plan." }));
  assert.equal(captured.status, 0);
  assert.equal(captured.stdout, "", "dispatch capture must emit nothing to stdout (passive)");
  const pending1 = readPending(dir);
  assert.ok(pending1 && Array.isArray(pending1["cat-harness:planner"]) && pending1["cat-harness:planner"].length === 1);

  const skipped = runHook("pretool", dispatchInput({ project, sessionId, agentType: "general-purpose", prompt: "Reply with OK." }));
  assert.equal(skipped.status, 0);
  assert.equal(skipped.stdout, "");
  const pending2 = readPending(dir);
  assert.ok(!pending2["general-purpose"], "non-namespaced agent_type must never be enqueued");
  assert.equal(pending2["cat-harness:planner"].length, 1, "the namespaced queue must be untouched by the skipped dispatch");
});

test("G004 excerpt truncation: sentence-boundary aware, then hard-capped at 140 chars", () => {
  const { project, dir, sessionId } = mkSession();

  // A short first sentence well under 140 chars -> excerpt stops at the sentence boundary,
  // the second sentence must never leak in.
  const shortPrompt = "Draft the plan for widget X. This second sentence must never appear in the excerpt.";
  runHook("pretool", dispatchInput({ project, sessionId, agentType: "cat-harness:planner", prompt: shortPrompt, promptId: "pA" }));
  const afterA = readPending(dir)["cat-harness:planner"].at(-1);
  assert.equal(afterA.dispatchExcerpt, "Draft the plan for widget X.");
  assert.ok(afterA.dispatchExcerpt.length <= 140);

  // No sentence-ending punctuation anywhere and the text exceeds 140 chars -> hard-capped at 140.
  const longNoPunct = "x".repeat(200);
  runHook("pretool", dispatchInput({ project, sessionId, agentType: "cat-harness:planner", prompt: longNoPunct, promptId: "pB" }));
  const afterB = readPending(dir)["cat-harness:planner"].at(-1);
  assert.equal(afterB.dispatchExcerpt.length, 140);
  assert.equal(afterB.dispatchExcerpt, "x".repeat(140));

  // The first sentence itself is longer than 140 chars -> hard cap wins even though a sentence
  // boundary exists further out in the text.
  const longSentence = `${"y".repeat(160)}. trailing text`;
  runHook("pretool", dispatchInput({ project, sessionId, agentType: "cat-harness:planner", prompt: longSentence, promptId: "pC" }));
  const afterC = readPending(dir)["cat-harness:planner"].at(-1);
  assert.equal(afterC.dispatchExcerpt.length, 140);
  assert.equal(afterC.dispatchExcerpt, "y".repeat(140));
});

test("G004 field-source correctness: dispatch excerpt comes from tool_input.prompt, reply excerpt from last_assistant_message", () => {
  const { project, dir, sessionId } = mkSession();
  runHook("pretool", dispatchInput({ project, sessionId, agentType: "cat-harness:executor", prompt: "Implement the widget cache layer.", promptId: "pd1" }));
  const stopResult = runHook(
    "subagentstop",
    subagentStopInput({ project, sessionId, agentType: "cat-harness:executor", lastAssistantMessage: "Implemented the cache layer successfully. Tests pass.", promptId: "pd1" }),
  );
  assert.equal(stopResult.status, 0);
  assert.equal(stopResult.stdout, "", "subagentstop must emit nothing to stdout");

  const lines = readExcerpts(dir);
  assert.equal(lines.length, 2);
  const dispatchLine = lines.find(l => l.role === "dispatch");
  const replyLine = lines.find(l => l.role === "reply");
  assert.equal(dispatchLine.excerpt, "Implement the widget cache layer.");
  assert.equal(replyLine.excerpt, "Implemented the cache layer successfully.");
  assert.equal(dispatchLine.round_trip_id, replyLine.round_trip_id);
  assert.equal(dispatchLine.paired, true);
  assert.equal(replyLine.paired, true);
});

test("G004 FIFO pairing: two same-agentType dispatches, replies arrive in the SAME order -> pair with the correct dispatch each time", () => {
  const { project, dir, sessionId } = mkSession();
  runHook("pretool", dispatchInput({ project, sessionId, agentType: "cat-harness:architect", prompt: "Review change A.", promptId: "a1" }));
  runHook("pretool", dispatchInput({ project, sessionId, agentType: "cat-harness:architect", prompt: "Review change B.", promptId: "a2" }));

  runHook("subagentstop", subagentStopInput({ project, sessionId, agentType: "cat-harness:architect", lastAssistantMessage: "Change A looks clear.", promptId: "a1", agentId: "agent1" }));
  runHook("subagentstop", subagentStopInput({ project, sessionId, agentType: "cat-harness:architect", lastAssistantMessage: "Change B looks clear.", promptId: "a2", agentId: "agent2" }));

  const lines = readExcerpts(dir);
  assert.equal(lines.length, 4);
  const roundTrips = new Map();
  for (const l of lines) {
    if (!roundTrips.has(l.round_trip_id)) roundTrips.set(l.round_trip_id, {});
    roundTrips.get(l.round_trip_id)[l.role] = l;
  }
  assert.equal(roundTrips.size, 2);
  const sorted = [...roundTrips.values()].sort((x, y) => x.dispatch.ts.localeCompare(y.dispatch.ts));
  assert.equal(sorted[0].dispatch.excerpt, "Review change A.");
  assert.equal(sorted[0].reply.excerpt, "Change A looks clear.");
  assert.equal(sorted[1].dispatch.excerpt, "Review change B.");
  assert.equal(sorted[1].reply.excerpt, "Change B looks clear.");
});

test("G004 documented cosmetic mispair: 2 same-agentType dispatches, replies arrive REVERSED -> FIFO pops the OLDEST dispatch regardless of which subagent actually replied", () => {
  const { project, dir, sessionId } = mkSession();
  runHook("pretool", dispatchInput({ project, sessionId, agentType: "cat-harness:critic", prompt: "Evaluate plan A.", promptId: "c1" }));
  runHook("pretool", dispatchInput({ project, sessionId, agentType: "cat-harness:critic", prompt: "Evaluate plan B.", promptId: "c2" }));

  // The SECOND dispatch's agent actually finishes FIRST (out-of-order completion).
  runHook("subagentstop", subagentStopInput({ project, sessionId, agentType: "cat-harness:critic", lastAssistantMessage: "Plan B verdict: OKAY.", promptId: "c2", agentId: "agentB" }));
  runHook("subagentstop", subagentStopInput({ project, sessionId, agentType: "cat-harness:critic", lastAssistantMessage: "Plan A verdict: ITERATE.", promptId: "c1", agentId: "agentA" }));

  const lines = readExcerpts(dir);
  assert.equal(lines.length, 4);
  const roundTrips = new Map();
  for (const l of lines) {
    if (!roundTrips.has(l.round_trip_id)) roundTrips.set(l.round_trip_id, {});
    roundTrips.get(l.round_trip_id)[l.role] = l;
  }
  assert.equal(roundTrips.size, 2);
  const sorted = [...roundTrips.values()].sort((x, y) => x.dispatch.ts.localeCompare(y.dispatch.ts));
  // KNOWN cosmetic mispair: FIFO pops the OLDEST pending dispatch ("plan A") for the FIRST
  // SubagentStop event, even though that event actually carries plan B's reply text — because
  // FIFO-per-agentType pairs on ARRIVAL ORDER of SubagentStop events, not on which subagent
  // actually produced the reply. This is the documented, accepted degradation of FIFO-per-
  // agentType pairing under concurrent/out-of-order completion (both halves are still recorded,
  // just cross-paired) — the exact tradeoff the G001 spike's architect-ratified decision accepted
  // in favor of NOT relying on prompt_id (which may be shared across concurrent same-turn
  // dispatches and therefore cannot disambiguate this case either).
  assert.equal(sorted[0].dispatch.excerpt, "Evaluate plan A.");
  assert.equal(sorted[0].reply.excerpt, "Plan B verdict: OKAY.");
  assert.equal(sorted[1].dispatch.excerpt, "Evaluate plan B.");
  assert.equal(sorted[1].reply.excerpt, "Plan A verdict: ITERATE.");
  for (const pair of roundTrips.values()) {
    assert.equal(pair.dispatch.paired, true);
    assert.equal(pair.reply.paired, true);
  }
});

// ---------------------------------------------------------------------------
// Feature B: nested sub-agent dialogue (a cat-harness agent that itself
// dispatches a subagent). The parent/dispatcher identity is carried on the
// INNER PreToolUse[Agent] payload's own agent_type/agent_id — confirmed live
// against the executor->critic nested capture (.cat/nested-capture). The hook
// threads it as parent_agent_type onto BOTH round-trip lines; for a top-level
// (leader) dispatch the field is OMITTED, keeping the non-nested line
// byte-identical to the pre-Feature-B format.
// ---------------------------------------------------------------------------

test("Feature B nested dispatch: an executor->critic round trip carries parent_agent_type=cat-harness:executor on BOTH lines", () => {
  const { project, dir, sessionId } = mkSession();
  // INNER PreToolUse: the executor (parentAgentType) dispatches a critic. The dispatcher's
  // own identity rides on input.agent_type/agent_id exactly as the live capture recorded.
  runHook(
    "pretool",
    dispatchInput({
      project,
      sessionId,
      agentType: "cat-harness:critic",
      prompt: "Critique the rollback safety of a ranking-model swap in one sentence.",
      promptId: "nested1",
      parentAgentType: "cat-harness:executor",
      parentAgentId: "a675b59e2375649ff",
    }),
  );
  const pending = readPending(dir)["cat-harness:critic"].at(-1);
  assert.equal(pending.parentAgentType, "cat-harness:executor", "the dispatcher identity must be stored on the pending record");

  runHook(
    "subagentstop",
    subagentStopInput({ project, sessionId, agentType: "cat-harness:critic", lastAssistantMessage: "Rollback is safe only behind a versioned feature flag. VERDICT: OKAY", promptId: "nested1", agentId: "a9aeada03cd54dfb2" }),
  );
  const lines = readExcerpts(dir);
  assert.equal(lines.length, 2);
  const dispatchLine = lines.find(l => l.role === "dispatch");
  const replyLine = lines.find(l => l.role === "reply");
  assert.equal(dispatchLine.parent_agent_type, "cat-harness:executor");
  assert.equal(replyLine.parent_agent_type, "cat-harness:executor");
  assert.equal(dispatchLine.agent_type, "cat-harness:critic", "agent_type still names the CHILD (critic); parent is separate");
  assert.equal(dispatchLine.round_trip_id, replyLine.round_trip_id);
});

test("Feature B top-level dispatch: no parent identity -> parent_agent_type key is OMITTED (non-nested line byte-identical)", () => {
  const { project, dir, sessionId } = mkSession();
  // Leader->executor: a top-level dispatch has NO agent_type on the PreToolUse payload.
  runHook("pretool", dispatchInput({ project, sessionId, agentType: "cat-harness:executor", prompt: "Implement the cache layer.", promptId: "top1" }));
  const pending = readPending(dir)["cat-harness:executor"].at(-1);
  assert.equal(pending.parentAgentType, null, "top-level dispatch stores parentAgentType=null");

  runHook("subagentstop", subagentStopInput({ project, sessionId, agentType: "cat-harness:executor", lastAssistantMessage: "Done. Tests pass.", promptId: "top1", agentId: "topAgent" }));
  const lines = readExcerpts(dir);
  assert.equal(lines.length, 2);
  for (const l of lines) {
    assert.ok(!("parent_agent_type" in l), "the parent_agent_type key must be ABSENT for a top-level dispatch, not present-and-null");
  }
});

test("Feature B non-namespaced dispatcher: a general-purpose parent dispatching a cat-harness child does NOT record a parent (only cat-harness parents count)", () => {
  const { project, dir, sessionId } = mkSession();
  runHook(
    "pretool",
    dispatchInput({ project, sessionId, agentType: "cat-harness:planner", prompt: "Draft the plan.", promptId: "np1", parentAgentType: "general-purpose", parentAgentId: "gpAgent" }),
  );
  const pending = readPending(dir)["cat-harness:planner"].at(-1);
  assert.equal(pending.parentAgentType, null, "a non-namespaced dispatcher must not be recorded as a parent");

  runHook("subagentstop", subagentStopInput({ project, sessionId, agentType: "cat-harness:planner", lastAssistantMessage: "Plan drafted.", promptId: "np1", agentId: "plAgent" }));
  const lines = readExcerpts(dir);
  for (const l of lines) {
    assert.ok(!("parent_agent_type" in l), "no parent_agent_type key when the dispatcher is non-namespaced");
  }
});

test("G004 bounded FIFO cap: enqueueing 51 dispatches for the same agentType evicts the OLDEST, keeping exactly 50", () => {
  const { project, dir, sessionId } = mkSession();
  for (let i = 1; i <= 51; i++) {
    runHook("pretool", dispatchInput({ project, sessionId, agentType: "cat-harness:executor", prompt: `Task number ${i}.`, promptId: `t${i}` }));
  }
  const queue = readPending(dir)["cat-harness:executor"];
  assert.equal(queue.length, 50, "queue must be capped at 50 entries");
  assert.equal(queue[0].dispatchExcerpt, "Task number 2.", "the OLDEST entry (Task number 1) must have been evicted");
  assert.equal(queue.at(-1).dispatchExcerpt, "Task number 51.");
});

test("G004 no-match reply: a SubagentStop with no pending dispatch for its agentType writes ONE reply line with paired:false", () => {
  const { project, dir, sessionId } = mkSession();
  const result = runHook("subagentstop", subagentStopInput({ project, sessionId, agentType: "cat-harness:planner", lastAssistantMessage: "Unprompted reply text here.", promptId: "orphan" }));
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
  const lines = readExcerpts(dir);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].role, "reply");
  assert.equal(lines[0].paired, false);
  assert.equal(lines[0].excerpt, "Unprompted reply text here.");
});

test("G004 integration: the REAL Phase-2 spike capture samples (subagent_type/agent_type general-purpose) are correctly FILTERED OUT — no pending entry, no excerpt", () => {
  const { project, dir, sessionId } = mkSession();
  // Verbatim (session_id/cwd substituted to this test's fixtures) from the G001 spike's
  // ".cat/_session-.../ultragoal/artifacts/phase2-spike-findings.md" appendix — the actual
  // captured PreToolUse[Agent] + SubagentStop payloads for a real `general-purpose` subagent.
  const realPretool = {
    session_id: sessionId,
    transcript_path: "/Users/hyungjoo/.claude/projects/-Users-hyungjoo-Projects-private-cat-workflow/64fcdaa2-8d3a-4e8e-9102-752c9634faf5.jsonl",
    cwd: project,
    prompt_id: "5ba7f9cc-0483-4c14-9878-351096dc17b9",
    permission_mode: "auto",
    effort: { level: "high" },
    hook_event_name: "PreToolUse",
    tool_name: "Agent",
    tool_input: {
      description: "Trivial hook-trigger subagent",
      prompt: "Reply with the single word OK. Do nothing else.",
      subagent_type: "general-purpose",
      run_in_background: false,
    },
    tool_use_id: "toolu_01Fi6N4jjQ5ogBtbNLJQT6t4",
  };
  const realSubagentStop = {
    session_id: sessionId,
    transcript_path: realPretool.transcript_path,
    cwd: project,
    prompt_id: "5ba7f9cc-0483-4c14-9878-351096dc17b9",
    permission_mode: "auto",
    agent_id: "a3474ddb07e41edec",
    agent_type: "general-purpose",
    effort: { level: "high" },
    hook_event_name: "SubagentStop",
    stop_hook_active: false,
    agent_transcript_path:
      "/Users/hyungjoo/.claude/projects/-Users-hyungjoo-Projects-private-cat-workflow/64fcdaa2-8d3a-4e8e-9102-752c9634faf5/subagents/agent-a3474ddb07e41edec.jsonl",
    last_assistant_message: "OK",
    background_tasks: [],
    session_crons: [],
  };

  const preResult = runHook("pretool", realPretool);
  assert.equal(preResult.status, 0);
  assert.equal(preResult.stdout, "");
  assert.equal(readPending(dir), null, "general-purpose dispatch must never create a pending file");

  const stopResult = runHook("subagentstop", realSubagentStop);
  assert.equal(stopResult.status, 0);
  assert.equal(stopResult.stdout, "");
  assert.equal(readExcerpts(dir).length, 0, "general-purpose SubagentStop must never write an excerpt line");
});

test("G004 integration: synthetic cat-harness:planner dispatch + reply produces exactly 2 jsonl lines sharing round_trip_id, genuine non-placeholder excerpts, zero stdout on both calls (disk-only, no LLM re-injection)", () => {
  const { project, dir, sessionId } = mkSession();
  const pre = runHook(
    "pretool",
    dispatchInput({
      project,
      sessionId,
      agentType: "cat-harness:planner",
      prompt: "Draft the plan for widget X. This second sentence must never appear in the excerpt.",
      promptId: "syn-1",
    }),
  );
  assert.equal(pre.status, 0);
  assert.equal(pre.stdout, "", "dispatch capture is passive — must never emit any stdout");

  const stop = runHook(
    "subagentstop",
    subagentStopInput({
      project,
      sessionId,
      agentType: "cat-harness:planner",
      lastAssistantMessage: "Plan drafted covering dispatch capture, reply capture, and FIFO pairing with a bounded queue.",
      promptId: "syn-1",
      agentId: "agentPlanner1",
    }),
  );
  assert.equal(stop.status, 0);
  assert.equal(stop.stdout, "", "subagentstop capture is passive — must never emit any stdout");

  const excerptsFile = path.join(dir, "state", "dialogue-excerpts.jsonl");
  assert.ok(fs.existsSync(excerptsFile), "excerpts must land on disk");
  const lines = readExcerpts(dir);
  assert.equal(lines.length, 2, "exactly one dispatch line + one reply line, nothing more");

  const dispatchLine = lines.find(l => l.role === "dispatch");
  const replyLine = lines.find(l => l.role === "reply");
  assert.ok(dispatchLine && replyLine);
  assert.equal(dispatchLine.round_trip_id, replyLine.round_trip_id);
  assert.equal(dispatchLine.agent_type, "cat-harness:planner");
  assert.equal(replyLine.agent_type, "cat-harness:planner");
  assert.equal(dispatchLine.paired, true);
  assert.equal(replyLine.paired, true);
  assert.equal(dispatchLine.excerpt, "Draft the plan for widget X.");
  assert.equal(replyLine.excerpt, "Plan drafted covering dispatch capture, reply capture, and FIFO pairing with a bounded queue.");
  // Genuine, non-placeholder excerpts.
  assert.ok(dispatchLine.excerpt.length > 10 && !/^(todo|tbd|n\/a|stub)$/i.test(dispatchLine.excerpt));
  assert.ok(replyLine.excerpt.length > 10 && !/^(todo|tbd|n\/a|stub)$/i.test(replyLine.excerpt));
});

test("G004 transcript-tail fallback: SubagentStop with NO last_assistant_message falls back to a bounded tail-read of agent_transcript_path", () => {
  const { project, dir, sessionId } = mkSession();
  runHook("pretool", dispatchInput({ project, sessionId, agentType: "cat-harness:executor", prompt: "Fix the failing test.", promptId: "tf1" }));

  const transcriptDir = fs.mkdtempSync(path.join(os.tmpdir(), "cat-harness-transcript-"));
  const transcriptPath = path.join(transcriptDir, "agent-fallback.jsonl");
  const lines = [
    JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: "go" }] } }),
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Fixed the failing test. All green now." }] } }),
  ];
  fs.writeFileSync(transcriptPath, `${lines.join("\n")}\n`);

  const result = runHook("subagentstop", {
    cwd: project,
    session_id: sessionId,
    prompt_id: "tf1",
    agent_type: "cat-harness:executor",
    agent_id: "agentExec1",
    agent_transcript_path: transcriptPath,
    // last_assistant_message deliberately absent
  });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");

  const excerpts = readExcerpts(dir);
  const replyLine = excerpts.find(l => l.role === "reply");
  assert.equal(replyLine.excerpt, "Fixed the failing test.");
  assert.equal(replyLine.paired, true);
  fs.rmSync(transcriptDir, { recursive: true, force: true });
});

test("G004 regression: pretool Agent/Task dispatch capture is passive — never emits permissionDecision, never denies", () => {
  const { project, sessionId } = mkSession();
  const result = runHook("pretool", dispatchInput({ project, sessionId, agentType: "cat-harness:planner", prompt: "Draft the plan." }));
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "", "the Agent/Task pretool branch must emit NOTHING — no permissionDecision, no additionalContext");
});

test("G004 regression: Task tool_name is accepted with the same contract as Agent (portability to stock Claude Code)", () => {
  const { project, dir, sessionId } = mkSession();
  const result = runHook("pretool", dispatchInput({ project, sessionId, agentType: "cat-harness:critic", prompt: "Check the plan.", toolName: "Task" }));
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
  assert.equal(readPending(dir)["cat-harness:critic"].length, 1);
});

// ---------------------------------------------------------------------------
// Design-source router backstop: a pasted design/resource URL (Figma etc.) is
// surfaced as a router directive so it cannot be silently dropped, and the
// design-QA gate (fail-closed + MCP-install nudge) is honored. Additive: the
// directive line appears ONLY when a design URL is present.
// ---------------------------------------------------------------------------
function routerContext(prompt) {
  const home = mkTmpHome();
  const res = runHook("router", { cwd: process.cwd(), session_id: "designsid", prompt }, { CAT_HARNESS_HOME: home });
  assert.equal(res.status, 0);
  return JSON.parse(res.stdout).hookSpecificOutput.additionalContext;
}

test("design-source backstop: a Figma URL in the prompt emits a [design-source: …] directive", () => {
  const ctx = routerContext("이 피그마대로 만들어줘 https://www.figma.com/design/KYh54yDmwQDOV0qNvZ496b/App?node-id=936-20232");
  assert.ok(ctx.includes("design-source:"), "router must surface the design-source directive");
  assert.ok(ctx.includes("figma.com/design/KYh54yDmwQDOV0qNvZ496b"), "the actual URL must be echoed so it cannot be dropped");
  assert.ok(/FAILS CLOSED/.test(ctx) && /MCP/.test(ctx), "the directive must state the fail-closed + MCP-nudge policy");
});

test("design-source backstop: a normal prompt with no design URL emits NO design-source directive", () => {
  const ctx = routerContext("please refactor the billing module and add tests");
  assert.ok(!ctx.includes("design-source:"), "no design URL → no directive (additive, non-intrusive)");
});

test("design-source backstop: multiple design URLs are all surfaced (deduped, capped)", () => {
  const ctx = routerContext("compare https://www.figma.com/design/AAA/One and https://www.figma.com/design/BBB/Two");
  assert.ok(ctx.includes("figma.com/design/AAA") && ctx.includes("figma.com/design/BBB"), "both distinct design URLs must appear");
});

test("design-source backstop: a non-design Figma URL (e.g. /about) does NOT emit the directive (low false-positive)", () => {
  const ctx = routerContext("check out https://www.figma.com/about and the pricing page");
  assert.ok(!ctx.includes("design-source:"), "only real file/design/proto/board paths trigger the backstop, not marketing URLs");
});
