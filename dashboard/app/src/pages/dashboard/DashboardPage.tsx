/**
 * pages/dashboard/DashboardPage.tsx — composition root: SSE feed -> floors ->
 * office scene + floor list + side panel, wired to the floor-inspect/cat-inspect
 * selection features and the scene-controls chrome.
 */
import { useMemo, useState } from 'react'
import { useSse } from '@/shared/api/useSse'
import { useI18n } from '@/shared/i18n/LanguageProvider'
import { projectsToFloors } from '@/entities/floor/model'
import { ConnectionBadge, LanguageToggle, LegendToggle } from '@/features/scene-controls/ui'
import { INITIAL_SELECTION, selectFloor, type Selection } from '@/features/floor-inspect/model'
import { selectCat } from '@/features/cat-inspect/model'
import { useUnregisterFloor } from '@/features/floor-unregister/useUnregisterFloor'
import { OfficeScene } from '@/widgets/office-scene/OfficeScene'
import { FloorList } from '@/widgets/floor-list/FloorList'
import { SidePanel } from '@/widgets/side-panel/SidePanel'

const STREAM_URL = '/api/stream'

export function DashboardPage() {
  const { snapshot, connectionState } = useSse(STREAM_URL)
  const { t } = useI18n()
  const [selection, setSelection] = useState<Selection>(INITIAL_SELECTION)

  const floors = useMemo(() => projectsToFloors(snapshot?.projects ?? []), [snapshot])

  // "폐업 처리" (close/retire) a DORMANT floor — a REAL server-side
  // unregister (features/floor-unregister), not a client-side view filter:
  // the server removes the root from the home registry and every connected
  // client (including this one) drops the floor via the SSE `removed` event
  // (shared/api/sseClient.ts's `reduceRemoved`), so `floors` itself is
  // already the right list to render — no separate "shown" filtering needed.
  const { unregister } = useUnregisterFloor()

  const selectedProject = floors.find((f) => f.projectRoot === selection.projectRoot)?.project ?? null

  function handleSelectFloor(projectRoot: string) {
    setSelection((prev) => selectFloor(prev, projectRoot))
  }

  // Sidebar-only: in addition to the normal select-floor behavior above,
  // scroll the scene so the clicked floor's room is actually in view — the
  // scene can be much taller than the viewport, so picking a floor from the
  // FLOORS list wouldn't otherwise bring it on screen. Wired via the room's
  // own `id` (entities/floor/ui.tsx's `floor-room-${floor.id}`, floor.id ===
  // its project root) rather than a ref threaded across widgets, since
  // FloorList and OfficeScene are unrelated sibling trees under this page.
  function handleSelectFloorFromSidebar(projectRoot: string) {
    handleSelectFloor(projectRoot)
    const room = document.getElementById(`floor-room-${projectRoot}`)
    if (room && typeof room.scrollIntoView === 'function') {
      room.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
  }

  function handleSelectCat(projectRoot: string, catId: string) {
    setSelection((prev) => selectCat(prev, projectRoot, catId))
  }

  // Unregistering the currently-inspected floor would otherwise leave the
  // side panel open on a project no longer visible anywhere — clear the
  // selection along with the unregister request.
  function handleDismissFloor(projectRoot: string) {
    unregister(projectRoot)
    setSelection((prev) => (prev.projectRoot === projectRoot ? INITIAL_SELECTION : prev))
  }

  return (
    <div className="flex h-full flex-col bg-zinc-950 text-zinc-100">
      <header className="flex items-center justify-between border-b border-zinc-800 px-4 py-2">
        <h1 className="text-sm font-semibold tracking-wide text-zinc-100">{t('header.title')}</h1>
        <div className="flex items-center gap-2">
          <ConnectionBadge state={connectionState} />
          <LegendToggle />
          <LanguageToggle />
        </div>
      </header>
      <div className="flex min-h-0 flex-1">
        <FloorList
          floors={floors}
          selectedProjectRoot={selection.projectRoot}
          onSelect={handleSelectFloorFromSidebar}
        />
        <OfficeScene
          floors={floors}
          selectedProjectRoot={selection.projectRoot}
          selectedCatId={selection.catId}
          onSelectFloor={handleSelectFloor}
          onSelectCat={handleSelectCat}
          onDismissFloor={handleDismissFloor}
        />
        <SidePanel
          project={selectedProject}
          highlightRoundTripId={null}
          onClose={() => setSelection(INITIAL_SELECTION)}
        />
      </div>
    </div>
  )
}
