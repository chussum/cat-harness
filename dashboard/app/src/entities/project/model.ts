/**
 * entities/project — pure derivations over a ProjectSnapshot (no React).
 */
import type { ProjectSnapshot } from '@/shared/api/types'

/** Last path segment as a friendly display name; falls back to the full root. */
export function projectDisplayName(root: string): string {
  const parts = root.split(/[\\/]/).filter(Boolean)
  return parts.length > 0 ? parts[parts.length - 1] : root
}

export function activeGoalCount(project: ProjectSnapshot): number {
  let count = 0
  for (const session of project.sessions) {
    const goals = session.goals?.goals ?? []
    count += goals.filter((g) => g.status !== 'complete' && g.status !== 'cancelled').length
  }
  return count
}

export function totalGoalCount(project: ProjectSnapshot): number {
  let count = 0
  for (const session of project.sessions) {
    count += session.goals?.goals?.length ?? 0
  }
  return count
}
