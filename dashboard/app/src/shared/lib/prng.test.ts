import { describe, it, expect } from 'vitest'
import { hashStringToSeed, mulberry32, rngFromKey } from './prng'

describe('hashStringToSeed', () => {
  it('is deterministic for the same input', () => {
    expect(hashStringToSeed('/projects/alpha')).toBe(hashStringToSeed('/projects/alpha'))
  })

  it('differs for different inputs', () => {
    expect(hashStringToSeed('/projects/alpha')).not.toBe(hashStringToSeed('/projects/beta'))
  })

  it('returns a non-negative 32-bit integer', () => {
    const seed = hashStringToSeed('anything')
    expect(Number.isInteger(seed)).toBe(true)
    expect(seed).toBeGreaterThanOrEqual(0)
    expect(seed).toBeLessThan(2 ** 32)
  })
})

describe('mulberry32', () => {
  it('produces the same sequence for the same seed', () => {
    const a = mulberry32(42)
    const b = mulberry32(42)
    expect([a(), a(), a()]).toEqual([b(), b(), b()])
  })

  it('produces a different sequence for a different seed', () => {
    const a = mulberry32(1)
    const b = mulberry32(2)
    expect(a()).not.toBe(b())
  })

  it('stays within [0, 1)', () => {
    const rng = mulberry32(7)
    for (let i = 0; i < 50; i++) {
      const value = rng()
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThan(1)
    }
  })
})

describe('rngFromKey', () => {
  it('is deterministic per key', () => {
    const seq = (key: string) => {
      const rng = rngFromKey(key)
      return [rng(), rng(), rng()]
    }
    expect(seq('/projects/alpha')).toEqual(seq('/projects/alpha'))
  })

  it('differs across keys', () => {
    expect(rngFromKey('/projects/alpha')()).not.toBe(rngFromKey('/projects/beta')())
  })
})
