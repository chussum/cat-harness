/**
 * dashboard/server/server.mjs — the status server core: wires lifecycle
 * (singleton.mjs), registry, snapshot, watcher, and sse into one HTTP server.
 *
 * Disk is the SOLE source of truth: this module holds no authoritative state,
 * it rebuilds by rescanning on boot and on every fresh full-snapshot request
 * (F18-style guarantee — a fresh SSE connect is never served stale in-memory
 * state, even if a registry-watch event was somehow missed).
 *
 * F16: binds the fixed port with NO fallback — if listen() fails, the promise
 * returned by start() rejects and server.json is never written. F16 constants
 * come from constants.mjs; CAT_HARNESS_PORT is an explicit override, never an
 * automatic retry.
 *
 * The server is otherwise READ-ONLY, with exactly one narrow exception:
 * `POST /api/unregister` (loopback-only, see `isLoopbackAddress` below)
 * removes one root from the home registry — the real, server-side "폐업
 * 처리" (close/retire a dormant floor), symmetric with the hook's existing
 * registration write (`upsertRegistryRoot`). See DESIGN.md §10.
 */

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  generateBootNonce,
  generateToken,
  getHomeDir,
  getIdleMs,
  getPort,
} from "./constants.mjs";
import { pruneMissingRoots, readRegistry, reconcileWatchedRoots, removeRegistryRoot } from "./registry.mjs";
import { buildProjectSnapshot, buildSnapshot } from "./snapshot.mjs";
import { compareAndDeleteServerJson, isValidHealthToken, writeServerJson } from "./singleton.mjs";
import { createWatcher } from "./watcher.mjs";
import { createSseHub } from "./sse.mjs";

const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DIST_DIR = path.resolve(SERVER_DIR, "..", "app", "dist");

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(payload);
}

function tokenFromRequest(req, url) {
  const header = req.headers["x-cat-harness-token"];
  if (typeof header === "string" && header.length > 0) return header;
  return url.searchParams.get("token") ?? "";
}

/**
 * `POST /api/unregister` is the one MUTATING endpoint this server exposes
 * (DESIGN.md §10) — strict, defense-in-depth loopback check on top of the
 * server's own `listen(port, "127.0.0.1")` bind, since a bind-only boundary
 * is one config change away from being wrong for a mutation. Accepts the
 * three loopback forms Node's `net`/`http` stack can report for a local
 * connection (IPv4, IPv6 unmapped, IPv6-mapped-IPv4); anything else (or a
 * missing/unknown address) is rejected.
 */
export function isLoopbackAddress(address) {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

const MAX_UNREGISTER_BODY_BYTES = 64 * 1024;

/** Buffers a request body up to a small cap; rejects (never throws async) past it or on a stream error. */
function readRequestBody(req, maxBytes = MAX_UNREGISTER_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    let raw = "";
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error("body_too_large"));
        req.destroy();
        return;
      }
      raw += chunk;
    });
    req.on("end", () => resolve(raw));
    req.on("error", reject);
  });
}

function tryServeStatic(distDir, urlPath, res) {
  const relative = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
  const filePath = path.resolve(distDir, relative);
  // Refuse to serve outside distDir (defense in depth against path traversal).
  if (!filePath.startsWith(path.resolve(distDir) + path.sep) && filePath !== path.resolve(distDir)) {
    return false;
  }
  try {
    const data = fs.readFileSync(filePath);
    res.writeHead(200, { "Content-Type": guessContentType(filePath) });
    res.end(data);
    return true;
  } catch {
    return false;
  }
}

function guessContentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return (
    {
      ".html": "text/html; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".mjs": "text/javascript; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".json": "application/json; charset=utf-8",
      ".svg": "image/svg+xml",
      ".png": "image/png",
    }[ext] ?? "application/octet-stream"
  );
}

/**
 * Creates a status server instance. Pure factory — does not touch process
 * signal handlers or call listen(); callers (tests, or dashboard/server/index.mjs)
 * control the lifecycle explicitly via start()/shutdown().
 */
