import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useUnregisterFloor } from './useUnregisterFloor'

describe('useUnregisterFloor', () => {
  const originalFetch = globalThis.fetch
  const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

  beforeEach(() => {
    consoleErrorSpy.mockClear()
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('POSTs the root to /api/unregister as JSON', () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const { result } = renderHook(() => useUnregisterFloor())
    act(() => result.current.unregister('/projects/dormant'))

    expect(fetchMock).toHaveBeenCalledWith('/api/unregister', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ root: '/projects/dormant' }),
    })
  })

  it('logs (does not throw) on a non-OK HTTP response', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500 })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const { result } = renderHook(() => useUnregisterFloor())
    expect(() => act(() => result.current.unregister('/projects/dormant'))).not.toThrow()
    await act(async () => {
      await Promise.resolve()
    })
    expect(consoleErrorSpy).toHaveBeenCalled()
  })

  it('logs (does not throw) when the fetch itself rejects (network failure)', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('network down'))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const { result } = renderHook(() => useUnregisterFloor())
    expect(() => act(() => result.current.unregister('/projects/dormant'))).not.toThrow()
    await act(async () => {
      await Promise.resolve().then(() => Promise.resolve())
    })
    expect(consoleErrorSpy).toHaveBeenCalled()
  })
})
