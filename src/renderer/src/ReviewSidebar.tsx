import { Input } from '@/components/ui/input'
import { Menu } from '@base-ui/react/menu'
import { memo, useEffect, useRef, useState, type RefObject } from 'react'
import {
  createFileTreeIconResolver,
  getBuiltInSpriteSheet,
  preparePresortedFileTreeInput,
  type GitStatus,
} from '@pierre/trees'
import { FileTree, useFileTree } from '@pierre/trees/react'
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Filter,
  Files,
  List,
  ListTree,
  FileDiff as FileDiffIcon,
  MessagesSquare,
} from 'lucide-react'
import type { Snapshot } from '../../shared/review'
import type { Settings, PreferencesPatch } from '../../shared/desktop'
import { Button } from '@/components/ui/button'
import ReviewWorker from './review.worker?worker'
const { resolveIcon } = createFileTreeIconResolver()
const fileIconSprite = getBuiltInSpriteSheet('complete')

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
  preferences,
  filter,
  setFilter,
  search,
  setSearch,
  searchRef,
  paths,
  totals,
  selected,
  select,
  theme,
  canNavigate,
  navigate,
  threadFocused,
  onShowAll,
}: {
  canNavigate: boolean
  navigate: (direction: number) => void
  threadFocused: boolean
  onShowAll: () => void
  snapshot?: Snapshot
  settings: Settings
  preferences: (patch: PreferencesPatch) => void
  filter: string
  setFilter: (filter: string) => void
  search: string
  setSearch: (search: string) => void
  searchRef: RefObject<HTMLInputElement | null>
  paths: string[]
  totals: { additions: number; deletions: number }
  selected: string
  select: (path: string) => void
  theme: 'light' | 'dark'
}) {
  // Keep drag updates local so resizing does not rerender every diff card.
  const [sidebarWidth, setSidebarWidth] = useState(settings.sidebarWidth)
  const [view, setView] = useState('tree')
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
          <div className="flex items-center gap-1">
            <Input
              ref={searchRef}
              className="flex-1"
              aria-label="Search files"
              placeholder="Search files"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            <Menu.Root>
              <Menu.Trigger
                render={<Button variant="ghost" size="icon" />}
                aria-label="File view"
                className="shrink-0"
              >
                {view === 'tree' ? <ListTree aria-hidden="true" /> : <List aria-hidden="true" />}
              </Menu.Trigger>
              <Menu.Portal>
                <Menu.Positioner align="end" sideOffset={5} className="z-40">
                  <Menu.Popup
                    aria-label="File view"
                    className="min-w-48 rounded-md border bg-background p-1 text-foreground shadow-lg outline-none"
                  >
                    <Menu.RadioGroup value={view} onValueChange={setView}>
                      {[
                        { value: 'tree', label: 'Tree view', Icon: ListTree },
                        { value: 'flat', label: 'Flat list', Icon: List },
                      ].map(({ value, label, Icon }) => (
                        <Menu.RadioItem
                          key={value}
                          value={value}
                          closeOnClick
                          className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 outline-none data-highlighted:bg-accent"
                        >
                          <Icon size={16} aria-hidden="true" />
                          {label}
                          <span className="ml-auto size-4">
                            <Menu.RadioItemIndicator>
                              <Check size={16} aria-hidden="true" />
                            </Menu.RadioItemIndicator>
                          </span>
                        </Menu.RadioItem>
                      ))}
                    </Menu.RadioGroup>
                  </Menu.Popup>
                </Menu.Positioner>
              </Menu.Portal>
            </Menu.Root>
            <Menu.Root>
              <Menu.Trigger
                render={<Button variant="ghost" size="icon" />}
                aria-label="Filter files"
                className="shrink-0"
              >
                <Filter aria-hidden="true" />
              </Menu.Trigger>
              <Menu.Portal>
                <Menu.Positioner align="end" sideOffset={5} className="z-40">
                  <Menu.Popup
                    aria-label="File filter"
                    className="min-w-48 rounded-md border bg-background p-1 text-foreground shadow-lg outline-none"
                  >
                    <Menu.RadioGroup value={filter} onValueChange={setFilter}>
                      {[
                        { value: 'changed', label: 'Changed files', Icon: FileDiffIcon },
                        { value: 'all', label: 'All files', Icon: Files },
                        { value: 'unresolved', label: 'Unresolved threads', Icon: MessagesSquare },
                      ].map(({ value, label, Icon }) => (
                        <Menu.RadioItem
                          key={value}
                          value={value}
                          closeOnClick
                          className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 outline-none data-highlighted:bg-accent"
                        >
                          <Icon size={16} aria-hidden="true" />
                          {label}
                          <span className="ml-auto size-4">
                            <Menu.RadioItemIndicator>
                              <Check size={16} aria-hidden="true" />
                            </Menu.RadioItemIndicator>
                          </span>
                        </Menu.RadioItem>
                      ))}
                    </Menu.RadioGroup>
                  </Menu.Popup>
                </Menu.Positioner>
              </Menu.Portal>
            </Menu.Root>
          </div>
          <div className="flex items-center justify-between gap-1">
            <span
              data-testid="line-totals"
              className="flex gap-2 whitespace-nowrap tabular-nums"
              title="Text lines added and deleted in the listed files. Binary files have no line count."
            >
              <span data-testid="git-added" className="text-git-added">
                +{totals.additions}
              </span>
              <span data-testid="git-deleted" className="text-git-deleted">
                −{totals.deletions}
              </span>
              <span className="text-muted-foreground">· {paths.length} files</span>
            </span>
            <div className="flex shrink-0">
              <Button
                variant="ghost"
                size="icon"
                className="size-6"
                aria-label="Previous file"
                title="Previous file"
                disabled={!canNavigate}
                onClick={() => navigate(-1)}
              >
                <ArrowLeft className="size-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="size-6"
                aria-label="Next file"
                title="Next file"
                disabled={!canNavigate}
                onClick={() => navigate(1)}
              >
                <ArrowRight className="size-3.5" />
              </Button>
            </div>
          </div>
          {threadFocused && (
            <Button variant="ghost" onClick={onShowAll}>
              All changes
            </Button>
          )}
        </div>
        {!!snapshot && (
          <ReviewTree
            view={view}
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
          className="z-20 -mx-0.75 w-1.75 shrink-0 touch-none cursor-col-resize bg-[linear-gradient(to_right,transparent_3px,var(--border)_3px,var(--border)_4px,transparent_4px)] hover:bg-[linear-gradient(to_right,transparent_2.5px,var(--ring)_2.5px,var(--ring)_4.5px,transparent_4.5px)] focus-visible:bg-[linear-gradient(to_right,transparent_2.5px,var(--ring)_2.5px,var(--ring)_4.5px,transparent_4.5px)] focus-visible:outline-none"
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

const ReviewTree = memo(function ReviewTree({
  view,
  files,
  paths,
  selected,
  onSelect,
  theme,
}: {
  view: string
  files: Snapshot['files']
  paths: string[]
  selected: string
  onSelect: (path: string) => void
  theme: 'light' | 'dark'
}) {
  const listRef = useRef<HTMLUListElement>(null)
  useEffect(() => {
    listRef.current?.querySelector('[aria-current="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [view, selected, paths])
  const selection = useRef({ selected, onSelect })
  const syncingSelection = useRef(false)
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
    density: 'default',
    stickyFolders: true,
    initialExpansion: 'open',
    onSelectionChange: (selected) => {
      if (syncingSelection.current) return
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
    syncingSelection.current = true
    try {
      for (const path of model.getSelectedPaths()) {
        if (path !== selected) model.getItem(path)?.deselect()
      }
      model.getItem(selected)?.select()
    } finally {
      syncingSelection.current = false
    }
    model.scrollToPath(selected, { focus: false })
  }, [model, selected, prepared])
  if (view === 'flat') {
    const statuses = new Map(files.map((file) => [file.path, file.status]))
    return (
      <div
        className="flat-file-list min-h-0 flex-1 overflow-auto px-2 pb-2"
        style={{ colorScheme: theme }}
      >
        <div
          aria-hidden="true"
          className="hidden"
          dangerouslySetInnerHTML={{ __html: fileIconSprite }}
        />
        <ul ref={listRef} aria-label="File list">
          {paths.map((path) => {
            const status = statuses.get(path)
            const gitStatus = status ? (gitStatuses[status] ?? 'modified') : undefined
            const icon = resolveIcon('file-tree-icon-file', path)
            return (
              <li key={path}>
                <button
                  type="button"
                  aria-current={path === selected ? 'true' : undefined}
                  title={path}
                  data-git-status={gitStatus}
                  onClick={() => onSelect(path)}
                  className="flex w-full items-center gap-2 rounded-sm px-2 py-1 text-left font-mono text-[13px] hover:bg-accent focus-visible:outline-ring aria-current:bg-accent"
                >
                  <svg
                    width={16}
                    height={16}
                    viewBox="0 0 16 16"
                    className="shrink-0"
                    aria-hidden="true"
                    style={{
                      color: `var(--trees-file-icon-color-${icon.token ?? 'default'}, var(--trees-file-icon-color-default))`,
                    }}
                  >
                    <use href={`#${icon.name}`} />
                  </svg>
                  <span className="min-w-0 flex-1 truncate">{path}</span>
                  {status && <span aria-label={gitStatus}>{status}</span>}
                </button>
              </li>
            )
          })}
        </ul>
      </div>
    )
  }
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
})
