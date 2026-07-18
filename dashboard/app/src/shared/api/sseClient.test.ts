import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createSseStore, reduceDelta, reduceRemoved, reduceSnapshot, RECONNECT_BACKOFF_MS } from './sseClient'
import type { EventSourceLike } from './sseClient'
import type { ProjectSnapshot, Snapshot } from './types'

function makeSnapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    schemaVersion: 1,
    generatedAt: '2026-01-01T00:00:00.000Z',
    projects: [{ root: '/a', lit: false, sessions: [] }],
    ...overrides,
  }
}

class FakeEventSource implements EventSourceLike {
  static instances: FakeEventSource[] = []
  listeners = new Map<string, Array<(ev: MessageEvent) => void>>()
  closed = false
  url: string

  constructor(url: string) {
    this.url = url
    FakeEventSource.instances.push(this)
  }

  addEventListener(type: string, listener: (ev: MessageEvent) => void) {
    const list = this.listeners.get(type) ?? []
    list.push(listener)
    this.listeners.set(type, list)
  }

  emit(type: string, data?: unknown) {
    const list = this.listeners.get(type) ?? []
    for (const listener of list) listener({ data: JSON.stringify(data) } as MessageEvent)
  }

  close() {
    this.closed = true
  }
}

beforeEach(() => {
  FakeEventSource.instances = []
})

describe('reduceSnapshot', () => {
  it('replaces the whole snapshot unconditionally', () => {
    const prev = makeSnapshot()
    const next = makeSnapshot({ generatedAt: '2026-01-02T00:00:00.000Z' })
    expect(reduceSnapshot(prev, next)).toBe(next)
  })
})

describe('reduceDelta', () => {
  it('replaces the matching project by root', () => {
    const prev = makeSnapshot({
      projects: [
        { root: '/a', lit: false, sessions: [] },
        { root: '/b', lit: false, sessions: [] },
      ],
    })
    const delta: ProjectSnapshot = { root: '/b', lit: true, sessions: [] }
    const next = reduceDelta(prev, delta)
    expect(next?.projects).toEqual([
      { root: '/a', lit: false, sessions: [] },
      { root: '/b', lit: true, sessions: [] },
    ])
  })

  it('appends a project not previously present', () => {
    const prev = makeSnapshot({ projects: [{ root: '/a', lit: false, sessions: [] }] })
    const delta: ProjectSnapshot = { root: '/new', lit: true, sessions: [] }
    const next = reduceDelta(prev, delta)
    expect(next?.projects.map((p) => p.root)).toEqual(['/a', '/new'])
  })

  it('is a no-op when there is no base snapshot yet', () => {
    expect(reduceDelta(null, { root: '/a', lit: true, sessions: [] })).toBeNull()
  })
})

describe('reduceRemoved', () => {
  it('drops the project matching root', () => {
    const prev = makeSnapshot({
      projects: [
        { root: '/a', lit: false, sessions: [] },
        { root: '/b', lit: false, sessions: [] },
      ],
    })
    const next = reduceRemoved(prev, '/a')
    expect(next?.projects).toEqual([{ root: '/b', lit: false, sessions: [] }])
  })

  it('returns the SAME reference (no-op) when there is no base snapshot yet', () => {
    expect(reduceRemoved(null, '/a')).toBeNull()
  })

  it('returns the SAME reference (no-op) when the root is not present', () => {
    const prev = makeSnapshot({ projects: [{ root: '/a', lit: false, sessions: [] }] })
    expect(reduceRemoved(prev, '/ghost')).toBe(prev)
  })
})

describe('createSseStore', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('starts in connecting state with no snapshot', () => {
    const store = createSseStore('/api/stream', (url) => new FakeEventSource(url))
    expect(store.getConnectionState()).toBe('connecting')
    expect(store.getSnapshot()).toBeNull()
    store.close()
  })

  it('transitions to connected and stores the full snapshot on a snapshot event', () => {
    const store = createSseStore('/api/stream', (url) => new FakeEventSource(url))
    const es = FakeEventSource.instances[0]
    const snap = makeSnapshot()
    es.emit('snapshot', snap)
    expect(store.getConnectionState()).toBe('connected')
    expect(store.getSnapshot()).toEqual(snap)
    store.close()
  })

  it('merges a delta event into the stored snapshot', () => {
    const store = createSseStore('/api/stream', (url) => new FakeEventSource(url))
    const es = FakeEventSource.instances[0]
    es.emit('snapshot', makeSnapshot({ projects: [{ root: '/a', lit: false, sessions: [] }] }))
    es.emit('delta', { root: '/a', lit: true, sessions: [] })
    expect(store.getSnapshot()?.projects[0].lit).toBe(true)
    store.close()
  })

  it('notifies subscribers on state change', () => {
    const store = createSseStore('/api/stream', (url) => new FakeEventSource(url))
    const listener = vi.fn()
    store.subscribe(listener)
    FakeEventSource.instances[0].emit('snapshot', makeSnapshot())
    expect(listener).toHaveBeenCalled()
    store.close()
  })

  it('moves to reconnecting on error and reconnects after the first backoff delay', () => {
    const store = createSseStore('/api/stream', (url) => new FakeEventSource(url))
    const first = FakeEventSource.instances[0]
    first.emit('snapshot', makeSnapshot())
    first.emit('error')
    expect(store.getConnectionState()).toBe('reconnecting')
    expect(first.closed).toBe(true)
    expect(FakeEventSource.instances.length).toBe(1)

    vi.advanceTimersByTime(RECONNECT_BACKOFF_MS[0])
    expect(FakeEventSource.instances.length).toBe(2)

    // last-known-good snapshot is retained through a reconnect cycle
    expect(store.getSnapshot()).not.toBeNull()
    store.close()
  })

  it('returns to connected once the reconnected source gets a fresh snapshot', () => {
    const store = createSseStore('/api/stream', (url) => new FakeEventSource(url))
    FakeEventSource.instances[0].emit('error')
    vi.advanceTimersByTime(RECONNECT_BACKOFF_MS[0])
    FakeEventSource.instances[1].emit('snapshot', makeSnapshot())
    expect(store.getConnectionState()).toBe('connected')
    store.close()
  })

  it('drops a project from the live snapshot on a removed event — no reconnect required', () => {
    const store = createSseStore('/api/stream', (url) => new FakeEventSource(url))
    const es = FakeEventSource.instances[0]
    es.emit(
      'snapshot',
      makeSnapshot({
        projects: [
          { root: '/a', lit: false, sessions: [] },
          { root: '/b', lit: false, sessions: [] },
        ],
      }),
    )
    es.emit('removed', { root: '/a' })
    expect(store.getSnapshot()?.projects.map((p) => p.root)).toEqual(['/b'])
    store.close()
  })

  it('close() stops further reconnect attempts', () => {
    const store = createSseStore('/api/stream', (url) => new FakeEventSource(url))
    FakeEventSource.instances[0].emit('error')
    store.close()
    vi.advanceTimersByTime(60_000)
    expect(FakeEventSource.instances.length).toBe(1)
  })
})
