/**
 * dashboard/server/constants.mjs — env-injectable configuration for the status server.
 *
 * F16 (DESIGN.md-adjacent contract, plan §"Risks and mitigations" item 1): a concrete
 * fixed default port with NO automatic fallback. CAT_HARNESS_PORT is an explicit,
 * non-automatic override — never treat a bind failure as "try the next port".
 *
 * Port default 9223 (not 9222): 9222 is the Chrome DevTools/Playwright/agent-browser
 * remote-debugging port; a 9222 default would silently fail to bind under F16's
 * no-fallback rule whenever Chrome remote debugging is active on the same machine.
 *
 * Every dimension needed for hermetic tests is injectable via env: home dir
 * (CAT_HARNESS_HOME), port (CAT_HARNESS_PORT), idle shutdown timeout
 * (CAT_HARNESS_IDLE_MS).
 */

import { randomBytes, randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";

export const DEFAULT_PORT = 9223;
export const DEFAULT_IDLE_MS = 30 * 60 * 1000; // 30 minutes
export const WATCH_DEBOUNCE_MS = 150; // within the spec's 100-200ms band

export function getHomeDir(env = process.env) {
  return env.CAT_HARNESS_HOME ? path.resolve(env.CAT_HARNESS_HOME) : path.join(os.homedir(), ".cat-harness");
}

/**
 * Port resolution order (critic finding C2 per the approved plan): an explicit
 * `override` argument (used by callers/tests that need a specific value) wins,
 * else CAT_HARNESS_PORT, else DEFAULT_PORT. No other fallback exists.
 */
export function getPort(env = process.env, override = undefined) {
  if (override !== undefined && override !== null) return Number(override);
  const raw = env.CAT_HARNESS_PORT;
  if (raw !== undefined && raw !== "") {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return DEFAULT_PORT;
}

export function getIdleMs(env = process.env, override = undefined) {
  if (override !== undefined && override !== null) return Number(override);
  const raw = env.CAT_HARNESS_IDLE_MS;
  if (raw !== undefined && raw !== "") {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return DEFAULT_IDLE_MS;
}

export function registryPath(homeDir) {
  return path.join(homeDir, "registry.json");
}

export function serverJsonPath(homeDir) {
  return path.join(homeDir, "server.json");
}

export function generateBootNonce() {
  return randomUUID();
}

export function generateToken() {
  return randomBytes(24).toString("hex");
}

/** A well-formed boot_nonce is a non-empty string (cheap shape check, architect finding A3). */
export function isWellFormedBootNonce(value) {
  return typeof value === "string" && value.trim().length > 0;
}
