/**
 * widgets/office-scene/OfficeScene.tsx — the pixel-cat "software tycoon" office:
 * the building grows one top-down ROOM per registered project
 * (entities/floor/ui.tsx), where cats for its active skill + recent
 * sub-agents wander and their dialogue drives speech bubbles.
 */
import { FloorRow } from '@/entities/floor/ui'
import { sessionsToCats } from '@/entities/cat/model'
import type { Floor } from '@/entities/floor/model'
import { useI18n } from '@/shared/i18n/LanguageProvider'

export interface OfficeSceneProps {
  floors: Floor[]
  selectedProjectRoot: string | null
  selectedCatId: string | null
  onSelectFloor: (projectRoot: string) => void
  onSelectCat: (projectRoot: string, catId: string) => void
  /** "폐업 처리" (close/retire) a floor — a REAL server-side unregister, see features/floor-unregister, wired in by pages/dashboard/DashboardPage.tsx. Only ever fires for a floor currently rendered here (i.e. still registered). */
  onDismissFloor: (projectRoot: string) => void
}

export function OfficeScene({ floors, selectedProjectRoot, selectedCatId, onSelectFloor, onSelectCat, onDismissFloor }: OfficeSceneProps) {
  const { t } = useI18n()
  return (
    <div className="flex-1 overflow-y-auto" data-testid="office-scene">
      <div className="border-b border-zinc-800 bg-gradient-to-b from-zinc-900 to-transparent px-4 py-2 text-xs text-zinc-500">
        {t('office.title', { count: floors.length })}
      </div>
      <div className="flex flex-col-reverse">
        {floors.map((floor) => (
          <FloorRow
            key={floor.id}
            floor={floor}
            cats={sessionsToCats(floor.project.sessions)}
            selected={selectedProjectRoot === floor.projectRoot}
            selectedCatId={selectedProjectRoot === floor.projectRoot ? selectedCatId : null}
            onSelectFloor={() => onSelectFloor(floor.projectRoot)}
            onSelectCat={(catId) => onSelectCat(floor.projectRoot, catId)}
            onDismiss={() => onDismissFloor(floor.projectRoot)}
          />
        ))}
        {floors.length === 0 && <div className="p-8 text-center text-sm text-zinc-600">{t('office.noProjects')}</div>}
      </div>
    </div>
  )
}
