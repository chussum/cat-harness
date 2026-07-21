# Vendored sql.js (WASM SQLite) runtime

This directory vendors a pinned, prebuilt sql.js (SQLite compiled to
WebAssembly) build so that `scripts/cat-state.mjs`'s `graph build` /
`graph query` subcommands can open, query, and write a real SQLite file
**without `node:sqlite`** (an experimental built-in that only ships unflagged
on Node 22.13.0+) and **without any install step at plugin-clone time**.
Nothing here is a `node_modules` directory and nothing here is generated at
install/build time — every file below is committed as-is and loaded by
**relative path** from `scripts/cat-state.mjs` (never by bare package name,
never via `require`), the exact same vendoring pattern already established by
`scripts/vendor/tree-sitter/` (see that directory's `VENDOR.md`).

## Source package and exact version vendored

| Vendored file | Source npm package | Package version | Upstream file |
|---|---|---|---|
| `sql-wasm.js` | `sql.js` | `1.14.1` | `dist/sql-wasm.js` |
| `sql-wasm.wasm` | `sql.js` | `1.14.1` | `dist/sql-wasm.wasm` |
| `LICENSE` | `sql.js` | `1.14.1` | `LICENSE` (MIT) |

Fetched via `npm pack sql.js@1.14.1` (registry tarball, no git clone) and the
listed files extracted from the tarball's `package/` directory. No other
files from the tarball are vendored — in particular, none of the `asm.js`
fallback builds (`sql-asm*.js`, multi-MB pure-JS builds for environments
without WebAssembly), the browser-specific bundles (`sql-wasm-browser*`), the
debug builds (`*-debug.js`), or the Web Worker wrapper (`worker.sql-wasm.js`)
are included — this runtime only ever runs inside a Node.js CLI process
(`cat-state.mjs`), never a browser or a Worker, and Node's `WebAssembly`
global has been available since Node 8, so the plain WASM build is both the
smallest and the most direct fit (no asm.js fallback needed).

## Why WASM (`sql-wasm.js`), not asm.js (`sql-asm.js`)

`sql-asm.js` exists so sql.js can run in JS engines with no `WebAssembly`
support at all — it embeds the entire SQLite C library recompiled to plain
asm.js and is ~1.3–5.6MB depending on build flavor. `cat-state.mjs` already
requires Node 18+ elsewhere in this plugin (and vendors a second WASM runtime,
web-tree-sitter, for the same graph feature), so `WebAssembly` is guaranteed
present; there is no environment this plugin ever runs in where the asm.js
fallback would be needed. `sql-wasm.js` is smaller (46.4KB loader + 660KB
`.wasm` vs. asm.js's multi-MB single file) and is the officially recommended
default distribution for Node/CLI consumers per the sql.js README.

## Load spike (Step 0 gate) — proven on Node 18/20/22

Mirrors `loadGraphParser()`'s `import.meta.url`-relative pattern exactly:

```js
import path from "node:path";
import { fileURLToPath } from "node:url";

const vendorDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "vendor", "sql.js");
const { default: initSqlJs } = await import(path.join(vendorDir, "sql-wasm.js"));
const SQL = await initSqlJs({ locateFile: (file) => path.join(vendorDir, file) });

const db = new SQL.Database(); // or new SQL.Database(existingBytes) to reopen a saved DB
db.run("CREATE TABLE t (a TEXT, b INTEGER)");
db.run("INSERT INTO t (a, b) VALUES (?, ?)", ["hello", 42]);
const stmt = db.prepare("SELECT a, b FROM t WHERE b = ?");
stmt.bind([42]);
while (stmt.step()) stmt.getAsObject(); // { a: "hello", b: 42 }
stmt.free();
const bytes = db.export(); // Uint8Array — write to disk with fs.writeFileSync
db.close();
```

Spike transcript (scratch script `sqljs-spike.mjs`, run against this vendored
directory, three separate `node` binaries — `initSqlJs` load time is the
one-time WASM instantiate cost, distinct per-process since sql.js has no
cross-process cache):

```
$ node --version                                    # v20.15.1 (this repo's default)
$ node sqljs-spike.mjs scripts/vendor/sql.js
{"node":"v20.15.1","ok":true,"init_ms":12,"rows":[{"a":"hello","b":42}],"exported_bytes":8192}

$ $HOME/.nvm/versions/node/v18.19.1/bin/node sqljs-spike.mjs scripts/vendor/sql.js
{"node":"v18.19.1","ok":true,"init_ms":26,"rows":[{"a":"hello","b":42}],"exported_bytes":8192}

$ $HOME/.nvm/versions/node/v22.22.3/bin/node sqljs-spike.mjs scripts/vendor/sql.js
{"node":"v22.22.3","ok":true,"init_ms":23,"rows":[{"a":"hello","b":42}],"exported_bytes":8192}
```

All three: table create, parameterized insert, parameterized select round-trip
(`{a: "hello", b: 42}`), and `.export()` all succeeded — no `dylink`-style ABI
failure (the class of bug that forced the tree-sitter vendoring to pin an
older `web-tree-sitter`; sql.js 1.14.1 has no such issue since it is a single
self-contained WASM module, not a dynamically-linked side module).

## `GRAPH_LOCK_TTL_MS` derivation (measured, not guessed)

The create-arbitrated lock's staleness window must be long enough that a
**live** `graph build` process never has its lock reclaimed out from under it,
while still being short enough that a **crashed** process's dead lock doesn't
block builds indefinitely.

Baseline measurement: this repository's full (non-`--changed-only`)
`graph build` — same parsing pipeline (vendored Tree-sitter, `extractGraphFacts`)
that carries over unchanged into the sql.js storage engine, so this wall-clock
number is a valid proxy for the sql.js path's cost too (SQLite file I/O is a
small fraction of total time next to parsing) — measured via `time`, Node
22.22.3, `node:sqlite` engine, 4 tracked JS/TS/TSX files, warm and cold runs:

```
$ time node scripts/cat-state.mjs graph build --session timing-spike
... 0.350s total (cold)
... 0.206s total (warm)
```

This repository is small (4 scanned files); `GRAPH_LOCK_TTL_MS` must also
hold for much larger monorepos this plugin runs in. Derivation:
`max(measured_full_build_ms * 10, 60000)`. With `measured_full_build_ms ≈ 400`,
`400 * 10 = 4000`, so the 60000ms floor wins here — **`GRAPH_LOCK_TTL_MS =
60000`** (60s) is the shipped default. The 10x multiplier and 60s floor are
both safety headroom, not a hard ceiling: any repository whose real full build
legitimately exceeds 6 seconds (60000 / 10) can override via the
`CAT_GRAPH_LOCK_TTL_MS` environment variable without a code change. STALE
detection is additionally double-gated by `process.kill(pid, 0)` (ESRCH ⇒
reclaim immediately, no TTL wait needed) — the TTL only matters for a holder
whose PID has been *reused* by a different live process after a crash, which
neither `kill(pid,0)` nor the TTL alone could distinguish; the 60s floor
trades a small amount of extra wait in that rare case for headroom against a
legitimately slow build being misjudged as dead.

## Concurrency: this scopes to LOCAL filesystems only

The create-arbitrated lock (`acquireGraphLock`/`releaseGraphLock` in
`cat-state.mjs`) depends on two POSIX atomicity guarantees: exclusive create
(`open(..., O_EXCL)`, the `wx` flag) always fails with `EEXIST` if the target
already exists, and `rename()` of the lock file itself is atomic with respect
to concurrent renames of the same path. **Both guarantees hold on local
(APFS/ext4/NTFS-local) filesystems but are NOT guaranteed by every network
filesystem** (notably some NFS configurations, where `O_EXCL` créate is a
well-known historical trouble spot, and some SMB/CIFS setups). `.cat/graph/`
is expected to live on the same local filesystem as the rest of the working
tree in every supported deployment of this plugin (a single developer's
checkout or a single CI runner's workspace) — this is a single-consumer
guarantee scoped to local filesystems, not a distributed lock service.
Running `.cat/` on a shared network mount accessed by multiple concurrent
hosts is out of scope and not supported.

## Byte sizes (measured, this vendoring)

| File | Bytes |
|---|---|
| `sql-wasm.js` | 46406 |
| `sql-wasm.wasm` | 659730 |
| `LICENSE` | 2199 |
| **Total** | **708335 (~692 KiB)** |

## sha256 (measured, this vendoring — `shasum -a 256 <file>`)

| File | sha256 |
|---|---|
| `sql-wasm.js` | `77d6435bac506af0e3c59636dce9d22b1b14156348bc327f41a1577f3212360f` |
| `sql-wasm.wasm` | `438c88f666dc054ce4e9395f80fe9db4218b1a3c379960454880f048a7898aed` |
| `LICENSE` | `60a3f6e4d7b29b4321359e683b36cf198d24f58e24582070f56e6fa89d5ee2be` |

## License

`sql.js` is MIT-licensed upstream (see `LICENSE`, copyright sql.js authors).
Compatible with this repository's MIT license; no attribution beyond this
committed `LICENSE` copy is required. `sql.js` itself wraps the public-domain
SQLite amalgamation compiled via Emscripten.

## Contributor-only: how to re-vendor / bump versions

**End users never need to run this.** This is only for a maintainer updating
the pinned snapshot.

1. In a scratch directory (NOT this repo, NOT anywhere under `node_modules`):
   ```sh
   npm pack sql.js@<version>
   tar -xzf sql.js-<version>.tgz   # extracts to package/
   ```
2. Copy `package/dist/sql-wasm.js`, `package/dist/sql-wasm.wasm`, and
   `package/LICENSE` into this directory (overwrite in place). Do not vendor
   any other file from the tarball (see "Source package" note above on why
   the asm.js/browser/debug/worker builds are intentionally excluded).
3. Before adopting a newer `sql.js`, re-run the load spike (`sqljs-spike.mjs`
   pattern above) against the new `sql-wasm.js`/`sql-wasm.wasm` pair on every
   Node version this plugin supports (18.x floor, current default, current
   latest) — confirm `CREATE TABLE` / parameterized `INSERT` / parameterized
   `SELECT` / `.export()` all succeed with no load error.
4. Recompute every sha256 and byte size (`shasum -a 256 <file>`,
   `stat -f%z <file>` on macOS / `stat -c%s <file>` on Linux) and update the
   two tables above with the new measured values — never hand-wave these,
   they must be exact for the file actually committed.
5. Re-run `node --test scripts/cat-state.test.mjs` (Node 18+, no floor gate
   needed anymore) to confirm the new snapshot still passes the graph
   build/query tests before committing.
