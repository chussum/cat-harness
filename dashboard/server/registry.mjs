/**
 * dashboard/server/registry.mjs — home-directory registry.json (list of registered
 * project roots) read + atomic upsert, plus a reconcile helper the watcher uses to
 * detect newly-added/removed roots without a restart (critic finding C1).
 *
 * Shape: { "version": 1, "roots": ["/abs/project/a", ...], "updated_at": "ISO8601" }
 * Disk is the sole source of truth: no in-memory-only registry state is authoritative.
 */

import path from "node:path";
import { registryPath } from "./constants.mjs";
import { readJsonSafe, writeJsonFile } from "./fsutil.mjs";

const EMPTY_REGISTRY = Object.freeze({ version: 1, roots: [], updated_at: null });

function normalizeRoot(root) {
  return path.resolve(root);
}

/** Fail-open read: missing or corrupt registry.json resolves to an empty registry. */
export function readRegistry(homeDir) {
  const file = registryPath(homeDir);
  const data = readJsonSafe(file, null);
  if (!data || typeof data !== "object" || !Array.isArray(data.roots)) {
    return { ...EMPTY_REGISTRY };
  }
  const roots = data.roots.filter((r) => typeof r === "string" && r.trim().length > 0).map(normalizeRoot);
  return { version: 1, roots: [...new Set(roots)], updated_at: data.updated_at ?? null };
}

/** Atomic upsert: adds `root` if not already present (dedup by resolved absolute path). */
export function upsertRegistryRoot(homeDir, root) {
  const file = registryPath(homeDir);
  const current = readRegistry(homeDir);
  const normalized = normalizeRoot(root);
  const roots = current.roots.includes(normalized) ? current.roots : [...current.roots, normalized];
  const next = { version: 1, roots, updated_at: new Date().toISOString() };
  writeJsonFile(file, next);
  return next;
}

/**
 * Atomic removal: removes `root` (resolved-path compare, mirrors `upsertRegistryRoot`'s
 * normalization) from registry.json — the server-side half of "폐업 처리" (close/retire a
 * dormant floor for real, dashboard/server/server.mjs's `POST /api/unregister`). A root
 * that isn't present, or a wholly missing registry.json (fail-open `readRegistry`), is a
 * no-op success: still writes the (unchanged) registry back out rather than erroring, same
 * as `upsertRegistryRoot`'s symmetric idempotent-write shape.
 */
export function removeRegistryRoot(homeDir, root) {
  const file = registryPath(homeDir);
  const current = readRegistry(homeDir);
  const normalized = normalizeRoot(root);
  const roots = current.roots.filter((r) => r !== normalized);
  const next = { version: 1, roots, updated_at: new Date().toISOString() };
  writeJsonFile(file, next);
  return next;
}

/**
 * Diff the freshly-read registry against a live set of currently-watched roots.
 * Returns { added, removed } absolute-path lists for the caller (watcher.mjs) to
 * act on (start/stop per-root watchers), never mutating either input.
 */
export function reconcileWatchedRoots(registry, watchedRootsSet) {
  const registryRoots = new Set(registry.roots);
  const added = registry.roots.filter((r) => !watchedRootsSet.has(r));
  const removed = [...watchedRootsSet].filter((r) => !registryRoots.has(r));
  return { added, removed };
}
