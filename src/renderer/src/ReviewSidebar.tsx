import { Input } from '@/components/ui/input'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { useEffect, useRef, useState, type RefObject } from 'react'
import { preparePresortedFileTreeInput, type GitStatus } from '@pierre/trees'
import { FileTree, useFileTree } from '@pierre/trees/react'
import { Files, FileDiff as FileDiffIcon, MessagesSquare } from 'lucide-react'
import type { Snapshot } from '../../shared/review'
import type { Settings, PreferencesPatch } from '../../shared/desktop'
import { Button } from '@/components/ui/button'
import ReviewWorker from './review.worker?worker'
export const gitStatuses: Record<string, GitStatus> = {
  A: 'added',
  D: 'deleted',
  M: 'modified',
  T: 'modified',
  U: 'modified',
  R: 'renamed',
  C: 'added',
  '?': 'untracked',
}

export function ReviewSidebar({
  snapshot,
  settings,
  sidebarWidth,
  setSidebarWidth,
  preferences,
  filter,
  setFilter,
  search,
  setSearch,
  searchRef,
  paths,
  unresolvedCount,
  totals,
  selected,
  select,
  theme,
}: {
  snapshot?: Snapshot
  settings: Settings
  sidebarWidth: number
  setSidebarWidth: (width: number) => void
  preferences: (patch: PreferencesPatch) => void
  filter: string
  setFilter: (filter: string) => void
  search: string
  setSearch: (search: string) => void
  searchRef: RefObject<HTMLInputElement | null>
  paths: string[]
  unresolvedCount: number
  totals: { additions: number; deletions: number }
  selected: string
  select: (path: string) => void
  theme: 'light' | 'dark'
}) {
  return (
    <>
      <aside
        hidden={settings.sidebarCollapsed}
        id="review-files-sidebar"
        data-testid="file-sidebar"
        className="flex min-w-47.5 max-w-[50vw] shrink-0 flex-col overflow-auto overscroll-contain bg-surface hidden:hidden"
        aria-label="Review files"
        style={{ width: sidebarWidth }}
      >
        <div className="flex flex-col gap-2 p-3">
          <ToggleGroup
            type="single"
            aria-label="File filter"
            value={filter}
            onValueChange={(value) => {
              if (value) setFilter(value)
            }}
          >
            {(
              [
                { value: 'changed', label: 'Changed files', Icon: FileDiffIcon },
                { value: 'all', label: 'All files', Icon: Files },
                { value: 'unresolved', label: 'Unresolved threads', Icon: MessagesSquare },
              ] as const
            ).map(({ value, label, Icon }) => (
              <ToggleGroupItem key={value} value={value} aria-label={label} title={label}>
                <Icon size={16} />
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <Input
            ref={searchRef}
            aria-label="Search files"
            placeholder="Search files"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <span className="text-muted-foreground">
            {paths.length} files · {unresolvedCount} unresolved
          </span>
          <span
            data-testid="line-totals"
            className="flex gap-2 tabular-nums"
            title="Text lines added and deleted in the listed files. Binary files have no line count."
          >
            <span data-testid="git-added" className="text-git-added">
              +{totals.additions}
            </span>
            <span data-testid="git-deleted" className="text-git-deleted">
              −{totals.deletions}
            </span>
            <span className="text-muted-foreground">lines</span>
          </span>
        </div>
        {!!snapshot && (
          <ReviewTree
            files={snapshot.files}
            paths={paths}
            selected={selected}
            onSelect={select}
            theme={theme}
          />
        )}
      </aside>
      {!settings.sidebarCollapsed && (
        <div
          role="separator"
          aria-label="Resize file sidebar"
          aria-orientation="vertical"
          aria-valuemin={190}
          aria-valuemax={600}
          aria-valuenow={sidebarWidth}
          tabIndex={0}
          className="z-10 -mx-0.75 w-1.75 shrink-0 touch-none cursor-col-resize bg-[linear-gradient(to_right,transparent_3px,var(--border)_3px,var(--border)_4px,transparent_4px)] hover:bg-accent hover:outline hover:outline-ring focus-visible:bg-accent focus-visible:outline focus-visible:outline-ring"
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId)
            event.preventDefault()
          }}
          onPointerMove={(event) => {
            if (event.currentTarget.hasPointerCapture(event.pointerId))
              setSidebarWidth(
                Math.round(Math.max(190, Math.min(600, window.innerWidth * 0.5, event.clientX))),
              )
          }}
          onPointerUp={(event) => {
            if (event.currentTarget.hasPointerCapture(event.pointerId)) {
              event.currentTarget.releasePointerCapture(event.pointerId)
              if (event.clientX < 95) {
                setSidebarWidth(settings.sidebarWidth)
                preferences({ sidebarCollapsed: true })
              } else preferences({ sidebarWidth })
            }
          }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
              event.preventDefault()
              const width = Math.max(
                190,
                Math.min(
                  600,
                  window.innerWidth * 0.5,
                  sidebarWidth + (event.key === 'ArrowRight' ? 20 : -20),
                ),
              )
              setSidebarWidth(width)
              preferences({ sidebarWidth: width })
            }
          }}
        />
      )}
    </>
  )
}

function ReviewTree({
  files,
  paths,
  selected,
  onSelect,
  theme,
}: {
  files: Snapshot['files']
  paths: string[]
  selected: string
  onSelect: (path: string) => void
  theme: 'light' | 'dark'
}) {
  const selection = useRef({ selected, onSelect })
  selection.current = { selected, onSelect }
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const [prepared, setPrepared] = useState(() => preparePresortedFileTreeInput([]))
  useEffect(() => {
    let current = true
    setError('')
    let worker: Worker | undefined
    try {
      worker = new ReviewWorker()
      worker.onmessage = (event) => {
        if (!current) return
        try {
          if (event.data.error) setError(event.data.error)
          else setPrepared(preparePresortedFileTreeInput(event.data.result))
        } catch (error) {
          setError(error instanceof Error ? error.message : String(error))
        }
        worker?.terminate()
      }
      worker.onerror = (event) => {
        event.preventDefault()
        if (current) setError(event.message || 'Tree worker failed')
        worker?.terminate()
      }
      worker.postMessage({ kind: 'tree', paths })
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error))
      worker?.terminate()
    }
    return () => {
      current = false
      worker?.terminate()
    }
  }, [paths, attempt])
  const { model } = useFileTree({
    preparedInput: prepared,
    initialExpansion: 'open',
    onSelectionChange: (selected) => {
      const path = selected[0]
      if (path && path !== selection.current.selected && !model.getItem(path)?.isDirectory())
        selection.current.onSelect(path)
    },
    unsafeCSS:
      ':host { font-family: "Geist Mono Variable", monospace; font-size: 13px; line-height: 20px; }',
  })
  useEffect(() => {
    model.resetPaths({ preparedInput: prepared })
    model.setGitStatus(
      files.map((file) => ({ path: file.path, status: gitStatuses[file.status] ?? 'modified' })),
    )
  }, [model, prepared, files])
  useEffect(() => {
    model.getItem(selected)?.select()
    model.scrollToPath(selected, { focus: false })
  }, [model, selected, prepared])
  if (error)
    return (
      <div role="alert" className="p-3">
        Could not prepare file tree: {error}
        <Button variant="outline" onClick={() => setAttempt((value) => value + 1)}>
          Retry file tree
        </Button>
      </div>
    )
  return (
    <FileTree
      model={model}
      className="file-tree block min-h-0 flex-1"
      style={{ colorScheme: theme }}
    />
  )
}