export function createServer(opts = {}) {
  const homeDir = opts.homeDir ?? getHomeDir(opts.env ?? process.env);
  const port = getPort(opts.env ?? process.env, opts.port);
  const idleMs = getIdleMs(opts.env ?? process.env, opts.idleMs);
  const distDir = opts.distDir ?? DEFAULT_DIST_DIR;

  const pid = process.pid;
  const bootNonce = generateBootNonce();
  const token = generateToken();
  // `port` above is the CONFIGURED/desired port (0 means "OS-assigned", used only by
  // tests to avoid colliding with a real running instance). `actualPort` is filled in
  // with the real bound port once listen() succeeds, and is what gets written to
  // server.json, returned from start(), and reported by the health endpoint.
  let actualPort = port;

  // Ghost-floor self-heal on boot: drop any registered root whose directory is
  // gone (deleted temp dir, moved repo) before the first snapshot, so a stale
  // registry never seeds an undismissable empty floor. No clients exist yet, so
  // this boot prune just needs the registry cleaned (no SSE announce).
  let registry = pruneMissingRoots(homeDir);
  let snapshot = buildSnapshot(registry.roots);
  const sse = createSseHub();

  let idleTimer = null;
  let httpServer = null;
  let startedAt = null;
  let shuttingDown = false;

  function resetIdleTimer() {
    if (idleTimer) clearTimeout(idleTimer);
    if (!(idleMs > 0)) return; // idleMs <= 0 disables auto-shutdown (test escape hatch only)
    idleTimer = setTimeout(() => {
      shutdown("idle").catch((err) => {
        console.error(`[dashboard/server] idle shutdown failed: ${err?.message ?? err}`);
      });
    }, idleMs);
    if (idleTimer.unref) idleTimer.unref();
  }

  function noteActivity() {
    resetIdleTimer();
  }

  function replaceProject(updated) {
    const idx = snapshot.projects.findIndex((p) => p.root === updated.root);
    const projects =
      idx >= 0
        ? snapshot.projects.map((p, i) => (i === idx ? updated : p))
        : [...snapshot.projects, updated];
    snapshot = { ...snapshot, projects, generatedAt: new Date().toISOString() };
  }

  function handleProjectChange(root) {
    const updated = buildProjectSnapshot(root);
    replaceProject(updated);
    sse.broadcastDelta(updated);
    noteActivity();
  }

  /**
   * Drops `root` from the live in-memory snapshot and, if it was actually
   * present, broadcasts a `removed` SSE event so every ALREADY-connected
   * client drops that floor immediately (sse.mjs's `broadcastRemoved`) —
   * without this, a registry removal only ever took effect for a client's
   * NEXT full reconnect, never for one already open (there was no removal
   * counterpart to `broadcastDelta` before /api/unregister needed one).
   * Shared by both the registry-watch reconciliation below and the
   * /api/unregister handler, so a root removed either way (this endpoint, or
   * any other process editing registry.json directly) is announced the same.
   */
  function applyRegistryRemoval(root) {
    const existed = snapshot.projects.some((p) => p.root === root);
    if (existed) {
      snapshot = {
        ...snapshot,
        projects: snapshot.projects.filter((p) => p.root !== root),
        generatedAt: new Date().toISOString(),
      };
      sse.broadcastRemoved(root);
    }
    return existed;
  }

  /**
   * Ghost-floor self-heal for the live server: prune registry roots whose dir is
   * gone, then drop each from the in-memory snapshot and announce it via the same
   * `removed` SSE event a real unregister uses — so a deleted project's floor
   * disappears for every open client without needing an explicit 폐업 click (which
   * would fail anyway if nothing catches it). Returns the pruned root list.
   */
  function pruneGhostFloors() {
    const { roots, removed } = pruneMissingRoots(homeDir);
    for (const root of removed) {
      applyRegistryRemoval(root);
    }
    return roots;
  }

  function handleRegistryChange() {
    registry = readRegistry(homeDir);
    pruneGhostFloors();
    registry = readRegistry(homeDir);
    const { added, removed } = reconcileWatchedRoots(registry, new Set(watcher.watchedRoots()));
    watcher.reconcile(registry.roots);
    for (const root of added) {
      const updated = buildProjectSnapshot(root);
      replaceProject(updated);
      sse.broadcastDelta(updated);
    }
    for (const root of removed) {
      applyRegistryRemoval(root);
    }
    noteActivity();
  }

  const watcher = createWatcher({
    homeDir,
    initialRoots: registry.roots,
    onProjectChange: handleProjectChange,
    onRegistryChange: handleRegistryChange,
  });

  /** F18-style guarantee: always rebuild fresh from a fresh registry read, never replayed state. */
  function freshSnapshot() {
    pruneGhostFloors();
    registry = readRegistry(homeDir);
    snapshot = buildSnapshot(registry.roots);
    watcher.reconcile(registry.roots);
    return snapshot;
  }

  function requestListener(req, res) {
    noteActivity();
    let url;
    try {
      url = new URL(req.url, "http://127.0.0.1");
    } catch {
      sendJson(res, 400, { ok: false, error: "bad_request" });
      return;
    }

    if (req.method === "GET" && url.pathname === "/healthz") {
      const provided = tokenFromRequest(req, url);
      if (!isValidHealthToken({ token }, provided)) {
        sendJson(res, 401, { ok: false });
        return;
      }
      sendJson(res, 200, { ok: true, pid, boot_nonce: bootNonce, started_at: startedAt, port: actualPort });
      return;
    }

    // /api/snapshot and /api/stream are intentionally UNAUTHENTICATED (unlike
    // /healthz, which requires the health token): this server binds to
    // 127.0.0.1 only (see httpServer.listen(port, "127.0.0.1") below), so the
    // loopback boundary is the actual access control for this read-only
    // dashboard data — the token exists to let the singleton launcher/hook
    // prove liveness, not to gate general API access.
    if (req.method === "GET" && url.pathname === "/api/snapshot") {
      sendJson(res, 200, freshSnapshot());
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/stream") {
      sse.addClient(res, freshSnapshot());
      req.on("close", noteActivity);
      return;
    }

    // The one mutating endpoint (DESIGN.md §10): removes a root from the home
    // registry — the real, server-side "폐업 처리" (close/retire a dormant
    // floor). Strict loopback guard on top of the bind-level boundary (this
    // handler mutates disk, unlike /api/snapshot|/api/stream above).
    if (req.method === "POST" && url.pathname === "/api/unregister") {
      if (!isLoopbackAddress(req.socket.remoteAddress)) {
        sendJson(res, 403, { ok: false, error: "forbidden" });
        return;
      }
      readRequestBody(req)
        .then((raw) => {
          let body;
          try {
            body = raw.trim().length > 0 ? JSON.parse(raw) : {};
          } catch {
            sendJson(res, 400, { ok: false, error: "bad_request" });
            return;
          }
          if (!body || typeof body !== "object" || typeof body.root !== "string" || body.root.trim().length === 0) {
            sendJson(res, 400, { ok: false, error: "bad_request" });
            return;
          }
          removeRegistryRoot(homeDir, body.root);
          registry = readRegistry(homeDir);
          applyRegistryRemoval(path.resolve(body.root));
          watcher.reconcile(registry.roots);
          noteActivity();
          sendJson(res, 200, { ok: true, snapshot });
        })
        .catch(() => {
          sendJson(res, 400, { ok: false, error: "bad_request" });
        });
      return;
    }

    if (req.method === "GET" && tryServeStatic(distDir, url.pathname, res)) {
      return;
    }

    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("cat-harness dashboard server is running. Dashboard UI not built yet (dashboard/app/dist missing).\n");
      return;
    }

    sendJson(res, 404, { ok: false, error: "not_found" });
  }

  httpServer = http.createServer(requestListener);

  /** Binds the fixed port. NO fallback on failure (F16): rejects, never retries another port. */
  function start() {
    return new Promise((resolve, reject) => {
      function onError(err) {
        httpServer.removeListener("listening", onListening);
        reject(err);
      }
      function onListening() {
        httpServer.removeListener("error", onError);
        startedAt = new Date().toISOString();
        actualPort = httpServer.address().port;
        // Written ONLY after a successful listen() call (architect finding A2).
        writeServerJson(homeDir, { port: actualPort, pid, token, bootNonce, startedAt });
        resetIdleTimer();
        resolve({ port: actualPort, pid, token, bootNonce, startedAt });
      }
      httpServer.once("error", onError);
      httpServer.once("listening", onListening);
      httpServer.listen(port, "127.0.0.1");
    });
  }

  async function shutdown(reason = "manual") {
    if (shuttingDown) return { deleted: false, reason: "already_shutting_down" };
    shuttingDown = true;
    if (idleTimer) clearTimeout(idleTimer);
    sse.closeAll();
    watcher.close();
    const deleteResult = compareAndDeleteServerJson(homeDir, { pid, bootNonce });
    await new Promise((resolve) => {
      if (!httpServer.listening) return resolve();
      httpServer.close(() => resolve());
    });
    return { reason, ...deleteResult };
  }

  return {
    start,
    shutdown,
    getSnapshot: () => snapshot,
    getFreshSnapshot: freshSnapshot,
    httpServer,
    homeDir,
    configuredPort: port,
    get port() {
      return actualPort;
    },
    pid,
    bootNonce,
    token,
    idleMs,
    _sse: sse,
    _watcher: watcher,
  };
}
