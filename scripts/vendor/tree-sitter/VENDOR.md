# Vendored Tree-sitter runtime

This directory vendors a pinned, prebuilt Tree-sitter WASM runtime so that
`scripts/cat-state.mjs`'s `graph build` / `graph query` subcommands can parse
JS/TS/TSX without any install step at plugin-clone time. Nothing here is a
`node_modules` directory and nothing here is generated at install/build time —
every file below is committed as-is and loaded by **relative path** from
`scripts/cat-state.mjs` (never by bare package name), so Node's ESM package
resolution never needs a `node_modules` tree to find it.

## Source packages and exact versions vendored

| Vendored file | Source npm package | Package version | Upstream file |
|---|---|---|---|
| `tree-sitter.js` | `web-tree-sitter` | `0.24.7` | `tree-sitter.js` |
| `tree-sitter.wasm` | `web-tree-sitter` | `0.24.7` | `tree-sitter.wasm` |
| `tree-sitter-web.d.ts` | `web-tree-sitter` | `0.24.7` | `tree-sitter-web.d.ts` (types only, not imported at runtime; kept as API reference) |
| `LICENSE.web-tree-sitter` | `web-tree-sitter` | `0.24.7` | `LICENSE` (MIT) |
| `grammars/tree-sitter-javascript.wasm` | `tree-sitter-wasms` | `0.1.13` | `out/tree-sitter-javascript.wasm` |
| `grammars/tree-sitter-typescript.wasm` | `tree-sitter-wasms` | `0.1.13` | `out/tree-sitter-typescript.wasm` |
| `grammars/tree-sitter-tsx.wasm` | `tree-sitter-wasms` | `0.1.13` | `out/tree-sitter-tsx.wasm` |
| `LICENSE.tree-sitter-wasms` | `tree-sitter-wasms` | `0.1.13` | `LICENSE` (Unlicense) |

Both packages were fetched via `npm pack <name>@<version>` (registry tarball,
no git clone) and the listed files extracted from the tarball's `package/`
directory. No other files from either tarball are vendored.

## IMPORTANT: why `web-tree-sitter@0.24.7`, not the "latest" `0.26.11`

