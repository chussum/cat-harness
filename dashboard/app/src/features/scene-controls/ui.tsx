/**
 * features/scene-controls — the scene-wide chrome: SSE connection-state
 * badge, a legend/help toggle, and the KO/EN language toggle.
 */
import { useState } from 'react'
import { cn } from '@/shared/lib/cn'
import { Badge } from '@/shared/ui/Badge'
import { Button } from '@/shared/ui/Button'
import type { ConnectionState } from '@/shared/api/sseClient'
import { useI18n } from '@/shared/i18n/LanguageProvider'
import type { Lang } from '@/shared/i18n/dictionaries'

export interface ConnectionBadgeProps {
  state: ConnectionState
}

export function ConnectionBadge({ state }: ConnectionBadgeProps) {
  const { t } = useI18n()
  const variant = state === 'connected' ? 'success' : 'warning'
  const label =
    state === 'connected'
      ? t('connection.connected')
      : state === 'reconnecting'
        ? t('connection.reconnecting')
        : t('connection.connecting')
  return (
    <span data-testid="connection-badge" data-state={state}>
      <Badge variant={variant} className="gap-1.5">
        <span
          className={cn('h-1.5 w-1.5 rounded-full', state === 'connected' ? 'bg-emerald-400' : 'animate-pulse bg-amber-400')}
        />
        {label}
      </Badge>
    </span>
  )
}

export function LegendToggle() {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  return (
    <div className="relative">
      <Button variant="outline" size="sm" onClick={() => setOpen((v) => !v)}>
        {t('legend.button')}
      </Button>
      {open && (
        <div className="absolute right-0 z-10 mt-2 w-56 rounded-md border border-zinc-800 bg-zinc-900 p-3 text-xs text-zinc-300 shadow-lg">
          <p className="mb-1 font-semibold text-zinc-100">{t('legend.title')}</p>
          <ul className="list-inside list-disc space-y-1">
            <li>{t('legend.item.oneFloor')}</li>
            <li>{t('legend.item.lit')}</li>
            <li>{t('legend.item.leader')}</li>
            <li>{t('legend.item.workers')}</li>
            <li>{t('legend.item.typing')}</li>
            <li>{t('legend.item.sleeping')}</li>
            <li>{t('legend.item.bubble')}</li>
          </ul>
        </div>
      )}
    </div>
  )
}

const LANG_OPTIONS: Lang[] = ['ko', 'en']

/** KO/EN switch — defaults to Korean; the user's explicit pick persists to localStorage. */
export function LanguageToggle() {
  const { lang, setLang, t } = useI18n()
  return (
    <div className="flex overflow-hidden rounded-md border border-zinc-700" data-testid="language-toggle">
      {LANG_OPTIONS.map((option) => (
        <button
          key={option}
          type="button"
          onClick={() => setLang(option)}
          aria-pressed={lang === option}
          data-testid={`language-toggle-${option}`}
          className={cn(
            'px-2 py-1 text-xs font-medium transition-colors',
            lang === option ? 'bg-violet-500/20 text-violet-200' : 'text-zinc-400 hover:bg-zinc-800',
          )}
        >
          {t(`language.toggle.${option}`)}
        </button>
      ))}
    </div>
  )
}
