/**
 * entities/floor — one FLOOR per registered project (the office building grows a
 * floor per project). Pure snapshot -> floor-list mapping, no React.
 */
import type { ProjectSnapshot } from '@/shared/api/types'
import { projectDisplayName } from '@/entities/project/model'

export interface Floor {
  /** Stable id: the project root path (unique per registered project). */
  id: string
  index: number
  projectRoot: string
  projectName: string
  lit: boolean
  project: ProjectSnapshot
}

/** projects -> floors, floor 0 at the ground; order mirrors the snapshot's project order. */
export function projectsToFloors(projects: ProjectSnapshot[]): Floor[] {
  return projects.map((project, index) => ({
    id: project.root,
    index,
    projectRoot: project.root,
    projectName: projectDisplayName(project.root),
    lit: project.lit,
    project,
  }))
}

/**
 * Reorders `floors` for the sidebar FLOORS list (widgets/floor-list/FloorList.tsx)
 * so its BOTTOM item is the same project as the scene's bottom floor. The
 * office scene (widgets/office-scene/OfficeScene.tsx) renders floors in
 * array order inside a `flex-col-reverse` stack, so `floors[0]` (1층) ends
 * up at the scene's bottom and `floors[floors.length - 1]` (the highest
 * floor number) at its top. A plain top-to-bottom list rendered in that same
 * array order would show them in the OPPOSITE vertical order from the
 * scene — reversing here fixes it: the sidebar's first (top) row is the
 * highest floor, its last (bottom) row is `floors[0]`, matching the scene.
 */
export function sidebarFloorOrder(floors: Floor[]): Floor[] {
  return [...floors].reverse()
}
