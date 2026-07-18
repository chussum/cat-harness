/**
 * dashboard/server/launcher.test.mjs — the detached launcher's health-probe
 * decision logic (G003): healthy discovery file → no second server; missing
 * or unhealthy discovery file → starts one; EADDRINUSE against a foreign
 * process → structured log, clean exit, no fallback, no throw.
 *
 * Every server instance here binds to an OS-assigned ephemeral port (or a
 * throwaway `net.createServer` for the foreign-occupant case) against an
 * isolated tmp CAT_HARNESS_HOME, so these tests never touch the real
 * ~/.cat-harness or the real fixed port 9223.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ensureServer } from "./launcher.mjs";
import { readServerJson, writeServerJson } from "./singleton.mjs";
import { createServer } from "./server.mjs";

function mkTmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cat-harness-launcher-test-"));
}

function readLog(homeDir) {
  try {
    return fs
      .readFileSync(path.join(homeDir, "launcher.log"), "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(line => JSON.parse(line));
  } catch {
    return [];
  }
}

test("launcher: no discovery file at all — starts a fresh server", async () => {
  const homeDir = mkTmpHome();
  const result = await ensureServer({ homeDir, port: 0 });
  try {
    assert.equal(result.started, true);
    assert.equal(result.reason, "started");
    assert.ok(readServerJson(homeDir), "server.json must exist after a successful start");
    const log = readLog(homeDir);
    assert.ok(log.some(e => e.event === "started"));
  } finally {
    await result.server?.shutdown("test-cleanup");
  }
});

test("launcher: a REAL healthy server answering the health-token probe — does NOT start a second server", async () => {
  const homeDir = mkTmpHome();
  const live = createServer({ homeDir, port: 0, idleMs: 0 });
  await live.start();
  try {
    const result = await ensureServer({ homeDir, port: 0 });
    assert.equal(result.started, false);
    assert.equal(result.reason, "already_healthy");
    assert.equal(result.server, undefined, "must not have created a second server instance");
    const onDisk = readServerJson(homeDir);
    assert.equal(onDisk.pid, live.pid, "the ORIGINAL server's discovery file must be untouched");
    const log = readLog(homeDir);
    assert.ok(log.some(e => e.event === "already_healthy"));
  } finally {
    await live.shutdown("test-cleanup");
  }
});

test("launcher: mocked probe returns unhealthy (bad/no response) — starts a replacement server", async () => {
  const homeDir = mkTmpHome();
  // A stale discovery file pointing at a port nothing is actually listening on.
  writeServerJson(homeDir, { port: 5, pid: process.pid, token: "stale-token", bootNonce: "stale-nonce", startedAt: "x" });
  const badProbe = async () => ({ status: 0, body: null });

  const result = await ensureServer({ homeDir, port: 0, probe: badProbe });
  try {
    assert.equal(result.started, true);
    assert.equal(result.reason, "started");
    const onDisk = readServerJson(homeDir);
    assert.equal(onDisk.pid, process.pid, "the NEW server's own record must have replaced the stale one");
    const log = readLog(homeDir);
    assert.ok(log.some(e => e.event === "stale_discovery_file"));
    assert.ok(log.some(e => e.event === "started"));
  } finally {
    await result.server?.shutdown("test-cleanup");
  }
});

test("launcher: mocked probe throws — treated as unhealthy, still starts a replacement (never crashes)", async () => {
  const homeDir = mkTmpHome();
  writeServerJson(homeDir, { port: 5, pid: process.pid, token: "stale-token", bootNonce: "stale-nonce", startedAt: "x" });
  const throwingProbe = async () => {
    throw new Error("simulated network error");
  };

  const result = await ensureServer({ homeDir, port: 0, probe: throwingProbe });
  try {
    assert.equal(result.started, true);
  } finally {
    await result.server?.shutdown("test-cleanup");
  }
});

test("launcher: EADDRINUSE against a FOREIGN (non-cat-harness) process — structured log, clean exit, no fallback, no throw", async () => {
  const homeDir = mkTmpHome();
  const foreign = net.createServer();
  await new Promise(resolve => foreign.listen(0, "127.0.0.1", resolve));
  const foreignPort = foreign.address().port;

  try {
    // No discovery file at all → ensureServer skips the probe and attempts a
    // direct start() against the foreign-occupied port.
    const result = await ensureServer({ homeDir, port: foreignPort });
    assert.equal(result.started, false);
    assert.equal(result.reason, "bind_failed");
    assert.equal(result.error, "EADDRINUSE");
    assert.equal(readServerJson(homeDir), null, "a failed bind must never write server.json");
    const log = readLog(homeDir);
    const entry = log.find(e => e.event === "bind_failed_foreign_port_owner");
    assert.ok(entry, "must log a STRUCTURED failure for the foreign-port-owner case");
    assert.equal(entry.port, foreignPort);
  } finally {
    foreign.close();
  }
});

test("launcher: bind failure of any kind never throws past ensureServer's own boundary", async () => {
  const homeDir = mkTmpHome();
  const foreign = net.createServer();
  await new Promise(resolve => foreign.listen(0, "127.0.0.1", resolve));
  const foreignPort = foreign.address().port;
  try {
    await assert.doesNotReject(() => ensureServer({ homeDir, port: foreignPort }));
  } finally {
    foreign.close();
  }
});
