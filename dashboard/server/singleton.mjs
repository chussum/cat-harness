/**
 * dashboard/server/singleton.mjs — server.json singleton discovery-file lifecycle.
 *
 * server.json = { port, pid, token, boot_nonce, started_at }. Written ONLY after a
 * successful listen() call (never speculatively) so a failed instance can never
 * masquerade as live. On idle shutdown, the owning process re-reads server.json
 * immediately before deleting and unlinks ONLY on an exact pid+boot_nonce match
 * against its own in-memory identity (compare-and-delete) — a losing/older
 * instance must never delete a newer instance's discovery file.
 */

import fs from "node:fs";
import { serverJsonPath } from "./constants.mjs";
import { readJsonSafe, writeJsonFile } from "./fsutil.mjs";

/** Fail-open read: missing/corrupt server.json resolves to null. */
export function readServerJson(homeDir) {
  const data = readJsonSafe(serverJsonPath(homeDir), null);
  if (!data || typeof data !== "object") return null;
  return data;
}

/**
 * Write server.json. Callers MUST only invoke this after their own listen() call
 * has already succeeded (architect finding A2) — this function does not itself
 * verify liveness, it only performs the atomic write.
 */
export function writeServerJson(homeDir, { port, pid, token, bootNonce, startedAt }) {
  const record = { port, pid, token, boot_nonce: bootNonce, started_at: startedAt };
  writeJsonFile(serverJsonPath(homeDir), record);
  return record;
}

/**
 * Compare-and-delete: re-reads server.json fresh from disk and unlinks it ONLY if
 * both pid and boot_nonce match `self`. Returns a result object describing what
 * happened; never throws, never deletes on a mismatch or a missing file.
 */
export function compareAndDeleteServerJson(homeDir, self) {
  const file = serverJsonPath(homeDir);
  const onDisk = readServerJson(homeDir);
  if (!onDisk) {
    return { deleted: false, reason: "missing" };
  }
  if (onDisk.pid === self.pid && onDisk.boot_nonce === self.bootNonce) {
    try {
      fs.unlinkSync(file);
    } catch {
      return { deleted: false, reason: "unlink_failed" };
    }
    return { deleted: true, reason: "self_match" };
  }
  return { deleted: false, reason: "mismatch", onDisk };
}

/**
 * Cheap, local, synchronous liveness pre-check for hook-side callers (no network):
 * process.kill(pid, 0) succeeds AND server.json carries a well-formed boot_nonce
 * shape (architect finding A3 hardening against stale-PID false-liveness).
 */
export function isLocallyLive(homeDir) {
  const onDisk = readServerJson(homeDir);
  if (!onDisk) return false;
  if (typeof onDisk.boot_nonce !== "string" || onDisk.boot_nonce.trim().length === 0) return false;
  if (typeof onDisk.pid !== "number") return false;
  try {
    process.kill(onDisk.pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Health-token validation: the caller-supplied token must match server.json's token exactly. */
export function isValidHealthToken(serverJsonRecord, providedToken) {
  return (
    !!serverJsonRecord &&
    typeof serverJsonRecord.token === "string" &&
    typeof providedToken === "string" &&
    providedToken.length > 0 &&
    providedToken === serverJsonRecord.token
  );
}
