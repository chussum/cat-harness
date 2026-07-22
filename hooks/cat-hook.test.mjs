/**
 * hooks/cat-hook.test.mjs — regression coverage for hooks/cat-hook.mjs.
 * cat-hook.mjs's main() calls process.exit(0) directly, so every case here
 * spawns it as a real child process (matching its actual invocation contract:
 * JSON on stdin, JSON on stdout, exit 0) rather than importing its functions
 * in-process.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOOK_PATH = path.join(HERE, "cat-hook.mjs");

function mkTmpProject({ withCat = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cat-harness-hook-project-"));
  if (withCat) fs.mkdirSync(path.join(dir, ".cat"), { recursive: true });
  return dir;
}

/** Runs cat-hook.mjs as a real child process — its actual invocation contract. */
function runHook(mode, input, envOverrides = {}) {
  const result = spawnSync(process.execPath, [HOOK_PATH, mode], {
    input: JSON.stringify(input),
    env: { ...process.env, ...envOverrides },
    encoding: "utf8",
    timeout: 10000,
  });
  return result;
}

test("regression: pretool mutation-guard (Write to .cat/state) is unaffected by env overrides", () => {
  const projectWithCat = mkTmpProject({ withCat: true });
  const sessionDir = path.join(projectWithCat, ".cat", "_session-testsid");
  fs.mkdirSync(sessionDir, { recursive: true });
  const input = {
    cwd: projectWithCat,
    session_id: "testsid",
    tool_name: "Write",
    tool_input: { file_path: ".cat/_session-testsid/state/foo.json" },
  };
  const result = runHook("pretool", input);
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

// Regression: the phase-boundary Bash guard must NOT misread `>=` (the comparison
// operator, e.g. "Node >= 22" in prose) as an output redirect, and must NOT scan
// heredoc BODY prose (markdown blockquotes `> …`, `>=`, `-> `) as shell commands —
// those bodies are literal data of legitimate ralplan/ultragoal artifact writes and
// were being DENIED (cousin of the =>/-> arrow false-positive fixed earlier).
test("regression: `>=`/`<=` comparison operators are NOT misread as a redirect and NOT denied during a blocking ralplan phase", () => {
  const { project, sid } = seedBlockingRalplan();
  for (const command of [
    `echo "requires Node >= 22.13.0 or newer"`, // >= comparison operator
    `echo "cap is <= 5 and full >= lite"`, // <= and >= mid-sentence
  ]) {
    const result = bashPretool(project, sid, command);
    assert.equal(result.status, 0, `hook must exit 0 for: ${JSON.stringify(command)}`);
    assert.equal(
      result.stdout.trim(),
      "",
      `>=-only command must NOT be denied (no permissionDecision) for: ${JSON.stringify(command)}`,
    );
  }
});

test("regression: prose (blockquotes, `>=`, arrows) in a quoted heredoc BODY is NOT misread as a mutation and NOT denied during a blocking ralplan phase", () => {
  const { project, sid } = seedBlockingRalplan();
  // A heredoc body full of exactly the tokens that used to trip the guard.
  const command = [
    `cat <<'DOC'`,
    `Requires Node >= 22.13.0 or newer.`,
    `> a markdown blockquote line`,
    `>   an indented blockquote`,
    `flow: planner -> critic -> consensus and a=>b`,
    `quality > quantity when A > B`,
    `DOC`,
  ].join("\n");
  const result = bashPretool(project, sid, command);
  assert.equal(result.status, 0, `hook must exit 0 for a prose heredoc body`);
  assert.equal(
    result.stdout.trim(),
    "",
    `a quoted heredoc whose body is markdown prose must NOT be denied: ${JSON.stringify(command)}`,
  );
});

test("regression: a real truncate redirect after a `;` separator is STILL denied during a blocking ralplan phase", () => {
  const { project, sid } = seedBlockingRalplan();
  const outside = path.join(os.tmpdir(), "cat-hook-truncate-regression.txt");
  const result = bashPretool(project, sid, `echo hi ; > ${outside}`);
  assert.equal(result.status, 0);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.hookSpecificOutput.permissionDecision, "deny", "a real `; > file` truncate must still be caught as a mutation");
});

test("regression: a REAL redirect on a heredoc OPENER line is STILL denied during a blocking ralplan phase", () => {
  const { project, sid } = seedBlockingRalplan();
  const outside = path.join(os.tmpdir(), "cat-hook-heredoc-opener-redirect.txt");
  const command = [`cat <<'DOC' > ${outside}`, `body line`, `DOC`].join("\n");
  const result = bashPretool(project, sid, command);
  assert.equal(result.status, 0);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.hookSpecificOutput.permissionDecision, "deny", "a redirect on the heredoc opener line must still be caught");
});

test("security: a `.cat/` state mutation inside a heredoc BODY is STILL denied even when idle (G1 protection is not weakened by heredoc stripping)", () => {
  const project = mkTmpProject({ withCat: true }); // no active workflow → idle
  const sid = "idlesid";
  const command = [`bash <<'RUN'`, `rm -rf .cat/_session-${sid}/state`, `RUN`].join("\n");
  const result = bashPretool(project, sid, command);
  assert.equal(result.status, 0);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.hookSpecificOutput.permissionDecision, "deny", "a `.cat/` mutation in a heredoc body must still be caught (G1, even when idle)");
});

