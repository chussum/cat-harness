/**
 * shared/api/useSse.ts — React binding for the SSE store (sseClient.ts) via
 * useSyncExternalStore, so consumers re-render exactly when snapshot or
 * connection state changes, with no local component state duplicating it.
 */
import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { createSseStore, type SseStore } from './sseClient'

export function useSse(url: string) {
  const store: SseStore = useMemo(() => createSseStore(url), [url])
  useEffect(() => () => store.close(), [store])

  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const connectionState = useSyncExternalStore(store.subscribe, store.getConnectionState)

  return { snapshot, connectionState }
}