The initial vendoring spike (see plan's "벤더링 메커니즘 스파이크" gate) tried the
literal latest `web-tree-sitter@0.26.11` against the `tree-sitter-wasms@0.1.13`
grammar files (the only version of that package that exists on the registry).
Loading failed at `Language.load()`:

```
Error: need dylink section
    at failIf (.../web-tree-sitter.js:1927:28)
    at getDylinkMetadata (.../web-tree-sitter.js:1944:7)
    at Object.loadWebAssemblyModule (.../web-tree-sitter.js:2268:20)
    at Language.load (.../web-tree-sitter.js:1506:25)
```

Root cause: `web-tree-sitter` `>=0.25.0` moved to Tree-sitter's WASM **dynamic
linking** ABI and requires grammar `.wasm` files to carry a `dylink.0` custom
section (i.e. built as an Emscripten side module with a modern `tree-sitter
build --wasm`). `tree-sitter-wasms@0.1.13` — the only published version —
was built with `tree-sitter-cli@^0.20.8` (see its `package.json`
`devDependencies`), which predates that ABI and produces statically-linked
grammar `.wasm` files with no `dylink.0` section. There is no newer
`tree-sitter-wasms` release that rebuilds the grammars against the new ABI, so
`0.26.11` cannot load these grammar files at all.

Fix: pin `web-tree-sitter` to `0.24.7` (the last `0.24.x` release), the newest
version that still uses the pre-dynamic-linking loader and accepts
statically-linked grammar `.wasm` files. Verified working end-to-end: JS, TS,
and TSX grammars all load and parse correctly under `web-tree-sitter@0.24.7` +
`tree-sitter-wasms@0.1.13` on Node 22.22.3 (spike transcript captured in the
implementing executor's evidence — grep this repo's PR/goal history for
"FINAL SPIKE OK").

### 0.24.x API shape actually used (differs from 0.20.x and 0.26.x)

```js
import path from "node:path";
import { fileURLToPath } from "node:url";

const vendorDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "vendor", "tree-sitter");
const { default: Parser } = await import(path.join(vendorDir, "tree-sitter.js"));
await Parser.init({ locateFile: (name) => path.join(vendorDir, name) });
const Language = Parser.Language; // static property, NOT a separate named export
const lang = await Language.load(path.join(vendorDir, "grammars", "tree-sitter-javascript.wasm"));
const parser = new Parser();
parser.setLanguage(lang);
const tree = parser.parse(sourceText);
```

Notes:
- `tree-sitter.js` is a CommonJS/UMD bundle (`module.exports = TreeSitter`),
  so it must be imported via its **default** export from ESM
  (`import Parser from "./tree-sitter.js"`), not named imports.
  `Parser.Language` is a static property set on the exported class, not a
  separate module export (this differs from the `web-tree-sitter@0.26.x`
  `import {Parser, Language} from ...` named-export shape documented
  upstream for the newer major).
- `Language.load()` accepts either a filesystem path (Node) or a byte buffer.
- Always import by **relative path resolved from `import.meta.url`**, not
  from `process.cwd()` — this makes the load independent of the caller's
  working directory or the plugin cache's on-disk layout.

## Byte sizes (measured, this vendoring)

| File | Bytes |
|---|---|
| `tree-sitter.js` | 164858 |
| `tree-sitter.wasm` | 190779 |
| `tree-sitter-web.d.ts` | 7790 |
| `LICENSE.web-tree-sitter` | 1085 |
| `LICENSE.tree-sitter-wasms` | 1211 |
| `grammars/tree-sitter-javascript.wasm` | 647334 |
| `grammars/tree-sitter-typescript.wasm` | 2342690 |
| `grammars/tree-sitter-tsx.wasm` | 2411272 |
| **Total** | **5767019 (~5.5 MiB)** |

## sha256 (measured, this vendoring — `shasum -a 256 <file>`)

| File | sha256 |
|---|---|
| `tree-sitter.js` | `46f3e24433243260a7224af2b409753744a54b5fc4e69235db8701f4f47b326b` |
| `tree-sitter.wasm` | `70aa2b222e10a91306a85f5b9c8e028e3dc09943854aa63640c643fc7e051c2f` |
| `tree-sitter-web.d.ts` | `1df6281845b7e9db681fdc8b238d25b507c0e2457cb2b61c5cea2468be221ac7` |
| `LICENSE.web-tree-sitter` | `5f9cf9fb6acb1972b35ae29119ce563bb60ec097656bc4b69b9bac2d04c7a147` |
| `LICENSE.tree-sitter-wasms` | `6b0382b16279f26ff69014300541967a356a666eb0b91b422f6862f6b7dad17e` |
| `grammars/tree-sitter-javascript.wasm` | `63812b9e275d26851264734868d27a1656bd44a2ef6eb3e85e6b03728c595ab5` |
| `grammars/tree-sitter-typescript.wasm` | `8515404dceed38e1ed86aa34b09fcf3379fff1b4ff9dd3967bcd6d1eb5ac3d8f` |
| `grammars/tree-sitter-tsx.wasm` | `6aa3b2c70e76f5d48eafef1093e9c4de383e13f2fdde2f4e9b98a378f6a8f1b6` |

## License

Both source packages are MIT-licensed upstream:
- `web-tree-sitter` (part of the `tree-sitter` project) — MIT, see
  `LICENSE.web-tree-sitter`.
- `tree-sitter-wasms` package itself is Unlicense (see
  `LICENSE.tree-sitter-wasms`); the individual grammar sources it bundles
  (`tree-sitter-javascript`, `tree-sitter-typescript`) are themselves MIT.

Both licenses are compatible with this repository's MIT license. No
attribution beyond these committed LICENSE copies is required.

## Known limitation: occasional spurious `hasError` on large real-world files

`graph build` was observed to mark this repository's own `scripts/cat-state.mjs`
(>70 KiB, well past 1800 lines) `parse_status: "partial"` even though the file
is fully valid JS (`node --check` passes cleanly, and V8 executes it without
issue). Bisecting confirmed the spurious `ERROR` node's *reported* line
number does not correspond to any real syntax problem at that location —
isolating every construct near the reported offset (nullish coalescing,
optional chaining, template literals with multiple `${}` interpolations,
regex literals including an empty-alternative group) in a standalone snippet
reparses cleanly. This reproduces specifically on the full file's cumulative
parser state past roughly the 65–70 KiB mark and is most likely a latent
lexer/parser-state limitation in this vendored `web-tree-sitter@0.24.7` core
build itself (an old, pre-dynamic-linking build), not a defect in the
extraction logic in `scripts/cat-state.mjs`.

Impact is bounded by design: `graph build` never crashes on this — it
records `parse_status: "partial"` for the affected file and keeps whatever
nodes/edges it managed to extract (empirically, extraction still reached
nodes as late as line 2497 of a 2546-line file — the vast majority of the
file's real content). Contributors re-vendoring to a newer `web-tree-sitter`
in the future (once `tree-sitter-wasms`, or an alternative grammar source,
ships ABI-compatible grammar `.wasm` files) should re-run `graph build` over
this repository itself and confirm `parse_status` for
`scripts/cat-state.mjs` reads `"ok"`, not `"partial"`, as a regression check
on this specific limitation.

## Contributor-only: how to re-vendor / bump versions

**End users never need to run this.** This is only for a maintainer updating
the pinned snapshot.

1. In a scratch directory (NOT this repo, NOT anywhere under `node_modules`):
   ```sh
   npm pack web-tree-sitter@<version> tree-sitter-wasms@<version>
   ```
2. Extract each tarball (`tar -xzf <pkg>.tgz`) — files land under
   `package/`.
3. Before adopting a newer `web-tree-sitter`, verify it can still load the
   `tree-sitter-wasms` grammar files you intend to ship — run a throwaway
   script that does `Parser.init()` → `Language.load(path-to-grammar.wasm)`
   → `parser.parse("const x = 1;")` and confirm it returns a `program` root
   node with no `dylink` error. If `tree-sitter-wasms` has not been rebuilt
   against the newer ABI, you may need to stay on `web-tree-sitter@0.24.x`
   (as this vendoring currently does) or source grammar `.wasm` files built
   with a matching modern `tree-sitter build --wasm` toolchain instead.
4. Copy the loader (`tree-sitter.js`), the core runtime (`tree-sitter.wasm`),
   and the type declarations into this directory (overwrite in place); copy
   the three grammar `.wasm` files into `grammars/`; copy both `LICENSE`
   files, renamed as above.
5. Recompute every sha256 and byte size (`shasum -a 256 <file>`,
   `stat -f%z <file>` on macOS / `stat -c%s <file>` on Linux) and update the
   two tables above with the new measured values — never hand-wave these,
   they must be exact for the file actually committed.
6. Re-run `node --test scripts/cat-state.test.mjs` on Node 22.13.0+ to
   confirm the new snapshot still passes the graph build/query tests before
   committing.
