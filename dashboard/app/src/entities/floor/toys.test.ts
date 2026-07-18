import { describe, it, expect } from 'vitest'
import { toyCountForCats, layoutToys, MAX_TOYS, TOY_KINDS } from './toys'
import { ROOM_BOUNDS } from '@/entities/cat/wander'

describe('toyCountForCats', () => {
  it('mirrors the cat count under the cap', () => {
    expect(toyCountForCats(0)).toBe(0)
    expect(toyCountForCats(3)).toBe(3)
  })

  it('caps at MAX_TOYS for a very busy floor', () => {
    expect(toyCountForCats(20)).toBe(MAX_TOYS)
  })

  it('never goes negative', () => {
    expect(toyCountForCats(-1)).toBe(0)
  })
})

describe('layoutToys', () => {
  it('returns exactly `count` toys', () => {
    expect(layoutToys('/projects/alpha', 4)).toHaveLength(4)
  })

  it('is deterministic for the same seed key', () => {
    expect(layoutToys('/projects/alpha', 3)).toEqual(layoutToys('/projects/alpha', 3))
  })

  it('differs across floors (seed keys)', () => {
    const a = layoutToys('/projects/alpha', 3)
    const b = layoutToys('/projects/beta', 3)
    expect(a).not.toEqual(b)
  })

  it('cycles through every toy kind and keeps every toy within the room bounds', () => {
    const toys = layoutToys('/projects/alpha', 6, ROOM_BOUNDS, 14)
    expect(new Set(toys.map((t) => t.kind))).toEqual(new Set(TOY_KINDS))
    for (const toy of toys) {
      expect(toy.x).toBeGreaterThanOrEqual(14)
      expect(toy.x).toBeLessThanOrEqual(86)
      expect(toy.y).toBeGreaterThanOrEqual(14)
      expect(toy.y).toBeLessThanOrEqual(86)
    }
  })

  it('returns [] for a zero count', () => {
    expect(layoutToys('/projects/alpha', 0)).toEqual([])
  })
})
