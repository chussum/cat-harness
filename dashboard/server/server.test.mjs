/**
 * dashboard/server/server.test.mjs — integration tests for the wired-up status
 * server (server.mjs): F16 no-fallback, singleton write-after-listen +
 * compare-and-delete idle shutdown, mid-run project registration without a
 * restart, and SSE full-snapshot-then-delta.
 *
 * Every server instance here binds to an OS-assigned ephemeral port
 * (`port: 0`) against an isolated tmp CAT_HARNESS_HOME, so these tests never
 * touch the real ~/.cat-harness or the real fixed port 9223, and can run
 * fully in parallel with any real running instance.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createServer, isLoopbackAddress } from "./server.mjs";
import { readServerJson } from "./singleton.mjs";
import { upsertRegistryRoot, readRegistry } from "./registry.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, "__fixtures__");

function mkTmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cat-harness-server-test-"));
}

/** Copies a static fixture project into a fresh tmp root so tests can mutate it freely. */
function copyFixtureProject(name, intoDir) {
  const dest = path.join(intoDir, name);
  fs.cpSync(path.join(FIXTURES, name), dest, { recursive: true });
  return dest;
}

function httpGetJson(url, headers = {}) {
  return new Promise((resolve, reject) => {
    http
      .get(url, { headers }, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          try {
            resolve({ status: res.statusCode, body: JSON.parse(raw) });
          } catch (err) {
            reject(new Error(`non-JSON response (${res.statusCode}): ${raw.slice(0, 200)}`));
          }
        });
      })
      .on("error", reject);
  });
}

/** POSTs a raw string body (already-serialized JSON or deliberately malformed) and parses the JSON response. */
function httpPostRaw(url, rawBody) {
  return new Promise((resolve, reject) => {
    const { hostname, port, pathname, search } = new URL(url);
    const req = http.request(
      { hostname, port, path: pathname + search, method: "POST", headers: { "Content-Type": "application/json" } },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          try {
            resolve({ status: res.statusCode, body: JSON.parse(raw) });
          } catch (err) {
            reject(new Error(`non-JSON response (${res.statusCode}): ${raw.slice(0, 200)}`));
          }
        });
      },
    );
    req.on("error", reject);
    req.end(rawBody);
  });
}

function httpPostJson(url, body) {
  return httpPostRaw(url, JSON.stringify(body));
}

/** A minimal SSE client: parses `event:`/`data:` blocks and buffers them for assertions. */
function connectSse(url) {
  return new Promise((resolve, reject) => {
    const events = [];
    let buffer = "";
    const req = http.get(url, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`SSE connect failed with status ${res.statusCode}`));
        return;
      }
      res.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        let idx;
        while ((idx = buffer.indexOf("\n\n")) !== -1) {
          const block = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const eventMatch = block.match(/^event: (.+)$/m);
          const dataMatch = block.match(/^data: (.+)$/m);
          if (eventMatch && dataMatch) {
            events.push({ event: eventMatch[1], data: JSON.parse(dataMatch[1]) });
          }
        }
      });
      resolve({
        events,
        close: () => req.destroy(),
        async waitFor(predicate, timeoutMs = 4000) {
          const start = Date.now();
          while (Date.now() - start < timeoutMs) {
            const found = events.find(predicate);
            if (found) return found;
            await delay(20);
          }
          throw new Error(`timed out waiting for SSE event matching predicate; got ${JSON.stringify(events)}`);
        },
      });
    });
    req.on("error", reject);
  });
}

test("server: F16 — no port fallback; a taken port makes start() reject and server.json is never written", async () => {
  const homeDir = mkTmpHome();
  const occupied = net.createServer();
  await new Promise((resolve) => occupied.listen(0, "127.0.0.1", resolve));
  const takenPort = occupied.address().port;

  const server = createServer({ homeDir, port: takenPort, idleMs: 0 });
  try {
    await assert.rejects(() => server.start(), /EADDRINUSE/);
    assert.equal(readServerJson(homeDir), null, "server.json must never be written on a failed listen()");
  } finally {
    await server.shutdown("test-cleanup"); // closes the watcher even though listen() never succeeded
    occupied.close();
  }
});

test("server: full lifecycle — server.json written only after listen, health endpoint validates the token, shutdown compare-and-deletes", async () => {
  const homeDir = mkTmpHome();
  const server = createServer({ homeDir, port: 0, idleMs: 0 });

  assert.equal(readServerJson(homeDir), null, "must not exist before start()");
  const info = await server.start();
  assert.equal(typeof info.port, "number");
  assert.ok(info.port > 0);

  const onDisk = readServerJson(homeDir);
  assert.ok(onDisk, "server.json must exist immediately after a successful listen()");
  assert.equal(onDisk.pid, process.pid);
  assert.equal(onDisk.boot_nonce, server.bootNonce);
  assert.equal(onDisk.port, server.port);

  const base = `http://127.0.0.1:${server.port}`;
  const good = await httpGetJson(`${base}/healthz?token=${encodeURIComponent(server.token)}`);
  assert.equal(good.status, 200);
  assert.equal(good.body.ok, true);
  assert.equal(good.body.pid, process.pid);

  const bad = await httpGetJson(`${base}/healthz?token=wrong-token`);
  assert.equal(bad.status, 401);
  assert.equal(bad.body.ok, false);

  const result = await server.shutdown("test");
  assert.equal(result.deleted, true);
  assert.equal(result.reason, "self_match");
  assert.equal(readServerJson(homeDir), null, "compare-and-delete must remove server.json on a clean self-match shutdown");
  assert.equal(server.httpServer.listening, false);
});

