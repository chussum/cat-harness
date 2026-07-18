/**
 * features/cat-inspect — clicking a cat selects both its project (so the side
 * panel opens) and the cat itself (so the panel can highlight/scroll to its
 * dialogue thread). Pure reducer, no React.
 */
import type { Selection } from '@/features/floor-inspect/model'

export function selectCat(_selection: Selection, projectRoot: string, catId: string): Selection {
  return { projectRoot, catId }
}

export function isCatSelected(selection: Selection, catId: string): boolean {
  return selection.catId === catId
}
