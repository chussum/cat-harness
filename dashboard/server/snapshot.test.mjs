import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { buildProjectSnapshot, buildSnapshot, SCHEMA_VERSION } from "./snapshot.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, "__fixtures__");
const DORMANT = path.join(FIXTURES, "dormant-project");
const ACTIVE = path.join(FIXTURES, "active-project");
const MULTI = path.join(FIXTURES, "multi-session-project");
const NONEXISTENT = path.join(FIXTURES, "does-not-exist-project");

test("snapshot: dormant project (all sessions terminal) is not lit", () => {
  const snap = buildProjectSnapshot(DORMANT);
  assert.equal(snap.root, DORMANT);
  assert.equal(snap.lit, false);
  assert.equal(snap.sessions.length, 1);
  const [session] = snap.sessions;
  assert.equal(session.sessionId, "11111111-1111-1111-1111-111111111111");
  assert.equal(session.lit, false);
  assert.equal(session.skills.ultragoal.active, false);
  assert.equal(session.skills.ultragoal.current_phase, "complete");
  assert.deepEqual(session.goals.goals.map((g) => g.id), ["G001"]);
  assert.equal(session.ledgerTail.length, 1);
});

test("snapshot: active project (one non-terminal session) is lit, starred fields + hud + ambiguity present", () => {
  const snap = buildProjectSnapshot(ACTIVE);
  assert.equal(snap.lit, true);
  const [session] = snap.sessions;
  assert.equal(session.lit, true);

  const ug = session.skills.ultragoal;
  assert.equal(ug.skill, "ultragoal");
  assert.equal(ug.active, true);
  assert.equal(ug.current_phase, "executing");
  assert.equal(ug.updated_at, "2026-01-02T00:00:00.000Z");
  assert.equal(ug.hud.nextAction, "executing G002");

  const di = session.skills["deep-interview"];
  assert.equal(di.active, false);
  assert.equal(di.current_ambiguity, 0.02);
  assert.equal(di.reported_ambiguity, 0.02);
  assert.equal(di.ambiguity_floor, 0);
  assert.equal(di.threshold, 0.05);
  assert.equal(di.threshold_source, "default");

  assert.equal(session.hasSpecs, true);
  assert.deepEqual(session.specs, ["deep-interview-example.md"]);
  assert.equal(session.hasPlans, true);
  assert.deepEqual(session.plans.ralplan, ["2026-01-01-0000-aaaa"]);

  // G005: dialogue excerpts tailed from state/dialogue-excerpts.jsonl, verbatim shape.
  assert.equal(session.dialogue.length, 2);
  const [dispatch, reply] = session.dialogue;
  assert.equal(dispatch.round_trip_id, "cccccccc-0000-0000-0000-000000000001");
  assert.equal(dispatch.role, "dispatch");
  assert.equal(dispatch.agent_type, "cat-harness:executor");
  assert.equal(dispatch.paired, true);
  assert.equal(reply.round_trip_id, dispatch.round_trip_id);
  assert.equal(reply.role, "reply");
  assert.equal(typeof reply.excerpt, "string");
});

test("snapshot: dialogue is fail-open (no dialogue-excerpts.jsonl on disk -> [])", () => {
  const snap = buildProjectSnapshot(DORMANT);
  const [session] = snap.sessions;
  assert.deepEqual(session.dialogue, []);
});

test("snapshot: multi-session project — lit iff ANY session is non-terminal/active", () => {
  const snap = buildProjectSnapshot(MULTI);
  assert.equal(snap.sessions.length, 2);
  assert.equal(snap.lit, true, "one running team session should make the whole project lit");
  const bySession = Object.fromEntries(snap.sessions.map((s) => [s.sessionId, s]));
  assert.equal(bySession["33333333-3333-3333-3333-333333333333"].lit, false);
  assert.equal(bySession["44444444-4444-4444-4444-444444444444"].lit, true);
});

test("snapshot: a root with no .cat tree yet is self-healing (empty, dormant, never throws)", () => {
  const snap = buildProjectSnapshot(NONEXISTENT);
  assert.equal(snap.root, NONEXISTENT);
  assert.equal(snap.lit, false);
  assert.deepEqual(snap.sessions, []);
});

test("snapshot: buildSnapshot aggregates multiple projects with a schemaVersion and generatedAt", () => {
  const snap = buildSnapshot([DORMANT, ACTIVE, MULTI]);
  assert.equal(snap.schemaVersion, SCHEMA_VERSION);
  assert.equal(typeof snap.generatedAt, "string");
  assert.equal(snap.projects.length, 3);
  assert.deepEqual(
    snap.projects.map((p) => p.lit),
    [false, true, true],
  );
  // MCP-friendly: no functions, JSON round-trips exactly.
  const roundTripped = JSON.parse(JSON.stringify(snap));
  assert.deepEqual(roundTripped, snap);
});
