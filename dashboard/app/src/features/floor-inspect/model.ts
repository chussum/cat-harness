/**
 * features/floor-inspect — clicking a floor selects its project for the side
 * panel (and clears any cat-specific selection, since it belongs to a
 * different floor now). Pure reducer, no React — see pages/dashboard for wiring.
 */
export interface Selection {
  projectRoot: string | null
  catId: string | null
}

export const INITIAL_SELECTION: Selection = { projectRoot: null, catId: null }

export function selectFloor(_selection: Selection, projectRoot: string): Selection {
  return { projectRoot, catId: null }
}

export function isFloorSelected(selection: Selection, projectRoot: string): boolean {
  return selection.projectRoot === projectRoot
}
