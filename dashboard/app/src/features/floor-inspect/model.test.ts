import { describe, it, expect } from 'vitest'
import { INITIAL_SELECTION, isFloorSelected, selectFloor } from './model'

describe('floor-inspect selection', () => {
  it('selecting a floor sets its project root and clears any cat selection', () => {
    const withCat = { projectRoot: '/a', catId: 'x' }
    expect(selectFloor(withCat, '/b')).toEqual({ projectRoot: '/b', catId: null })
  })

  it('isFloorSelected reflects the current selection', () => {
    expect(isFloorSelected(INITIAL_SELECTION, '/a')).toBe(false)
    expect(isFloorSelected({ projectRoot: '/a', catId: null }, '/a')).toBe(true)
  })
})
