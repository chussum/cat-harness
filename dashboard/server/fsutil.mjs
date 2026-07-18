/**
 * dashboard/server/fsutil.mjs — small fs helpers shared by the status server.
 *
 * Mirrors scripts/cat-state.mjs's atomic-write convention (DESIGN.md §4/§9):
 * crash-atomic tmp+rename writes, 2-space-indent JSON with trailing newline.
 * Node builtins only, zero deps.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** Crash-atomic write: mkdir parents, tmp file, rename. */
export function atomicWrite(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}.${randomUUID()}`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

/** All JSON files: 2-space indent, trailing newline. */
export function writeJsonFile(file, obj) {
  atomicWrite(file, JSON.stringify(obj, null, 2) + "\n");
}

/** Fail-open JSON read: returns fallback on missing file, parse error, or non-object content. */
export function readJsonSafe(file, fallback = null) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return fallback;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

/** Fail-open JSONL read: returns [] on missing file; skips unparseable lines. */
export function readJsonlSafe(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      /* skip malformed line, self-healing */
    }
  }
  return out;
}

/** Last `n` parsed entries of a JSONL file (fail-open, [] on missing/corrupt). */
export function tailJsonl(file, n) {
  const all = readJsonlSafe(file);
  return n > 0 ? all.slice(Math.max(0, all.length - n)) : all;
}

export function existsDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export function listDirSafe(p) {
  try {
    return fs.readdirSync(p, { withFileTypes: true });
  } catch {
    return [];
  }
}
