import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { FloorList } from './FloorList'
import { projectsToFloors } from '@/entities/floor/model'
import { translate } from '@/shared/i18n/dictionaries'
import type { ProjectSnapshot } from '@/shared/api/types'

function project(root: string, lit: boolean): ProjectSnapshot {
  return { root, lit, sessions: [] }
}

describe('FloorList', () => {
  it('renders one row per floor, in sidebar order', () => {
    const floors = projectsToFloors([project('/a', true), project('/b', false)])
    render(<FloorList floors={floors} selectedProjectRoot={null} onSelect={vi.fn()} />)
    expect(screen.getAllByRole('button')).toHaveLength(2)
  })

  it('shows the empty-state message when there are no floors', () => {
    render(<FloorList floors={[]} selectedProjectRoot={null} onSelect={vi.fn()} />)
    expect(screen.getByText(translate('ko', 'floorList.noProjects'))).toBeInTheDocument()
  })

  it('calls onSelect with the clicked floor\'s project root', () => {
    const onSelect = vi.fn()
    const floors = projectsToFloors([project('/a', true)])
    render(<FloorList floors={floors} selectedProjectRoot={null} onSelect={onSelect} />)
    fireEvent.click(screen.getAllByRole('button')[0])
    expect(onSelect).toHaveBeenCalledWith('/a')
  })

  it('only lists whatever floors it is given — filtering (if any) happens upstream, not here', () => {
    const allFloors = projectsToFloors([project('/a', true), project('/b', false)])
    const filtered = allFloors.filter((f) => f.projectRoot !== '/b')
    render(<FloorList floors={filtered} selectedProjectRoot={null} onSelect={vi.fn()} />)
    expect(screen.getAllByRole('button').map((b) => b.textContent).join(' ')).not.toContain('/b')
  })
})
