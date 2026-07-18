#!/usr/bin/env node
/**
 * dashboard/server/launcher.mjs — detached "ensure the status server is running"
 * entry point spawned by hooks/cat-hook.mjs's router auto-start step.
 *
 * This process runs OFF the hook's timing budget: hooks/cat-hook.mjs's router
 * does only a cheap, LOCAL, synchronous liveness pre-check (fs.readFileSync +
 * process.kill(pid,0) + a boot_nonce shape check) and, if that pre-check looks
 * stale/missing/malformed, spawns THIS module detached+unref'd and returns
 * immediately. Node has no synchronous HTTP client, so the router itself never
 * makes a network call — this launcher is the ONLY place in the auto-start path
 * allowed to do the AUTHORITATIVE health-token HTTP probe.
 *
 * PID-reuse posture (see DESIGN.md §10): the router's sync pre-check is
 * ADVISORY ONLY — a reused pid can look alive to `process.kill(pid, 0)`. This
 * launcher's health-token probe is the actual source of truth: a foreign
 * process squatting on a stale pid will not know the token in server.json (or
 * there will be no server.json at all), so the probe fails and this launcher
 * starts a fresh server — the system self-corrects without any operator step.
 * The one case that needs a human is documented at bottom (PID reuse THAT
 * ALSO reuses server.json's exact content — vanishingly rare, remedy: delete
 * the discovery file).
 *
 * F16 (no port fallback): if starting a fresh server hits EADDRINUSE because
 * some OTHER process — not a healthy cat-harness server, the probe above
 * already ruled that out — holds the fixed port, this logs one structured
 * failure line and exits cleanly. It NEVER tries another port and NEVER lets
 * a bind failure surface as a hook error (the router already returned long
 * before this process even started).
 */

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getHomeDir } from "./constants.mjs";
import { readServerJson } from "./singleton.mjs";
import { createServer as defaultCreateServer } from "./server.mjs";

const PROBE_TIMEOUT_MS = 1500;

/** Real health-token probe (Node builtins only). Never throws — resolves to a not-ok shape instead. */
function defaultProbe(url) {
  return new Promise(resolve => {
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    let req;
    try {
      req = http.get(url, res => {
        const chunks = [];
        res.on("data", chunk => chunks.push(chunk));
        res.on("end", () => {
          let body = null;
          try {
            body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          } catch {
            /* leave body null — treated as unhealthy below */
          }
          finish({ status: res.statusCode, body });
        });
        res.on("error", () => finish({ status: 0, body: null }));
      });
    } catch {
      finish({ status: 0, body: null });
      return;
    }
    req.on("error", () => finish({ status: 0, body: null }));
    req.setTimeout(PROBE_TIMEOUT_MS, () => {
      req.destroy();
      finish({ status: 0, body: null });
    });
  });
}

/** Structured, best-effort append-only log — never throws past its own boundary. */
function defaultLog(homeDir) {
  return entry => {
    try {
      fs.mkdirSync(homeDir, { recursive: true });
      const line = `${JSON.stringify({ ts: new Date().toISOString(), source: "launcher", ...entry })}\n`;
      fs.appendFileSync(path.join(homeDir, "launcher.log"), line);
    } catch {
      /* logging must never crash the launcher */
    }
  };
}

/**
 * Ensure a healthy cat-harness status server is running for `homeDir`.
 * Returns { started, reason, server?, info? } — never throws.
 *
 * opts.probe / opts.createServer / opts.log are injectable for hermetic tests
 * (mocked HTTP probe, an in-memory server factory is NOT substituted — tests
 * use the real createServer() bound to an ephemeral/foreign port instead, so
 * the EADDRINUSE and health-token paths are exercised for real). opts.port is
 * forwarded straight through to createServer's own override (e.g. `0` for an
 * OS-assigned ephemeral port in tests — createServer's getPort() intentionally
 * does NOT treat CAT_HARNESS_PORT="0" from env the same way, so tests MUST use
 * opts.port, not env, to get an ephemeral port).
 */
export async function ensureServer(opts = {}) {
  const env = opts.env ?? process.env;
  const homeDir = opts.homeDir ?? getHomeDir(env);
  const probe = opts.probe ?? defaultProbe;
  const log = opts.log ?? defaultLog(homeDir);
  const makeServer = opts.createServer ?? defaultCreateServer;

  const existing = readServerJson(homeDir);
  if (existing && typeof existing.port === "number" && typeof existing.token === "string" && existing.token) {
    const url = `http://127.0.0.1:${existing.port}/healthz?token=${encodeURIComponent(existing.token)}`;
    let result;
    try {
      result = await probe(url);
    } catch {
      result = { status: 0, body: null };
    }
    const healthy = Boolean(result && result.status === 200 && result.body && result.body.ok === true);
    if (healthy) {
      log({ event: "already_healthy", pid: existing.pid, port: existing.port });
      return { started: false, reason: "already_healthy" };
    }
    log({ event: "stale_discovery_file", onDisk: { pid: existing.pid, port: existing.port } });
  }

  const server = makeServer({ homeDir, env, port: opts.port });
  try {
    const info = await server.start();
    log({ event: "started", pid: info.pid, port: info.port });
    return { started: true, reason: "started", server, info };
  } catch (error) {
    const code = error && error.code ? error.code : undefined;
    if (code === "EADDRINUSE") {
      // F16: no fallback. The probe above already ruled out a HEALTHY cat-harness
      // instance holding this port (or found no discovery file at all) — whatever
      // is bound here now is a foreign occupant. Log and exit clean, never retry.
      log({
        event: "bind_failed_foreign_port_owner",
        port: server.configuredPort,
        detail: "EADDRINUSE against a non-cat-harness (or unhealthy) process; no port fallback per F16",
      });
    } else {
      log({
        event: "bind_failed",
        port: server.configuredPort,
        error: error && error.message ? error.message : String(error),
      });
    }
    try {
      await server.shutdown("bind_failed");
    } catch {
      /* best-effort cleanup only */
    }
    return { started: false, reason: "bind_failed", error: code ?? "unknown" };
  }
}

const IS_MAIN = (() => {
  try {
    return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (IS_MAIN) {
  ensureServer()
    .then(result => {
      if (result.started && result.server) {
        // This detached, unref'd process now IS the running server (mirrors
        // dashboard/server/index.mjs's own signal handling).
        let shuttingDown = false;
        const handleSignal = signal => {
          if (shuttingDown) return;
          shuttingDown = true;
          result.server
            .shutdown(signal)
            .catch(() => {})
            .finally(() => process.exit(0));
        };
        process.on("SIGINT", () => handleSignal("SIGINT"));
        process.on("SIGTERM", () => handleSignal("SIGTERM"));
        return; // do not exit — the listening server keeps the event loop alive
      }
      process.exit(0); // already healthy, or bind failed — nothing more for this process to do
    })
    .catch(error => {
      try {
        process.stderr.write(`[dashboard/launcher] fatal: ${error && error.stack ? error.stack : error}\n`);
      } catch {
        /* nothing left to do */
      }
      process.exit(0); // never surface as a crash — the hook that spawned us already returned
    });
}
