/**
 * shared/i18n/LanguageProvider.tsx — a lightweight in-repo i18n layer (a
 * React context + the ko/en dictionaries in ./dictionaries, no external
 * runtime dependency). Exposes `useI18n()` -> { lang, setLang, t }.
 *
 * Default language is Korean. On first load (no stored preference) the
 * language auto-detects from `navigator.language` — Korean if it starts with
 * "ko", English otherwise (Korean also wins if navigator is unavailable).
 * Once the user explicitly toggles the language, that choice is persisted to
 * localStorage and wins over auto-detection on later visits.
 */
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
import { translate, type Lang, type TranslateParams } from './dictionaries'

export const LANG_STORAGE_KEY = 'cat-harness-dashboard:lang'

/** Korean if `navigator.language` starts with "ko"; English otherwise; Korean if navigator is unavailable. */
export function detectDefaultLang(): Lang {
  if (typeof navigator === 'undefined' || !navigator.language) return 'ko'
  return navigator.language.toLowerCase().startsWith('ko') ? 'ko' : 'en'
}

/** The user's previously persisted explicit choice, if any and if valid. */
export function readStoredLang(): Lang | null {
  if (typeof window === 'undefined') return null
  try {
    const stored = window.localStorage.getItem(LANG_STORAGE_KEY)
    return stored === 'ko' || stored === 'en' ? stored : null
  } catch {
    return null
  }
}

export interface I18nContextValue {
  lang: Lang
  setLang: (lang: Lang) => void
  t: (key: string, params?: TranslateParams) => string
}

// Default context value (used when a component renders without a wrapping
// LanguageProvider, e.g. in a unit test) — Korean, matching the app default.
const I18nContext = createContext<I18nContextValue>({
  lang: 'ko',
  setLang: () => {},
  t: (key, params) => translate('ko', key, params),
})

export function useI18n(): I18nContextValue {
  return useContext(I18nContext)
}

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(() => readStoredLang() ?? detectDefaultLang())

  const setLang = useCallback((next: Lang) => {
    setLangState(next)
    try {
      window.localStorage.setItem(LANG_STORAGE_KEY, next)
    } catch {
      // storage unavailable (private mode, etc.) — keep the in-memory choice
    }
  }, [])

  const value = useMemo<I18nContextValue>(
    () => ({ lang, setLang, t: (key, params) => translate(lang, key, params) }),
    [lang, setLang],
  )

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}
