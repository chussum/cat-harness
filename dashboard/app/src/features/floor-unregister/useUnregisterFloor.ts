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
 * Never throws into the caller and never crashes the UI over a failed request.
 * A failed unregister leaves the floor exactly where it was — but, unlike the
 * earlier pure fire-and-forget version, it now ALSO reports the failure through
 * an optional `onError` callback so the UI can surface it (a silent swallow is
 * exactly why "폐업 눌러도 안 사라짐" looked like nothing happened when the
 * server was down/unreachable). `onError` is optional, so existing callers and
 * the success path are unchanged; console logging is preserved either way.
 */
import { useCallback } from 'react'

const UNREGISTER_URL = '/api/unregister'

export interface UseUnregisterFloorOptions {
  /** Called (best-effort) when the unregister request fails — non-OK HTTP or a rejected fetch. `reason` is a short human-readable cause. */
  onError?: (root: string, reason: string) => void
}

export interface UseUnregisterFloorResult {
  /** Asks the server to remove `root` from the registry; logs + reports (never throws) on failure. */
  unregister: (root: string) => void
}

export function useUnregisterFloor(options: UseUnregisterFloorOptions = {}): UseUnregisterFloorResult {
  const { onError } = options
  const unregister = useCallback(
    (root: string) => {
      fetch(UNREGISTER_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ root }),
      })
        .then((res) => {
          if (!res.ok) {
            console.error(`[floor-unregister] unregister failed for ${root}: HTTP ${res.status}`)
            onError?.(root, `HTTP ${res.status}`)
          }
        })
        .catch((err) => {
          console.error(`[floor-unregister] unregister request failed for ${root}:`, err)
          onError?.(root, err?.message ?? 'network error')
        })
    },
    [onError],
  )

  return { unregister }
}