test("server: SSE sends a full snapshot on connect, then a delta on a real state mutation", async () => {
  const homeDir = mkTmpHome();
  const rootA = copyFixtureProject("dormant-project", homeDir);
  const rootB = copyFixtureProject("active-project", homeDir);
  upsertRegistryRoot(homeDir, rootA);
  upsertRegistryRoot(homeDir, rootB);

  const server = createServer({ homeDir, port: 0, idleMs: 0 });
  await server.start();
  try {
    const sse = await connectSse(`http://127.0.0.1:${server.port}/api/stream`);
    try {
      const initial = await sse.waitFor((e) => e.event === "snapshot");
      assert.equal(initial.data.projects.length, 2, "initial SSE payload must be a FULL snapshot of both registered roots");
      const initialA = initial.data.projects.find((p) => p.root === rootA);
      assert.equal(initialA.lit, false);

      // Mutate rootA's dormant session to active/executing — simulates a real goal checkpoint.
      const stateFile = path.join(rootA, ".cat", "_session-11111111-1111-1111-1111-111111111111", "state", "ultragoal-state.json");
      const before = JSON.parse(fs.readFileSync(stateFile, "utf8"));
      fs.writeFileSync(
        stateFile,
        JSON.stringify({ ...before, active: true, current_phase: "executing", updated_at: new Date().toISOString() }),
      );

      const delta = await sse.waitFor((e) => e.event === "delta" && e.data.root === rootA);
      assert.equal(delta.data.lit, true, "delta for the mutated project must reflect the new lit state");
    } finally {
      sse.close();
    }
  } finally {
    await server.shutdown("test");
  }
});

test("server: registering a NEW project mid-run adds its floor via the registry watch — no restart, no SSE reconnect required", async () => {
  const homeDir = mkTmpHome();
  const rootA = copyFixtureProject("dormant-project", homeDir);
  const rootB = copyFixtureProject("active-project", homeDir);
  upsertRegistryRoot(homeDir, rootA);
  upsertRegistryRoot(homeDir, rootB);

  const server = createServer({ homeDir, port: 0, idleMs: 0 });
  await server.start();
  try {
    const sse = await connectSse(`http://127.0.0.1:${server.port}/api/stream`);
    try {
      const initial = await sse.waitFor((e) => e.event === "snapshot");
      assert.equal(initial.data.projects.length, 2);

      // Register a THIRD project mid-run, without restarting the server.
      const rootC = copyFixtureProject("multi-session-project", homeDir);
      upsertRegistryRoot(homeDir, rootC);

      const delta = await sse.waitFor((e) => e.event === "delta" && e.data.root === rootC);
      assert.equal(delta.data.sessions.length, 2, "the newly-registered project's own sessions must be present");

      // Independently confirm via a fresh (non-SSE) snapshot fetch too.
      const fresh = await httpGetJson(`http://127.0.0.1:${server.port}/api/snapshot`);
      assert.equal(fresh.body.projects.length, 3);
      assert.ok(fresh.body.projects.some((p) => p.root === rootC));
    } finally {
      sse.close();
    }
  } finally {
    await server.shutdown("test");
  }
});

test("server: idle shutdown (tiny injected timeout) removes the discovery file via compare-and-delete", async () => {
  const homeDir = mkTmpHome();
  const server = createServer({ homeDir, port: 0, idleMs: 80 });
  await server.start();
  assert.ok(readServerJson(homeDir), "server.json must exist right after start()");

  await delay(80 + 400);

  assert.equal(readServerJson(homeDir), null, "idle timeout must trigger a compare-and-delete shutdown");
  assert.equal(server.httpServer.listening, false);
});

test("isLoopbackAddress: recognizes the loopback forms Node can report, rejects everything else", () => {
  assert.equal(isLoopbackAddress("127.0.0.1"), true);
  assert.equal(isLoopbackAddress("::1"), true);
  assert.equal(isLoopbackAddress("::ffff:127.0.0.1"), true);
  assert.equal(isLoopbackAddress("10.0.0.5"), false);
  assert.equal(isLoopbackAddress("203.0.113.5"), false);
  assert.equal(isLoopbackAddress(undefined), false);
  assert.equal(isLoopbackAddress(""), false);
});