test("regression: stop with no state dir is a silent no-op", () => {
  const projectWithCat = mkTmpProject({ withCat: true });
  const input = { cwd: projectWithCat, session_id: "testsid" };
  const result = runHook("stop", input);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
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
  const res = runHook("router", { cwd: process.cwd(), session_id: "designsid", prompt });
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

// ---------------------------------------------------------------------------
// Graph advisory (router-only, MAIN thread): reports whether .cat/graph/
// graph.db exists/is fresh, gated on the existing file-path/symbol signal
// detection. fs.statSync ONLY (no node:sqlite/sql.js import, no spawn), own
// isolated try/catch. No Node-version floor anymore — see
// hooks/cat-hook.mjs graphAdvisoryLine/buildRouterBlock.
// ---------------------------------------------------------------------------
function routerContextAt(cwd, prompt, envOverrides = {}) {
  const res = runHook("router", { cwd, session_id: "graphsid", prompt }, envOverrides);
  assert.equal(res.status, 0, `router must always exit 0 (fail-open): ${res.stderr}`);
  return JSON.parse(res.stdout).hookSpecificOutput.additionalContext;
}

/**
 * Locates a below-22.13.0 Node binary purely to PROVE the graph advisory's
 * old Node-version floor is gone (cat-state.mjs's `graph build`/`graph
 * query` moved off `node:sqlite` onto vendored sql.js, which needs only
 * Node's built-in WebAssembly — no floor at all, Node 18+ baseline). Skips
 * gracefully when none is found; this is a positive-availability nicety,
 * not load-bearing — the default-Node tests below already exercise the
 * floor-free code path directly.
 */
function findBelowFloorHookNode() {
  const candidates = [
    process.env.CAT_HOOK_TEST_OLD_NODE,
    path.join(os.homedir(), ".nvm", "versions", "node", "v22.12.0", "bin", "node"),
    path.join(os.homedir(), ".nvm", "versions", "node", "v18.19.1", "bin", "node"),
  ].filter(Boolean);
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  const parts = process.version.replace(/^v/, "").split(".").map(n => parseInt(n, 10) || 0);
  const atLeastOldFloor = parts[0] > 22 || (parts[0] === 22 && parts[1] >= 13);
  return atLeastOldFloor ? null : process.execPath;
}

function runHookOnNode(nodeBin, mode, input, envOverrides = {}) {
  return spawnSync(nodeBin, [HOOK_PATH, mode], {
    input: JSON.stringify(input),
    env: { ...process.env, ...envOverrides },
    encoding: "utf8",
    timeout: 10000,
  });
}

const belowFloorHookNode = findBelowFloorHookNode();
const BELOW_FLOOR_SKIP = belowFloorHookNode
  ? false
  : "no below-22.13.0 Node runtime found — set CAT_HOOK_TEST_OLD_NODE to exercise the floor-removal proof";

test("graph advisory: signal-gated — appears only when the prompt carries a file-path/symbol signal", () => {
  const project = mkTmpProject();
  const withFilePath = routerContextAt(project, "please refactor src/foo.ts");
  const withSymbol = routerContextAt(project, "why does getUserProfile behave like that");
  const withoutSignal = routerContextAt(project, "what do you think about testing in general");
  assert.match(withFilePath, /\[graph: /, "a file-path signal must trigger the graph advisory line");
  assert.match(withSymbol, /\[graph: /, "a symbol signal must trigger the graph advisory line");
  assert.ok(!/\[graph: /.test(withoutSignal), "no code-shaped signal -> no graph advisory line");
});

test(
  "graph advisory: Node floor removed — a below-22.13.0 Node reports the SAME statSync-based wording as any other Node, never the old floor message",
  { skip: BELOW_FLOOR_SKIP },
  () => {
    const project = mkTmpProject(); // no .cat/graph at all
    const res = runHookOnNode(belowFloorHookNode, "router", { cwd: project, session_id: "graphsid", prompt: "refactor src/foo.ts" });
    assert.equal(res.status, 0, res.stderr);
    const ctx = JSON.parse(res.stdout).hookSpecificOutput.additionalContext;
    assert.ok(!/needs Node/.test(ctx), `floor wording must be gone entirely, got: ${ctx}`);
    assert.match(
      ctx,
      /\[graph: not built yet — cat-harness:deep-interview\/ralplan\/ultragoal\/team auto-refresh it at workflow start; Read\/Grep until then\]/,
    );
  },
);

test("graph advisory: absent .cat/graph/graph.db reports the 'not built yet' wording", () => {
  const project = mkTmpProject();
  const res = runHook("router", { cwd: project, session_id: "graphsid", prompt: "refactor src/foo.ts" });
  assert.equal(res.status, 0, res.stderr);
  const ctx = JSON.parse(res.stdout).hookSpecificOutput.additionalContext;
  assert.match(
    ctx,
    /\[graph: not built yet — cat-harness:deep-interview\/ralplan\/ultragoal\/team auto-refresh it at workflow start; Read\/Grep until then\]/,
  );
});

test("graph advisory: a fresh .cat/graph/graph.db reports the 'last built {age} ago' wording", () => {
  const project = mkTmpProject();
  const graphDir = path.join(project, ".cat", "graph");
  fs.mkdirSync(graphDir, { recursive: true });
  fs.writeFileSync(path.join(graphDir, "graph.db"), "not-a-real-sqlite-file"); // statSync only — content never opened
  const res = runHook("router", { cwd: project, session_id: "graphsid", prompt: "refactor src/foo.ts" });
  assert.equal(res.status, 0, res.stderr);
  const ctx = JSON.parse(res.stdout).hookSpecificOutput.additionalContext;
  assert.match(ctx, /\[graph: last built \d+s ago \(\.cat\/graph\/graph\.db\) — HINT only, verify with Read\/Grep\]/);
});

test("graph advisory: an older .cat/graph/graph.db reports a coarser age unit (days)", () => {
  const project = mkTmpProject();
  const graphDir = path.join(project, ".cat", "graph");
  fs.mkdirSync(graphDir, { recursive: true });
  const dbFile = path.join(graphDir, "graph.db");
  fs.writeFileSync(dbFile, "not-a-real-sqlite-file");
  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
  fs.utimesSync(dbFile, twoDaysAgo, twoDaysAgo);
  const res = runHook("router", { cwd: project, session_id: "graphsid", prompt: "refactor src/foo.ts" });
  assert.equal(res.status, 0, res.stderr);
  const ctx = JSON.parse(res.stdout).hookSpecificOutput.additionalContext;
  assert.match(ctx, /\[graph: last built 2d ago \(\.cat\/graph\/graph\.db\) — HINT only, verify with Read\/Grep\]/);
});

test(
  "graph advisory: an inaccessible .cat/graph directory degrades by omitting only the graph line — rest of block intact, router never throws",
  { skip: process.platform === "win32" },
  () => {
    const project = mkTmpProject();
    const graphDir = path.join(project, ".cat", "graph");
    fs.mkdirSync(graphDir, { recursive: true });
    fs.writeFileSync(path.join(graphDir, "graph.db"), "not-a-real-sqlite-file");
    fs.chmodSync(graphDir, 0o000); // statSync on graph.db now fails (EACCES traversing graphDir)
    try {
      const res = runHook("router", { cwd: project, session_id: "graphsid", prompt: "refactor src/foo.ts" });
      assert.equal(res.status, 0, res.stderr);
      const parsed = JSON.parse(res.stdout);
      const ctx = parsed.hookSpecificOutput.additionalContext;
      assert.ok(!/\[graph: /.test(ctx), "an inaccessible graph.db must omit the advisory line, not crash the router");
      assert.match(ctx, /<cat-harness-router>/, "the rest of the router block must stay intact");
      assert.match(ctx, /<\/cat-harness-router>/);
    } finally {
      fs.chmodSync(graphDir, 0o755); // restore so tmp cleanup / re-runs are not blocked
    }
  },
);

test("graph advisory: byte budget — the router block (incl. graph line) never exceeds the 4096-byte trim bound", () => {
  const project = mkTmpProject();
  const graphDir = path.join(project, ".cat", "graph");
  fs.mkdirSync(graphDir, { recursive: true });
  fs.writeFileSync(path.join(graphDir, "graph.db"), "not-a-real-sqlite-file");
  const res = runHook("router", { cwd: project, session_id: "graphsid", prompt: "refactor src/foo.ts and also src/bar.ts" });
  assert.equal(res.status, 0, res.stderr);
  const ctx = JSON.parse(res.stdout).hookSpecificOutput.additionalContext;
  assert.ok(Buffer.byteLength(ctx, "utf8") <= 4096, `router block exceeded 4096 bytes: ${Buffer.byteLength(ctx, "utf8")}`);
});

test(
  "graph advisory: negligible added latency — repeated full router invocations with a graph-triggering prompt stay well under a generous ceiling; no node:sqlite import, no spawn observed",
  () => {
    // cat-hook.mjs is spawn-only by design (main() runs unconditionally at
    // module load and blocks on stdin — see file header docstring), so
    // there is no import-safe surface to microbenchmark the advisory
    // function in isolation. This measures the FULL child-process router
    // invocation (Node startup + module load + advisory computation) as a
    // proxy: a regression that opened node:sqlite or spawned a build would
    // blow well past this bound, while the advisory's own statSync-only
    // cost is negligible relative to Node process startup itself.
    const project = mkTmpProject();
    const N = 20;
    const durations = [];
    for (let i = 0; i < N; i++) {
      const start = Date.now();
      const res = runHook("router", { cwd: project, session_id: "latsid", prompt: "refactor src/foo.ts" });
      durations.push(Date.now() - start);
      assert.equal(res.status, 0);
    }
    durations.sort((a, b) => a - b);
    const p95 = durations[Math.floor(durations.length * 0.95)];
    assert.ok(p95 < 2000, `p95 full-process router latency ${p95}ms exceeded the 2000ms regression-guard bound`);
  },
);
