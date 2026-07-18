/**
 * shared/api/sseClient.ts — SSE client for /api/stream: connects with
 * EventSource, applies `snapshot` (full replace), `delta` (per-project
 * merge), and `removed` (per-project drop — the server-side "폐업 처리"
 * unregister, features/floor-unregister/useUnregisterFloor.ts, lands here
 * for every OTHER already-connected client too) events via pure reducers,
 * and reconnects with capped exponential backoff on error, exposing a
 * `connected|reconnecting` connection state.
 *
 * The EventSource factory is injectable so the reducer/store logic is testable
 * without a real browser EventSource (see sseClient.test.ts).
 */
import type { ProjectSnapshot, Snapshot } from './types'

export type ConnectionState = 'connecting' | 'connected' | 'reconnecting'

/** Minimal surface of EventSource this module depends on. */
export interface EventSourceLike {
  close(): void
  addEventListener(type: string, listener: (ev: MessageEvent) => void): void
}

export type EventSourceFactory = (url: string) => EventSourceLike

export interface SseStore {
  getSnapshot(): Snapshot | null
  getConnectionState(): ConnectionState
  subscribe(listener: () => void): () => void
  close(): void
}

/** `snapshot` event: always a full, authoritative replace (never merged). */
export function reduceSnapshot(_prev: Snapshot | null, next: Snapshot): Snapshot {
  return next
}

/**
 * `delta` event: replace the matching project (by root) or append it if new.
 * No-op (returns prev unchanged) if no full snapshot has landed yet — a delta
 * can only ever refine an existing base, never seed one on its own.
 */
export function reduceDelta(prev: Snapshot | null, project: ProjectSnapshot): Snapshot | null {
  if (!prev) return prev
  const idx = prev.projects.findIndex((p) => p.root === project.root)
  const projects =
    idx >= 0 ? prev.projects.map((p, i) => (i === idx ? project : p)) : [...prev.projects, project]
  return { ...prev, projects, generatedAt: new Date().toISOString() }
}

/**
 * `removed` event: drops the project matching `root` (the server unregistered
 * it — dashboard/server/server.mjs's `POST /api/unregister`). Returns the
 * SAME `prev` reference (never a same-content copy) when there's no base
 * snapshot yet or the root isn't present, so callers can cheaply skip a
 * re-render for a no-op removal.
 */
export function reduceRemoved(prev: Snapshot | null, root: string): Snapshot | null {
  if (!prev) return prev
  if (!prev.projects.some((p) => p.root === root)) return prev
  return { ...prev, projects: prev.projects.filter((p) => p.root !== root), generatedAt: new Date().toISOString() }
}

// Capped exponential backoff: 0.5s, 1s, 2s, 4s, 8s, 16s, then holds at 30s.
export const RECONNECT_BACKOFF_MS = [500, 1000, 2000, 4000, 8000, 16000, 30000]

function defaultFactory(url: string): EventSourceLike {
  return new EventSource(url)
}

export function createSseStore(url: string, factory: EventSourceFactory = defaultFactory): SseStore {
  let snapshot: Snapshot | null = null
  let connectionState: ConnectionState = 'connecting'
  let attempt = 0
  let source: EventSourceLike | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let closed = false
  const listeners = new Set<() => void>()

  function notify() {
    for (const listener of listeners) listener()
  }

  function scheduleReconnect() {
    if (closed) return
    connectionState = 'reconnecting'
    notify()
    const delay = RECONNECT_BACKOFF_MS[Math.min(attempt, RECONNECT_BACKOFF_MS.length - 1)]
    attempt += 1
    reconnectTimer = setTimeout(connect, delay)
  }

  function connect() {
    if (closed) return
    source = factory(url)
    source.addEventListener('snapshot', (ev) => {
      try {
        const parsed = JSON.parse(ev.data) as Snapshot
        snapshot = reduceSnapshot(snapshot, parsed)
        attempt = 0
        connectionState = 'connected'
        notify()
      } catch {
        // malformed payload: ignore, keep last-known-good snapshot (fail-open)
      }
    })
    source.addEventListener('delta', (ev) => {
      try {
        const parsed = JSON.parse(ev.data) as ProjectSnapshot
        const nextSnapshot = reduceDelta(snapshot, parsed)
        if (nextSnapshot !== snapshot) {
          snapshot = nextSnapshot
          notify()
        }
      } catch {
        // malformed payload: ignore (fail-open)
      }
    })
    source.addEventListener('removed', (ev) => {
      try {
        const parsed = JSON.parse(ev.data) as { root: string }
        const nextSnapshot = reduceRemoved(snapshot, parsed.root)
        if (nextSnapshot !== snapshot) {
          snapshot = nextSnapshot
          notify()
        }
      } catch {
        // malformed payload: ignore (fail-open)
      }
    })
    source.addEventListener('error', () => {
      source?.close()
      scheduleReconnect()
    })
  }

  connect()

  return {
    getSnapshot: () => snapshot,
    getConnectionState: () => connectionState,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    close() {
      closed = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      source?.close()
    },
  }
}
