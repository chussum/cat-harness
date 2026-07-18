#!/usr/bin/env node
/**
 * dashboard/app/scripts/check-dist-drift.mjs — fails loudly if the committed
 * dashboard/app/dist/ (the prebuilt static app the server ships, so end users
 * never have to run npm/vite themselves) is stale relative to the current
 * source tree.
 *
 * Rebuilds the app into a scratch directory with the SAME build command used
 * to produce the committed dist (`tsc -b && vite build`), then recursively
 * diffs the scratch build against the committed dist/ byte-for-byte. Any
 * difference (missing file, extra file, changed content) is drift -> exit 1.
 *
 * Node builtins only (fs/path/os/child_process/url) — no new dependencies.
 * Run it with: node dashboard/app/scripts/check-dist-drift.mjs
 * (or: npm --prefix dashboard/app run check-dist-drift)
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const COMMITTED_DIST = path.join(APP_DIR, 'dist')

function listFilesRecursive(root) {
  const out = []
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
      } else if (entry.isFile()) {
        out.push(path.relative(root, full))
      }
    }
  }
  if (fs.existsSync(root)) walk(root)
  return out.sort()
}

function diffDirs(committedDir, freshDir) {
  const committedFiles = listFilesRecursive(committedDir)
  const freshFiles = listFilesRecursive(freshDir)
  const committedSet = new Set(committedFiles)
  const freshSet = new Set(freshFiles)

  const missingFromFresh = committedFiles.filter((f) => !freshSet.has(f))
  const extraInFresh = freshFiles.filter((f) => !committedSet.has(f))
  const changed = []

  for (const rel of committedFiles) {
    if (!freshSet.has(rel)) continue
    const a = fs.readFileSync(path.join(committedDir, rel))
    const b = fs.readFileSync(path.join(freshDir, rel))
    if (!a.equals(b)) changed.push(rel)
  }

  return { missingFromFresh, extraInFresh, changed }
}

function main() {
  if (!fs.existsSync(COMMITTED_DIST)) {
    console.error(`[check-dist-drift] committed dist not found at ${COMMITTED_DIST} — build it first (npm run build).`)
    process.exit(1)
  }

  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cat-harness-dist-drift-'))
  console.log(`[check-dist-drift] rebuilding into scratch dir: ${scratchDir}`)

  try {
    execFileSync('npx', ['tsc', '-b'], { cwd: APP_DIR, stdio: 'inherit' })
    execFileSync('npx', ['vite', 'build', '--outDir', scratchDir, '--emptyOutDir'], { cwd: APP_DIR, stdio: 'inherit' })

    const { missingFromFresh, extraInFresh, changed } = diffDirs(COMMITTED_DIST, scratchDir)
    const hasDrift = missingFromFresh.length > 0 || extraInFresh.length > 0 || changed.length > 0

    if (!hasDrift) {
      console.log('[check-dist-drift] OK — committed dist/ matches a fresh build byte-for-byte.')
      return
    }

    console.error('[check-dist-drift] DRIFT DETECTED between committed dist/ and a fresh build:')
    if (missingFromFresh.length > 0) {
      console.error(`  present in committed dist but missing from fresh build: ${missingFromFresh.join(', ')}`)
    }
    if (extraInFresh.length > 0) {
      console.error(`  present in fresh build but missing from committed dist: ${extraInFresh.join(', ')}`)
    }
    if (changed.length > 0) {
      console.error(`  content differs: ${changed.join(', ')}`)
    }
    console.error('Rebuild and recommit dashboard/app/dist (npm run build) before merging.')
    process.exitCode = 1
  } finally {
    fs.rmSync(scratchDir, { recursive: true, force: true })
  }
}

main()
