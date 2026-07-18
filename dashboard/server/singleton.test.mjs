import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  compareAndDeleteServerJson,
  isLocallyLive,
  isValidHealthToken,
  readServerJson,
  writeServerJson,
} from "./singleton.mjs";
import { serverJsonPath } from "./constants.mjs";

function mkTmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cat-harness-singleton-test-"));
}

test("singleton: writeServerJson then readServerJson round-trips the full record", () => {
  const home = mkTmpHome();
  const written = writeServerJson(home, { port: 9223, pid: 4242, token: "tok", bootNonce: "nonce-1", startedAt: "2026-01-01T00:00:00.000Z" });
  const read = readServerJson(home);
  assert.deepEqual(read, written);
  assert.equal(read.boot_nonce, "nonce-1");
});

test("singleton: readServerJson fails open to null on missing file", () => {
  const home = mkTmpHome();
  assert.equal(readServerJson(home), null);
});

test("singleton: readServerJson fails open to null on corrupt file", () => {
  const home = mkTmpHome();
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(serverJsonPath(home), "not json at all");
  assert.equal(readServerJson(home), null);
});

test("singleton: compare-and-delete SELF-MATCH unlinks server.json", () => {
  const home = mkTmpHome();
  writeServerJson(home, { port: 9223, pid: process.pid, token: "tok", bootNonce: "self-nonce", startedAt: "x" });
  const result = compareAndDeleteServerJson(home, { pid: process.pid, bootNonce: "self-nonce" });
  assert.equal(result.deleted, true);
  assert.equal(result.reason, "self_match");
  assert.equal(fs.existsSync(serverJsonPath(home)), false);
});

test("singleton: compare-and-delete FOREIGN pid/nonce SKIPS the unlink (never deletes a newer instance's file)", () => {
  const home = mkTmpHome();
  // Simulate a NEWER instance having already overwritten server.json.
  writeServerJson(home, { port: 9223, pid: 99999, token: "tok-new", bootNonce: "newer-nonce", startedAt: "x" });
  const oldInstanceResult = compareAndDeleteServerJson(home, { pid: process.pid, bootNonce: "stale-nonce-from-old-instance" });
  assert.equal(oldInstanceResult.deleted, false);
  assert.equal(oldInstanceResult.reason, "mismatch");
  // The newer instance's file must survive untouched.
  const stillThere = readServerJson(home);
  assert.equal(stillThere.pid, 99999);
  assert.equal(stillThere.boot_nonce, "newer-nonce");
});

test("singleton: compare-and-delete MISSING file no-ops cleanly", () => {
  const home = mkTmpHome();
  const result = compareAndDeleteServerJson(home, { pid: process.pid, bootNonce: "whatever" });
  assert.equal(result.deleted, false);
  assert.equal(result.reason, "missing");
});

test("singleton: compare-and-delete pid-only match (nonce differs) is still a mismatch, not a self-match", () => {
  const home = mkTmpHome();
  writeServerJson(home, { port: 9223, pid: process.pid, token: "tok", bootNonce: "nonce-A", startedAt: "x" });
  const result = compareAndDeleteServerJson(home, { pid: process.pid, bootNonce: "nonce-B" });
  assert.equal(result.deleted, false);
  assert.equal(result.reason, "mismatch");
});

test("singleton: health-token probe accepts the exact token and rejects anything else", () => {
  const record = { token: "correct-token" };
  assert.equal(isValidHealthToken(record, "correct-token"), true);
  assert.equal(isValidHealthToken(record, "wrong-token"), false);
  assert.equal(isValidHealthToken(record, ""), false);
  assert.equal(isValidHealthToken(record, undefined), false);
  assert.equal(isValidHealthToken(null, "correct-token"), false);
});

test("singleton: isLocallyLive is false when server.json is missing", () => {
  const home = mkTmpHome();
  assert.equal(isLocallyLive(home), false);
});

test("singleton: isLocallyLive is false when boot_nonce is missing/malformed (architect finding A3 hardening)", () => {
  const home = mkTmpHome();
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(serverJsonPath(home), JSON.stringify({ port: 9223, pid: process.pid, token: "t" }));
  assert.equal(isLocallyLive(home), false, "missing boot_nonce must not read as live");
});

test("singleton: isLocallyLive is false when the pid is dead (even with a well-formed boot_nonce)", () => {
  const home = mkTmpHome();
  // A pid essentially guaranteed not to be alive in this test's pid namespace.
  const deadPid = 999999;
  writeServerJson(home, { port: 9223, pid: deadPid, token: "t", bootNonce: "some-nonce", startedAt: "x" });
  assert.equal(isLocallyLive(home), false);
});

test("singleton: isLocallyLive is true for our own live pid plus a well-formed boot_nonce", () => {
  const home = mkTmpHome();
  writeServerJson(home, { port: 9223, pid: process.pid, token: "t", bootNonce: "well-formed-nonce", startedAt: "x" });
  assert.equal(isLocallyLive(home), true);
});
