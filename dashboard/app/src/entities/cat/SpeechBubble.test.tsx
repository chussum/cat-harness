import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { SpeechBubble } from './SpeechBubble'
import { BUBBLE_MAX_WIDTH_PX } from './wander'
import type { DialogueEntry } from '@/shared/api/types'

function entry(overrides: Partial<DialogueEntry> = {}): DialogueEntry {
  return {
    round_trip_id: 'r1',
    role: 'dispatch',
    agent_type: 'cat-harness:executor',
    excerpt: 'short excerpt',
    ts: 't1',
    paired: true,
    ...overrides,
  }
}

describe('SpeechBubble', () => {
  it("renders just the excerpt text — no who->whom label prefix (the room's bubble placement already shows who's speaking)", () => {
    render(<SpeechBubble dispatch={entry({ excerpt: 'go build it' })} reply={null} />)
    const bubble = screen.getByTestId('speech-bubble')
    expect(bubble).toHaveTextContent('go build it')
    expect(bubble.textContent).not.toContain('→')
    expect(bubble.textContent).not.toContain(':')
  })

  it("caps its width at BUBBLE_MAX_WIDTH_PX via inline style — never a hardcoded class — so it can never drift from the positioning math's own constant", () => {
    render(<SpeechBubble dispatch={entry()} reply={null} />)
    const bubble = screen.getByTestId('speech-bubble')
    expect(bubble.style.maxWidth).toBe(`${BUBBLE_MAX_WIDTH_PX}px`)
  })

  it('shrinks to fit its content (width: max-content) rather than always rendering at the full max width — a short excerpt gets a short, narrow bubble', () => {
    render(<SpeechBubble dispatch={entry({ excerpt: 'hi' })} reply={null} />)
    const bubble = screen.getByTestId('speech-bubble')
    expect(bubble.style.width).toBe('max-content')
    // still capped, so a long excerpt wraps instead of growing past it
    expect(bubble.style.maxWidth).toBe(`${BUBBLE_MAX_WIDTH_PX}px`)
  })

  it('never truncates/ellipsizes — the full excerpt text is always present, however long', () => {
    const longExcerpt = '가나다라마바사아자차카타파하'.repeat(15) // well beyond a few wrapped lines
    render(<SpeechBubble dispatch={entry({ excerpt: longExcerpt })} reply={null} />)
    const bubble = screen.getByTestId('speech-bubble')
    expect(bubble).toHaveTextContent(longExcerpt)
    // no line-clamp / ellipsis CSS anywhere on the bubble or its paragraphs
    expect(bubble.style.webkitLineClamp).toBe('')
    expect(bubble.style.textOverflow).not.toBe('ellipsis')
    const p = bubble.querySelector('p')!
    expect(p.style.webkitLineClamp).toBe('')
  })

  it('sets overflow-wrap/word-break so a very long unbroken token (e.g. a URL) wraps inside the box instead of overflowing it', () => {
    const longToken = 'https://example.com/' + 'a'.repeat(200)
    render(<SpeechBubble dispatch={entry({ excerpt: longToken })} reply={null} />)
    const bubble = screen.getByTestId('speech-bubble')
    expect(bubble.style.overflowWrap).toBe('anywhere')
    expect(bubble.style.wordBreak).toBe('break-word')
    expect(bubble).toHaveTextContent(longToken)
  })

  it('renders both dispatch and reply excerpts, each on their own line, still with no label prefix', () => {
    render(<SpeechBubble dispatch={entry({ excerpt: 'dispatched' })} reply={entry({ role: 'reply', excerpt: 'replied' })} />)
    const bubble = screen.getByTestId('speech-bubble')
    expect(bubble).toHaveTextContent('dispatched')
    expect(bubble).toHaveTextContent('replied')
    expect(bubble.querySelectorAll('p')).toHaveLength(2)
  })
})
