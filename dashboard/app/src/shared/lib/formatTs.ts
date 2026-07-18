/**
 * shared/lib/formatTs.ts — render a server timestamp in the VIEWER's local
 * timezone. The server writes ISO-8601 UTC (e.g. "2026-07-18T07:45:37.419Z");
 * showing that raw `Z` string is confusing because it's 9h off wall-clock for
 * an Asia/Seoul viewer. `formatLocalTs` converts it to the browser's local
 * time — so each viewer sees their own machine's clock (Asia/Seoul here) —
 * as `YYYY-MM-DD HH:mm:ss.SSS`, 24-hour, milliseconds KEPT (ledger events can
 * land in the same second, so ms is what keeps them visibly ordered).
 *
 * Uses local `getHours()`/`getDate()`/… (not UTC getters), so the offset is
 * the browser's own. A malformed/empty input returns the original string
 * unchanged (fail-safe — never throw in render).
 */
const pad2 = (n: number) => String(n).padStart(2, '0')
const pad3 = (n: number) => String(n).padStart(3, '0')

export function formatLocalTs(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const date = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
  const time = `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}.${pad3(d.getMilliseconds())}`
  return `${date} ${time}`
}
