import { describe, it, expect } from 'vitest'
import { projectsToFloors, sidebarFloorOrder } from './model'
import type { ProjectSnapshot } from '@/shared/api/types'

function project(root: string, lit: boolean): ProjectSnapshot {
  return { root, lit, sessions: [] }
}

describe('projectsToFloors', () => {
  it('maps one floor per project, preserving order and index', () => {
    const floors = projectsToFloors([project('/a/b/proj-one', true), project('/x/proj-two', false)])
    expect(floors).toHaveLength(2)
    expect(floors[0]).toMatchObject({ index: 0, projectRoot: '/a/b/proj-one', projectName: 'proj-one', lit: true })
    expect(floors[1]).toMatchObject({ index: 1, projectRoot: '/x/proj-two', projectName: 'proj-two', lit: false })
  })

  it('returns an empty array for no registered projects', () => {
    expect(projectsToFloors([])).toEqual([])
  })
})

describe('sidebarFloorOrder', () => {
  it('reverses the floor order, so the scene-bottom floor (floors[0], 1층) ends up LAST in the sidebar list', () => {
    const floors = projectsToFloors([project('/1', true), project('/2', true), project('/3', true)])
    const ordered = sidebarFloorOrder(floors)
    expect(ordered.map((f) => f.projectRoot)).toEqual(['/3', '/2', '/1'])
    // floors[0] (1층, the scene's bottom floor via office-scene's
    // flex-col-reverse) is now the sidebar's LAST (bottom) row.
    expect(ordered[ordered.length - 1].projectRoot).toBe(floors[0].projectRoot)
    // floors[floors.length-1] (the highest floor, the scene's TOP floor) is
    // now the sidebar's FIRST (top) row.
    expect(ordered[0].projectRoot).toBe(floors[floors.length - 1].projectRoot)
  })

  it('does not mutate the input array', () => {
    const floors = projectsToFloors([project('/1', true), project('/2', true)])
    const original = [...floors]
    sidebarFloorOrder(floors)
    expect(floors).toEqual(original)
  })

  it('returns an empty array for no floors', () => {
    expect(sidebarFloorOrder([])).toEqual([])
  })
})
