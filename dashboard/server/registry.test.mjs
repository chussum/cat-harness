import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { readRegistry, upsertRegistryRoot, removeRegistryRoot, reconcileWatchedRoots, pruneMissingRoots } from "./registry.mjs";

function mkTmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cat-harness-registry-test-"));
}

test("registry: reading a missing registry.json fails open to an empty registry", () => {
  const home = mkTmpHome();
  const reg = readRegistry(home);
  assert.deepEqual(reg.roots, []);
});

test("registry: reading a corrupt registry.json fails open to an empty registry", () => {
  const home = mkTmpHome();
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, "registry.json"), "{ this is not json");
  const reg = readRegistry(home);
  assert.deepEqual(reg.roots, []);
});

test("registry: upsert adds a new root and is idempotent on repeat", () => {
  const home = mkTmpHome();
  const projectA = path.join(home, "project-a");
  const first = upsertRegistryRoot(home, projectA);
  assert.deepEqual(first.roots, [path.resolve(projectA)]);

  const second = upsertRegistryRoot(home, projectA);
  assert.deepEqual(second.roots, [path.resolve(projectA)], "re-registering the same root must not duplicate it");

  const onDisk = readRegistry(home);
  assert.deepEqual(onDisk.roots, [path.resolve(projectA)]);
});

test("registry: upsert accumulates distinct roots", () => {
  const home = mkTmpHome();
  const a = path.join(home, "project-a");
  const b = path.join(home, "project-b");
  upsertRegistryRoot(home, a);
  const after = upsertRegistryRoot(home, b);
  assert.deepEqual(after.roots.sort(), [path.resolve(a), path.resolve(b)].sort());
});

test("registry: removeRegistryRoot removes an existing root (resolved-path compare), atomically on disk", () => {
  const home = mkTmpHome();
  const a = path.join(home, "project-a");
  const b = path.join(home, "project-b");
  upsertRegistryRoot(home, a);
  upsertRegistryRoot(home, b);

  const after = removeRegistryRoot(home, a);
  assert.deepEqual(after.roots, [path.resolve(b)]);

  const onDisk = readRegistry(home);
  assert.deepEqual(onDisk.roots, [path.resolve(b)], "removal must be persisted to disk");
});

test("registry: removeRegistryRoot is a no-op success for a root that was never registered", () => {
  const home = mkTmpHome();
  const a = path.join(home, "project-a");
  upsertRegistryRoot(home, a);

  const after = removeRegistryRoot(home, path.join(home, "never-registered"));
  assert.deepEqual(after.roots, [path.resolve(a)], "an unrelated root must be left untouched");
});

test("registry: removeRegistryRoot is a no-op success against a wholly missing registry.json", () => {
  const home = mkTmpHome();
  const after = removeRegistryRoot(home, path.join(home, "project-a"));
  assert.deepEqual(after.roots, []);
  assert.deepEqual(readRegistry(home).roots, []);
});

test("registry: reconcileWatchedRoots reports added and removed roots without mutating inputs", () => {
  const registry = { version: 1, roots: ["/p/a", "/p/b", "/p/c"], updated_at: null };
  const watched = new Set(["/p/a", "/p/x"]);
  const { added, removed } = reconcileWatchedRoots(registry, watched);
  assert.deepEqual(added.sort(), ["/p/b", "/p/c"]);
  assert.deepEqual(removed.sort(), ["/p/x"]);
  // inputs untouched
  assert.deepEqual(registry.roots, ["/p/a", "/p/b", "/p/c"]);
  assert.deepEqual([...watched].sort(), ["/p/a", "/p/x"]);
});

test("registry: pruneMissingRoots drops roots whose dir is gone, keeps existing ones, and rewrites the file", () => {
  const home = mkTmpHome();
  const alive = fs.mkdtempSync(path.join(os.tmpdir(), "cat-harness-alive-"));
  const ghost = fs.mkdtempSync(path.join(os.tmpdir(), "cat-harness-ghost-"));
  upsertRegistryRoot(home, alive);
  upsertRegistryRoot(home, ghost);
  fs.rmSync(ghost, { recursive: true, force: true }); // delete the dir -> ghost floor

  const { roots, removed } = pruneMissingRoots(home);
  assert.deepEqual(roots, [path.resolve(alive)], "only the still-existing root survives");
  assert.deepEqual(removed, [path.resolve(ghost)], "the deleted root is reported as removed");
  assert.deepEqual(readRegistry(home).roots, [path.resolve(alive)], "registry.json is rewritten without the ghost");
});

test("registry: pruneMissingRoots is a no-op (no removals, no report) when every root exists", () => {
  const home = mkTmpHome();
  const a = fs.mkdtempSync(path.join(os.tmpdir(), "cat-harness-a-"));
  const b = fs.mkdtempSync(path.join(os.tmpdir(), "cat-harness-b-"));
  upsertRegistryRoot(home, a);
  upsertRegistryRoot(home, b);

  const { roots, removed } = pruneMissingRoots(home);
  assert.deepEqual(removed, [], "nothing pruned when all roots exist");
  assert.deepEqual(roots.sort(), [path.resolve(a), path.resolve(b)].sort());
});
