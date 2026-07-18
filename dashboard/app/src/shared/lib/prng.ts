/**
 * shared/lib/prng.ts — a tiny deterministic pseudo-random generator (no
 * external dependency) used to seed stable-but-varied room layouts (toy
 * props) from a string key, so re-renders of the same floor don't jitter
 * its toys around.
 */

/** FNV-1a-style string hash -> unsigned 32-bit seed. */
export function hashStringToSeed(input: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

/** mulberry32: a small, fast, deterministic PRNG. Returns a generator producing floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return function next() {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Convenience: a deterministic rng generator seeded from an arbitrary string key. */
export function rngFromKey(key: string): () => number {
  return mulberry32(hashStringToSeed(key))
}