test("server: POST /api/unregister removes the root from registry.json (atomic) and the fresh snapshot no longer lists it", async () => {
  const homeDir = mkTmpHome();
  const rootA = copyFixtureProject("dormant-project", homeDir);
  const rootB = copyFixtureProject("active-project", homeDir);
  upsertRegistryRoot(homeDir, rootA);
  upsertRegistryRoot(homeDir, rootB);

  const server = createServer({ homeDir, port: 0, idleMs: 0 });
  await server.start();
  try {
    const res = await httpPostJson(`http://127.0.0.1:${server.port}/api/unregister`, { root: rootA });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(
      res.body.snapshot.projects.some((p) => p.root === rootA),
      false,
      "the response's own snapshot must already reflect the removal",
    );

    const onDisk = readRegistry(homeDir);
    assert.deepEqual(onDisk.roots, [rootB], "registry.json on disk must no longer contain the unregistered root");

    const fresh = await httpGetJson(`http://127.0.0.1:${server.port}/api/snapshot`);
    assert.equal(fresh.body.projects.some((p) => p.root === rootA), false);
    assert.ok(fresh.body.projects.some((p) => p.root === rootB), "the untouched root must remain");
  } finally {
    await server.shutdown("test");
  }
});

test("server: POST /api/unregister broadcasts a `removed` SSE event to already-connected clients — no reconnect needed", async () => {
  const homeDir = mkTmpHome();
  const rootA = copyFixtureProject("dormant-project", homeDir);
  upsertRegistryRoot(homeDir, rootA);

  const server = createServer({ homeDir, port: 0, idleMs: 0 });
  await server.start();
  try {
    const sse = await connectSse(`http://127.0.0.1:${server.port}/api/stream`);
    try {
      const initial = await sse.waitFor((e) => e.event === "snapshot");
      assert.ok(initial.data.projects.some((p) => p.root === rootA));

      await httpPostJson(`http://127.0.0.1:${server.port}/api/unregister`, { root: rootA });

      const removed = await sse.waitFor((e) => e.event === "removed");
      assert.equal(removed.data.root, rootA);
    } finally {
      sse.close();
    }
  } finally {
    await server.shutdown("test");
  }
});

test("server: POST /api/unregister for a root that was never registered is a no-op success", async () => {
  const homeDir = mkTmpHome();
  const rootA = copyFixtureProject("dormant-project", homeDir);
  upsertRegistryRoot(homeDir, rootA);

  const server = createServer({ homeDir, port: 0, idleMs: 0 });
  await server.start();
  try {
    const res = await httpPostJson(`http://127.0.0.1:${server.port}/api/unregister`, { root: "/never/registered" });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.deepEqual(readRegistry(homeDir).roots, [rootA], "the unrelated existing root must be untouched");
  } finally {
    await server.shutdown("test");
  }
});

test("server: POST /api/unregister rejects a malformed body with 400 and never crashes the server", async () => {
  const homeDir = mkTmpHome();
  const rootA = copyFixtureProject("dormant-project", homeDir);
  upsertRegistryRoot(homeDir, rootA);

  const server = createServer({ homeDir, port: 0, idleMs: 0 });
  await server.start();
  try {
    const notJson = await httpPostRaw(`http://127.0.0.1:${server.port}/api/unregister`, "{ not json");
    assert.equal(notJson.status, 400);
    assert.equal(notJson.body.ok, false);

    const missingRootField = await httpPostJson(`http://127.0.0.1:${server.port}/api/unregister`, { nope: true });
    assert.equal(missingRootField.status, 400);

    const wrongType = await httpPostJson(`http://127.0.0.1:${server.port}/api/unregister`, { root: 42 });
    assert.equal(wrongType.status, 400);

    // The server must still be alive and answering after all that malformed input.
    assert.deepEqual(readRegistry(homeDir).roots, [rootA]);
    const health = await httpGetJson(`http://127.0.0.1:${server.port}/healthz?token=${encodeURIComponent(server.token)}`);
    assert.equal(health.status, 200);
  } finally {
    await server.shutdown("test");
  }
});

test("server: POST /api/unregister rejects a non-loopback remoteAddress with 403 and never mutates the registry", async () => {
  const homeDir = mkTmpHome();
  const rootA = copyFixtureProject("dormant-project", homeDir);
  upsertRegistryRoot(homeDir, rootA);

  const server = createServer({ homeDir, port: 0, idleMs: 0 });
  await server.start();
  try {
    // Spoof the connecting socket's reported remoteAddress to a non-loopback
    // address BEFORE the request lands, to exercise the guard's rejection
    // path — the server itself still only ever actually binds/accepts on
    // 127.0.0.1 in real deployments; this only fakes what the socket reports.
    server.httpServer.once("connection", (socket) => {
      Object.defineProperty(socket, "remoteAddress", { value: "203.0.113.5", configurable: true });
    });

    const res = await httpPostJson(`http://127.0.0.1:${server.port}/api/unregister`, { root: rootA });
    assert.equal(res.status, 403);
    assert.equal(res.body.ok, false);
    assert.deepEqual(readRegistry(homeDir).roots, [rootA], "a rejected non-loopback request must never mutate the registry");
  } finally {
    await server.shutdown("test");
  }
});
