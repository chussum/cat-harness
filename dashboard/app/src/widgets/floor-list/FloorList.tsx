/**
 * widgets/floor-list/FloorList.tsx — compact nav list of every registered
 * project/floor, for quickly jumping the selection without scrolling the scene.
 */
import { cn } from '@/shared/lib/cn'
import { Badge } from '@/shared/ui/Badge'
import { useI18n } from '@/shared/i18n/LanguageProvider'
import { sidebarFloorOrder, type Floor } from '@/entities/floor/model'

export interface FloorListProps {
  floors: Floor[]
  selectedProjectRoot: string | null
  onSelect: (projectRoot: string) => void
}

export function FloorList({ floors, selectedProjectRoot, onSelect }: FloorListProps) {
  const { t } = useI18n()
  // Same vertical order as the scene (its bottom floor is this list's bottom
  // row too) — see entities/floor/model.ts's `sidebarFloorOrder`. A "폐업
  // 처리"-d (closed) floor is now a REAL server-side unregister
  // (features/floor-unregister), so it simply stops being registered — no
  // client-side hidden set, and so no restore affordance here anymore.
  const orderedFloors = sidebarFloorOrder(floors)
  return (
    <nav className="flex w-56 shrink-0 flex-col overflow-y-auto border-r border-zinc-800 bg-zinc-950 p-2" data-testid="floor-list">
      <p className="mb-2 px-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">{t('floorList.header')}</p>
      <ul className="space-y-1">
        {orderedFloors.map((floor) => (
          <li key={floor.id}>
            <button
              type="button"
              onClick={() => onSelect(floor.projectRoot)}
              className={cn(
                'flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-sm text-zinc-300 hover:bg-zinc-800',
                selectedProjectRoot === floor.projectRoot && 'bg-zinc-800 text-zinc-100',
              )}
            >
              <span className="truncate">{floor.projectName}</span>
              <Badge variant={floor.lit ? 'success' : 'outline'} className="ml-2 shrink-0">
                {floor.lit ? t('status.lit') : t('status.dormant')}
              </Badge>
            </button>
          </li>
        ))}
        {floors.length === 0 && <li className="px-2 text-xs text-zinc-600">{t('floorList.noProjects')}</li>}
      </ul>
    </nav>
  )
}
