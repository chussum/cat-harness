/**
 * dashboard/server/watcher.mjs — fs.watch-based change detection (F17: no polling,
 * ever). One fs.watch({recursive:true}) call per registered project's .cat
 * directory (the tree the server actually reads; watching the whole project root,
 * including node_modules/.git, would be wasteful and is not what the server reads),
 * PLUS a dedicated watch on the home registry.json file/directory so a newly
 * registered project's floor grows live without a restart (critic finding C1).
 *
 * Debounced (100-200ms) coalescing: any event is treated only as a trigger for a
 * full, coarse re-read of the changed project (or a full registry reconcile),
 * never byte-level diffing — self-healing against dropped/coalesced OS events
 * (pre-mortem scenario 2). Atomic-rename events (tmp+rename writes) are ordinary
 * fs.watch events under this directory-level watch and are treated as triggers
 * exactly like any other change.
 */

import fs from "node:fs";
import path from "node:path";
import { WATCH_DEBOUNCE_MS } from "./constants.mjs";
import { existsDir } from "./fsutil.mjs";

export function createWatcher({
  homeDir,
  initialRoots = [],
  debounceMs = WATCH_DEBOUNCE_MS,
  onProjectChange = () => {},
  onRegistryChange = () => {},
  onError = (message) => {
    console.error(`[dashboard/watcher] ${message}`);
  },
}) {
  const rootWatchers = new Map(); // root -> fs.FSWatcher (recursive, on <root>/.cat)
  const pendingRootWatchers = new Map(); // root -> fs.FSWatcher (non-recursive, on <root>, waiting for .cat to appear)
  const rootTimers = new Map(); // root -> Timeout
  let registryWatcher = null;
  let registryTimer = null;
  let closed = false;

  function scheduleProjectChange(root) {
    if (closed) return;
    const existing = rootTimers.get(root);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      rootTimers.delete(root);
      onProjectChange(root);
    }, debounceMs);
    if (timer.unref) timer.unref();
    rootTimers.set(root, timer);
  }

  function closePendingWatcher(root) {
    const pending = pendingRootWatchers.get(root);
    if (!pending) return;
    try {
      pending.close();
    } catch {
      /* already closed */
    }
    pendingRootWatchers.delete(root);
  }

  /** Attaches the real recursive watcher once <root>/.cat is known to exist. */
  function attachCatWatcher(root, catDir) {
    // Idempotency guard: if two root-level create events for the same root are
    // delivered before the first pending callback's teardown lands, a second
    // recursive watcher would be created and orphaned (lost from rootWatchers,
    // closed only at process exit). Refuse to double-attach.
    if (rootWatchers.has(root)) return;
    try {
      const watcher = fs.watch(catDir, { recursive: true }, () => scheduleProjectChange(root));
      watcher.on("error", (err) => onError(`root watch error for ${root}: ${err?.message ?? err}`));
      // Unref: the running http server's own listening socket is what keeps a real
      // process alive; this watcher must not ALSO pin the event loop open, or a
      // server whose listen() failed (F16 no-fallback) would hang forever with
      // nothing left to do (matters most for tests that construct a server without
      // ever successfully starting it).
      if (typeof watcher.unref === "function") watcher.unref();
      rootWatchers.set(root, watcher);
    } catch (err) {
      onError(`failed to watch ${catDir}: ${err?.message ?? err}`);
    }
  }

  /**
   * A registered root whose .cat/ doesn't exist YET (architect MEDIUM: G003's
   * launcher registers a project before its first cat-harness run creates .cat)
   * gets a cheap, non-recursive watch on the root itself, waiting only for a
   * ".cat" entry to appear. On that event we tear down this pending watch,
   * attach the real recursive .cat watcher, and fire one project-change so a
   * full re-read + SSE delta goes out immediately — no HTTP request, no
   * registry write, and no polling required.
   */
  function attachPendingRootWatcher(root) {
    if (pendingRootWatchers.has(root)) return;
    if (!existsDir(root)) {
      // The root itself doesn't exist yet either; nothing to watch. Self-healing:
      // the next reconcile() call (registry change or fresh snapshot) retries.
      return;
    }
    try {
      const watcher = fs.watch(root, {}, (eventType, filename) => {
        if (filename && filename !== ".cat") return;
        const catDir = path.join(root, ".cat");
        if (!existsDir(catDir)) return; // not created yet, or an unrelated rename
        closePendingWatcher(root);
        attachCatWatcher(root, catDir);
        scheduleProjectChange(root);
      });
      watcher.on("error", (err) => onError(`pending root watch error for ${root}: ${err?.message ?? err}`));
      if (typeof watcher.unref === "function") watcher.unref();
      pendingRootWatchers.set(root, watcher);
    } catch (err) {
      onError(`failed to watch pending root ${root}: ${err?.message ?? err}`);
    }
  }

  function watchRoot(root) {
    if (rootWatchers.has(root)) return;
    const catDir = path.join(root, ".cat");
    if (!existsDir(catDir)) {
      attachPendingRootWatcher(root);
      return;
    }
    closePendingWatcher(root); // stale pending watch, if any, is no longer needed
    attachCatWatcher(root, catDir);
  }

  function unwatchRoot(root) {
    const watcher = rootWatchers.get(root);
    if (watcher) {
      try {
        watcher.close();
      } catch {
        /* already closed */
      }
      rootWatchers.delete(root);
    }
    closePendingWatcher(root);
    const timer = rootTimers.get(root);
    if (timer) {
      clearTimeout(timer);
      rootTimers.delete(root);
    }
  }

  /** Diff the desired root set against what's currently watched; add/remove watchers. */
  function reconcile(desiredRoots) {
    const desired = new Set(desiredRoots);
    for (const root of desiredRoots) watchRoot(root);
    // A de-registered root may only have a PENDING (no-.cat-yet) watch rather
    // than a real one — check both maps so it's never left dangling.
    const currentlyTracked = new Set([...rootWatchers.keys(), ...pendingRootWatchers.keys()]);
    for (const root of currentlyTracked) {
      if (!desired.has(root)) unwatchRoot(root);
    }
    // Retry any desired root that still has no live watcher (e.g. .cat appeared since).
    for (const root of desiredRoots) {
      if (!rootWatchers.has(root)) watchRoot(root);
    }
  }

  function scheduleRegistryChange() {
    if (closed) return;
    if (registryTimer) clearTimeout(registryTimer);
    registryTimer = setTimeout(() => {
      registryTimer = null;
      onRegistryChange();
    }, debounceMs);
    if (registryTimer.unref) registryTimer.unref();
  }

  function watchRegistry() {
    try {
      fs.mkdirSync(homeDir, { recursive: true });
      registryWatcher = fs.watch(homeDir, {}, (eventType, filename) => {
        if (filename && filename !== "registry.json") return;
        scheduleRegistryChange();
      });
      registryWatcher.on("error", (err) => onError(`registry watch error: ${err?.message ?? err}`));
      if (typeof registryWatcher.unref === "function") registryWatcher.unref();
    } catch (err) {
      onError(`failed to watch home dir ${homeDir}: ${err?.message ?? err}`);
    }
  }

  reconcile(initialRoots);
  watchRegistry();

  function close() {
    closed = true;
    for (const root of new Set([...rootWatchers.keys(), ...pendingRootWatchers.keys()])) unwatchRoot(root);
    if (registryWatcher) {
      try {
        registryWatcher.close();
      } catch {
        /* already closed */
      }
      registryWatcher = null;
    }
    if (registryTimer) {
      clearTimeout(registryTimer);
      registryTimer = null;
    }
  }

  return {
    reconcile,
    close,
    watchedRoots: () => [...rootWatchers.keys()],
  };
}
