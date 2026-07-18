import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { createWatcher } from "./watcher.mjs";

function mkTmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cat-harness-watcher-test-"));
}

function mkProjectWithCat(home, name) {
  const root = path.join(home, name);
  fs.mkdirSync(path.join(root, ".cat", "state"), { recursive: true });
  fs.writeFileSync(path.join(root, ".cat", "state", "ultragoal-state.json"), "{}\n");
  return root;
}

const DEBOUNCE_MS = 60;

test("watcher: a burst of rapid writes inside the debounce window coalesces into ONE onProjectChange call", async () => {
  const home = mkTmpHome();
  const root = mkProjectWithCat(home, "project-a");
  let calls = 0;
  const watcher = createWatcher({
    homeDir: home,
    initialRoots: [root],
    debounceMs: DEBOUNCE_MS,
    onProjectChange: () => {
      calls += 1;
    },
    onRegistryChange: () => {},
  });

  try {
    const stateFile = path.join(root, ".cat", "state", "ultragoal-state.json");
    // Rapid multi-write burst (simulates one goal checkpoint touching several files
    // in quick succession) — all inside the debounce window.
    for (let i = 0; i < 5; i++) {
      fs.writeFileSync(stateFile, JSON.stringify({ i }));
      await delay(5);
    }
    // Wait past the debounce window for the trailing timer to fire.
    await delay(DEBOUNCE_MS + 150);
    assert.equal(calls, 1, `expected exactly one coalesced onProjectChange call, got ${calls}`);
  } finally {
    watcher.close();
  }
});

test("watcher: two events separated by MORE than the debounce window fire twice", async () => {
  const home = mkTmpHome();
  const root = mkProjectWithCat(home, "project-b");
  let calls = 0;
  const watcher = createWatcher({
    homeDir: home,
    initialRoots: [root],
    debounceMs: DEBOUNCE_MS,
    onProjectChange: () => {
      calls += 1;
    },
    onRegistryChange: () => {},
  });

  try {
    const stateFile = path.join(root, ".cat", "state", "ultragoal-state.json");
    fs.writeFileSync(stateFile, JSON.stringify({ i: 1 }));
    await delay(DEBOUNCE_MS + 150);
    fs.writeFileSync(stateFile, JSON.stringify({ i: 2 }));
    await delay(DEBOUNCE_MS + 150);
    assert.equal(calls, 2, `expected two separate onProjectChange calls, got ${calls}`);
  } finally {
    watcher.close();
  }
});

test("watcher: reconcile() adds a watcher for a newly-registered root and removes a de-registered one", async () => {
  const home = mkTmpHome();
  const rootA = mkProjectWithCat(home, "project-a");
  const rootB = mkProjectWithCat(home, "project-b");

  const changed = [];
  const watcher = createWatcher({
    homeDir: home,
    initialRoots: [rootA],
    debounceMs: DEBOUNCE_MS,
    onProjectChange: (root) => changed.push(root),
    onRegistryChange: () => {},
  });

  try {
    assert.deepEqual(watcher.watchedRoots().sort(), [rootA]);

    watcher.reconcile([rootA, rootB]);
    assert.deepEqual(watcher.watchedRoots().sort(), [rootA, rootB].sort());

    // The newly-added root's watcher must actually be live.
    fs.writeFileSync(path.join(rootB, ".cat", "state", "ultragoal-state.json"), JSON.stringify({ touched: true }));
    await delay(DEBOUNCE_MS + 150);
    assert.ok(changed.includes(rootB), "expected onProjectChange for the newly-registered root");

    watcher.reconcile([rootB]);
    assert.deepEqual(watcher.watchedRoots(), [rootB]);
  } finally {
    watcher.close();
  }
});

test("watcher: a registry.json write triggers onRegistryChange (debounced)", async () => {
  const home = mkTmpHome();
  let registryCalls = 0;
  const watcher = createWatcher({
    homeDir: home,
    initialRoots: [],
    debounceMs: DEBOUNCE_MS,
    onProjectChange: () => {},
    onRegistryChange: () => {
      registryCalls += 1;
    },
  });

  try {
    fs.writeFileSync(path.join(home, "registry.json"), JSON.stringify({ roots: [] }));
    // Slightly wider margin than the other debounce assertions: this test has been
    // observed to flake under heavy CONCURRENT multi-file `node --test` runs (FSEvents
    // delivery lag under system load), never when run alone or serially.
    await delay(DEBOUNCE_MS + 350);
    assert.equal(registryCalls, 1);
  } finally {
    watcher.close();
  }
});

test("watcher: a root registered BEFORE its .cat dir exists is observed the moment .cat is created — no HTTP request, no registry write needed (architect MEDIUM regression)", async () => {
  const home = mkTmpHome();
  // Root exists on disk (it's a real project directory) but has NOT run any
  // cat-harness workflow yet, so .cat/ does not exist at watcher-construction
  // time — this is exactly G003's boot-before-.cat ordering (launcher registers
  // the project, THEN the first cat-harness run creates .cat).
  const root = path.join(home, "not-yet-a-cat-project");
  fs.mkdirSync(root, { recursive: true });

  let calls = 0;
  const watcher = createWatcher({
    homeDir: home,
    initialRoots: [root],
    debounceMs: DEBOUNCE_MS,
    onProjectChange: () => {
      calls += 1;
    },
    onRegistryChange: () => {},
  });

  try {
    assert.deepEqual(watcher.watchedRoots(), [], "no live .cat watcher yet — .cat doesn't exist");

    // Simulate the first-ever cat-harness run creating .cat, with NO intervening
    // reconcile()/registry-write/HTTP request of any kind.
    fs.mkdirSync(path.join(root, ".cat", "state"), { recursive: true });
    fs.writeFileSync(path.join(root, ".cat", "state", "ultragoal-state.json"), JSON.stringify({ active: true }));

    await delay(DEBOUNCE_MS + 400);

    assert.ok(calls >= 1, "onProjectChange must fire once .cat is created, without any external trigger");
    assert.deepEqual(watcher.watchedRoots(), [root], "a real recursive .cat watcher must now be attached");

    // And the newly-attached watcher must itself be live: a further state write
    // inside .cat should still be observed.
    const callsBefore = calls;
    fs.writeFileSync(path.join(root, ".cat", "state", "ultragoal-state.json"), JSON.stringify({ active: false }));
    await delay(DEBOUNCE_MS + 250);
    assert.ok(calls > callsBefore, "the newly-attached .cat watcher must observe further changes");
  } finally {
    watcher.close();
  }
});
