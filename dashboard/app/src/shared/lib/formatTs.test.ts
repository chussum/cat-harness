import { describe, it, expect } from 'vitest'
import { formatLocalTs } from './formatTs'

describe('formatLocalTs', () => {
  it('empty/null/undefined -> empty string', () => {
    expect(formatLocalTs('')).toBe('')
    expect(formatLocalTs(null)).toBe('')
    expect(formatLocalTs(undefined)).toBe('')
  })

  it('a malformed timestamp is returned unchanged (fail-safe, never throws)', () => {
    expect(formatLocalTs('not a date')).toBe('not a date')
  })

  it('renders YYYY-MM-DD HH:mm:ss.SSS (24h, milliseconds kept)', () => {
    expect(formatLocalTs('2026-07-18T07:45:37.419Z')).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/)
  })

  it('preserves the millisecond field (same-second events stay distinguishable)', () => {
    expect(formatLocalTs('2026-07-18T08:42:44.392Z')).toMatch(/\.392$/)
    expect(formatLocalTs('2026-07-18T08:42:44.485Z')).toMatch(/\.485$/)
  })

  it('formats in the VIEWER local timezone (matches a local-getter reference build)', () => {
    const iso = '2026-07-18T07:45:37.419Z'
    const d = new Date(iso)
    const p2 = (n: number) => String(n).padStart(2, '0')
    const expected =
      `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ` +
      `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}.419`
    expect(formatLocalTs(iso)).toBe(expected)
  })

  it('when run in Asia/Seoul (UTC+9), 07:45 UTC shows as 16:45 local', () => {
    // Only assert the offset math when the test runner IS in Asia/Seoul; otherwise
    // skip the wall-clock assertion (the reference-build test above already proves
    // local-tz usage in any zone).
    const localOffsetMin = new Date('2026-07-18T07:45:37.419Z').getTimezoneOffset()
    if (localOffsetMin === -540) {
      expect(formatLocalTs('2026-07-18T07:45:37.419Z')).toBe('2026-07-18 16:45:37.419')
    }
  })
})
