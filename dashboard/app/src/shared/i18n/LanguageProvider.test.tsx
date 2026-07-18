import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import {
  detectDefaultLang,
  readStoredLang,
  useI18n,
  LanguageProvider,
  LANG_STORAGE_KEY,
} from './LanguageProvider'

function Probe() {
  const { lang, setLang, t } = useI18n()
  return (
    <div>
      <span data-testid="lang">{lang}</span>
      <span data-testid="label">{t('floorList.header')}</span>
      <button onClick={() => setLang('en')}>to-en</button>
    </div>
  )
}

describe('detectDefaultLang', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('defaults to Korean when navigator.language starts with "ko"', () => {
    vi.stubGlobal('navigator', { language: 'ko-KR' })
    expect(detectDefaultLang()).toBe('ko')
  })

  it('falls back to English for a non-Korean locale', () => {
    vi.stubGlobal('navigator', { language: 'en-US' })
    expect(detectDefaultLang()).toBe('en')
  })

  it('defaults to Korean when navigator is unavailable', () => {
    vi.stubGlobal('navigator', undefined)
    expect(detectDefaultLang()).toBe('ko')
  })
})

describe('readStoredLang', () => {
  afterEach(() => {
    window.localStorage.clear()
  })

  it('returns null when nothing is stored', () => {
    expect(readStoredLang()).toBeNull()
  })

  it('returns the stored language when it is a valid value', () => {
    window.localStorage.setItem(LANG_STORAGE_KEY, 'en')
    expect(readStoredLang()).toBe('en')
  })

  it('ignores garbage values', () => {
    window.localStorage.setItem(LANG_STORAGE_KEY, 'fr')
    expect(readStoredLang()).toBeNull()
  })
})

describe('useI18n without a provider', () => {
  it('defaults to Korean so components render sensibly in tests without a wrapper', () => {
    render(<Probe />)
    expect(screen.getByTestId('lang')).toHaveTextContent('ko')
    expect(screen.getByTestId('label')).toHaveTextContent('층')
  })
})

describe('LanguageProvider', () => {
  afterEach(() => {
    window.localStorage.clear()
    vi.unstubAllGlobals()
  })

  it('auto-detects Korean from navigator.language and persists an explicit toggle to localStorage', () => {
    vi.stubGlobal('navigator', { language: 'ko-KR' })
    render(
      <LanguageProvider>
        <Probe />
      </LanguageProvider>,
    )
    expect(screen.getByTestId('lang')).toHaveTextContent('ko')

    fireEvent.click(screen.getByText('to-en'))

    expect(screen.getByTestId('lang')).toHaveTextContent('en')
    expect(screen.getByTestId('label')).toHaveTextContent('FLOORS')
    expect(window.localStorage.getItem(LANG_STORAGE_KEY)).toBe('en')
  })

  it('honors a previously persisted language over auto-detection', () => {
    window.localStorage.setItem(LANG_STORAGE_KEY, 'en')
    vi.stubGlobal('navigator', { language: 'ko-KR' }) // would auto-detect "ko", but the stored pick wins
    render(
      <LanguageProvider>
        <Probe />
      </LanguageProvider>,
    )
    expect(screen.getByTestId('lang')).toHaveTextContent('en')
  })
})
