/**
 * features/floor-unregister/useUnregisterFloor.ts — the thin fetch wiring for
 * "폐업 처리" (close/retire a DORMANT floor): calls the server's real
 * unregister endpoint (dashboard/server/server.mjs's `POST /api/unregister`),
 * which atomically removes the project root from the home
 * `~/.cat-harness/registry.json` (dashboard/server/registry.mjs's
 * `removeRegistryRoot`). On success the server broadcasts a `removed` SSE
 * event (shared/api/sseClient.ts's `reduceRemoved`), which drops the floor
 * for EVERY connected client — no client-side filtering or localStorage
 * needed, replacing the earlier localStorage-only dismiss
 * (`features/floor-dismiss`, batch 15). A project reappears automatically
 * the next time its hook re-registers it (its next cat-harness run), by
 * design — there is no "restore" affordance anymore because there is
 * nothing client-side left to restore.
 *
 * Fire-and-forget: this hook never throws into the caller and never crashes
 * the UI over a failed request — a failed unregister just leaves the floor
 * exactly where it was (see the assignment: "handle the fetch failure
 * gracefully").
 */
import { useCallback } from 'react'

const UNREGISTER_URL = '/api/unregister'

export interface UseUnregisterFloorResult {
  /** Asks the server to remove `root` from the registry; swallows/logs failures. */
  unregister: (root: string) => void
}

export function useUnregisterFloor(): UseUnregisterFloorResult {
  const unregister = useCallback((root: string) => {
    fetch(UNREGISTER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ root }),
    })
      .then((res) => {
        if (!res.ok) {
          console.error(`[floor-unregister] unregister failed for ${root}: HTTP ${res.status}`)
        }
      })
      .catch((err) => {
        console.error(`[floor-unregister] unregister request failed for ${root}:`, err)
      })
  }, [])

  return { unregister }
}
