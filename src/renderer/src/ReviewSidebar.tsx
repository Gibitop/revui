import { useAIReview } from './AIReview'
import { Input } from '@/components/ui/input'
import { Menu } from '@base-ui/react/menu'
import { memo, useEffect, useEffectEvent, useMemo, useRef, useState, type RefObject } from 'react'
import {
  createFileTreeIconResolver,
  getBuiltInSpriteSheet,
  preparePresortedFileTreeInput,
  type GitStatus,
} from '@pierre/trees'
import { FileTree, useFileTree, useFileTreeSelector } from '@pierre/trees/react'
import {
  ArrowUp,
  ArrowDown,
  Check,
  Filter,
  Files,
  List,
  ListTree,
  ListOrdered,
  FolderTree,
  LoaderCircle,
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
  order,
  setOrder,
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
  order: string
  setOrder: (order: string) => void
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
  const view = settings.fileView
  const [sidebarWidth, setSidebarWidth] = useState(settings.sidebarWidth)
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
                    <Menu.RadioGroup
                      value={view}
                      onValueChange={(value) =>
                        preferences({ fileView: value as Settings['fileView'] })
                      }
                    >
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
                aria-label="File ordering"
                className="shrink-0"
              >
                {order === 'ai' ? (
                  <ListOrdered aria-hidden="true" />
                ) : (
                  <FolderTree aria-hidden="true" />
                )}
              </Menu.Trigger>
              <Menu.Portal>
                <Menu.Positioner align="end" sideOffset={5} className="z-40">
                  <Menu.Popup
                    aria-label="File ordering"
                    className="min-w-48 rounded-md border bg-background p-1 text-foreground shadow-lg outline-none"
                  >
                    <Menu.RadioGroup value={order} onValueChange={setOrder}>
                      {[
                        { value: 'fs', label: 'Filesystem order', Icon: FolderTree },
                        { value: 'ai', label: 'AI review order', Icon: ListOrdered },
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
              {threadFocused && (
                <Button variant="ghost" className="h-6 px-2 text-xs" onClick={onShowAll}>
                  All changes
                </Button>
              )}
              <Button
                variant="ghost"
                size="icon"
                className="size-6"
                aria-label={filter === 'unresolved' ? 'Previous thread' : 'Previous file'}
                title={filter === 'unresolved' ? 'Previous thread' : 'Previous file'}
                disabled={!canNavigate}
                onClick={() => navigate(-1)}
              >
                <ArrowUp className="size-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="size-6"
                aria-label={filter === 'unresolved' ? 'Next thread' : 'Next file'}
                title={filter === 'unresolved' ? 'Next thread' : 'Next file'}
                disabled={!canNavigate}
                onClick={() => navigate(1)}
              >
                <ArrowDown className="size-3.5" />
              </Button>
            </div>
          </div>
        </div>
        {!!snapshot &&
          (order === 'ai' ? (
            <ReviewOrder
              view={view}
              settingsKey={JSON.stringify([settings.aiTasks.order, settings.aiLanguage])}
              theme={theme}
              snapshot={snapshot}
              paths={paths}
              selected={selected}
              select={select}
            />
          ) : view === 'flat' ? (
            <FlatFileList
              files={snapshot.files}
              paths={paths}
              selected={selected}
              onSelect={select}
              theme={theme}
            />
          ) : (
            <ReviewTree
              files={snapshot.files}
              paths={paths}
              selected={selected}
              onSelect={select}
              theme={theme}
            />
          ))}
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

function ReviewOrder({
  view,
  theme,
  settingsKey,
  snapshot,
  paths,
  selected,
  select,
}: {
  theme: 'light' | 'dark'
  view: Settings['fileView']
  settingsKey: string
  snapshot: Snapshot
  paths: string[]
  selected: string
  select: (path: string) => void
}) {
  const ai = useAIReview()
  const loaded = ai?.state?.snapshot === snapshot.id
  const load = useEffectEvent(() => {
    void ai?.run({ kind: 'order', snapshot: snapshot.id })
  })
  useEffect(() => {
    if (loaded) load()
  }, [loaded, snapshot.id, settingsKey])
  const state = loaded ? ai?.state : undefined
  const listRef = useRef<HTMLDivElement>(null)
  const error = state?.order.error || (!state ? ai?.error : '')
  const loading =
    !error &&
    (!state || state.order.running || (!state.record.walkthroughKey && !state.order.error))
  const sections = useMemo(() => {
    const included = new Set(paths)
    return (
      state?.record.walkthrough.map((section, index) => ({
        ...section,
        index,
        visible: section.paths.filter((path) => included.has(path)),
      })) ?? []
    )
  }, [state?.record.walkthrough, paths])
  return (
    <div
      ref={listRef}
      aria-label="Suggested review order"
      aria-busy={loading}
      className="flat-file-list min-h-0 flex-1 overflow-auto px-3 pb-3"
      style={{ colorScheme: theme }}
    >
      <div
        aria-hidden="true"
        className="hidden"
        dangerouslySetInnerHTML={{ __html: fileIconSprite }}
      />
      {loading && (
        <div className="space-y-4 py-4" role="status">
          <div className="flex items-center gap-2 font-medium">
            <LoaderCircle className="size-4 motion-safe:animate-spin" aria-hidden="true" />
            Preparing your review
          </div>
          <p className="text-muted-foreground">
            Grouping related changes into a step-by-step guide. You can keep browsing while it’s
            prepared.
          </p>
          <div aria-hidden="true" className="space-y-4 motion-safe:animate-pulse">
            {[0, 1, 2].map((step) => (
              <div key={step} className="space-y-2 rounded-md border p-3">
                <div className="h-3 w-2/3 rounded bg-muted" />
                <div className="h-2 w-full rounded bg-muted" />
                <div className="h-2 w-4/5 rounded bg-muted" />
              </div>
            ))}
          </div>
        </div>
      )}
      {error && (
        <div role="alert">
          <p>{error}</p>
          <Button
            variant="ghost"
            onClick={() => void ai?.run({ kind: state ? 'order' : 'get', snapshot: snapshot.id })}
          >
            Retry review order
          </Button>
        </div>
      )}
      {!loading && !error && !paths.length && (
        <p className="py-3">
          {snapshot.files.length ? 'No files match this view.' : 'No changed files.'}
        </p>
      )}
      {!loading &&
        !error &&
        sections.map(({ index, visible, ...section }) => {
          if (!visible.length) return null
          return (
            <section
              key={section.id}
              data-selected-section={visible.includes(selected) ? 'true' : undefined}
              className="mb-3 border-t pt-3 last:mb-0 last:min-h-full"
              aria-label={`Review step ${index + 1}: ${section.title}`}
            >
              <div className="sticky top-0 z-10 bg-surface py-2" data-testid="review-step-header">
                <h3 className="font-semibold">
                  {index + 1}. {section.title}
                </h3>
                <p className="mt-2 text-muted-foreground">{section.rationale}</p>
              </div>
              {view === 'tree' ? (
                <ReviewTree
                  files={snapshot.files}
                  paths={visible}
                  selected={visible.includes(selected) ? selected : ''}
                  onSelect={select}
                  theme={theme}
                  section
                />
              ) : (
                <FlatFileList
                  files={snapshot.files}
                  paths={visible}
                  selected={selected}
                  onSelect={select}
                  theme={theme}
                  scrollRef={listRef}
                />
              )}
            </section>
          )
        })}
    </div>
  )
}

// Flat rows are 28px tall; keep eight extra rows above and below the viewport.
const fileRowHeight = 28

const FlatFileList = memo(function FlatFileList({
  files,
  paths,
  selected,
  onSelect,
  theme,
  scrollRef,
}: {
  files: Snapshot['files']
  paths: string[]
  selected: string
  onSelect: (path: string) => void
  theme: 'light' | 'dark'
  scrollRef?: RefObject<HTMLDivElement | null>
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const restoreFocus = useRef(false)
  const [range, setRange] = useState({ start: 0, end: 0 })
  const statuses = useMemo(() => new Map(files.map((file) => [file.path, file])), [files])

  useEffect(() => {
    const scroll = scrollRef ? scrollRef.current : containerRef.current
    const list = listRef.current
    if (!scroll || !list) return
    const header = scrollRef
      ? list.closest('section')?.querySelector<HTMLElement>('[data-testid="review-step-header"]')
      : undefined
    const update = () => {
      const top =
        scroll.getBoundingClientRect().top + scroll.clientTop - list.getBoundingClientRect().top
      const start = Math.min(paths.length, Math.max(0, Math.floor(top / fileRowHeight) - 8))
      const end = Math.min(
        paths.length,
        Math.max(0, Math.ceil((top + scroll.clientHeight) / fileRowHeight) + 8),
      )
      setRange((previous) =>
        previous.start === start && previous.end === end ? previous : { start, end },
      )
    }
    const index = paths.indexOf(selected)
    if (list.contains(document.activeElement)) restoreFocus.current = true
    if (index >= 0 && scroll.clientHeight > 0) {
      const top =
        list.getBoundingClientRect().top -
        scroll.getBoundingClientRect().top -
        scroll.clientTop +
        scroll.scrollTop +
        index * fileRowHeight
      const headerHeight = header?.getBoundingClientRect().height ?? 0
      if (top < scroll.scrollTop + headerHeight) scroll.scrollTop = Math.max(0, top - headerHeight)
      else if (top + fileRowHeight > scroll.scrollTop + scroll.clientHeight)
        scroll.scrollTop = top + fileRowHeight - scroll.clientHeight
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(scroll)
    observer.observe(list)
    if (header) observer.observe(header)
    scroll.addEventListener('scroll', update, { passive: true })
    return () => {
      observer.disconnect()
      scroll.removeEventListener('scroll', update)
    }
  }, [paths, selected, scrollRef])

  useEffect(() => {
    if (!restoreFocus.current) return
    const button = listRef.current?.querySelector<HTMLButtonElement>('[aria-current="true"]')
    if (button) {
      button.focus({ preventScroll: true })
      restoreFocus.current = false
    }
  }, [range, selected])

  return (
    <div
      ref={containerRef}
      className={scrollRef ? undefined : 'flat-file-list min-h-0 flex-1 overflow-auto px-2 pb-2'}
      style={{ colorScheme: theme }}
    >
      {!scrollRef && (
        <div
          aria-hidden="true"
          className="hidden"
          dangerouslySetInnerHTML={{ __html: fileIconSprite }}
        />
      )}
      <ul
        ref={listRef}
        aria-label="File list"
        className="relative"
        style={{ height: paths.length * fileRowHeight }}
        onKeyDown={(event) => {
          if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
          if (event.key !== 'Home' && event.key !== 'End') return
          event.preventDefault()
          event.stopPropagation()
          const path = event.key === 'Home' ? paths[0] : paths.at(-1)
          if (path) onSelect(path)
        }}
      >
        {paths.slice(range.start, range.end).map((path, offset) => {
          const index = range.start + offset
          const file = statuses.get(path)
          const status = file?.status
          const gitStatus = file?.mergeConflict
            ? 'conflicted'
            : status
              ? (gitStatuses[status] ?? 'modified')
              : undefined
          const icon = resolveIcon('file-tree-icon-file', path)
          return (
            <li
              key={path}
              aria-posinset={index + 1}
              aria-setsize={paths.length}
              className="absolute inset-x-0"
              style={{ top: index * fileRowHeight, height: fileRowHeight }}
            >
              <button
                type="button"
                aria-label={path}
                aria-current={path === selected ? 'true' : undefined}
                title={path}
                data-git-status={gitStatus}
                onClick={() => onSelect(path)}
                className="flex h-full w-full items-center gap-2 rounded-sm px-2 text-left font-mono text-[13px] leading-5 hover:bg-accent focus-visible:outline-ring aria-current:bg-accent"
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
                <span className="min-w-0 flex-1 truncate" dir="rtl">
                  <bdi dir="ltr">{path}</bdi>
                </span>
                {status && (
                  <span className="shrink-0" aria-label={gitStatus}>
                    {file?.mergeConflict ? 'Conflicted' : status}
                  </span>
                )}
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
})

const ReviewTree = memo(function ReviewTree({
  section = false,
  files,
  paths,
  selected,
  onSelect,
  theme,
}: {
  section?: boolean
  files: Snapshot['files']
  paths: string[]
  selected: string
  onSelect: (path: string) => void
  theme: 'light' | 'dark'
}) {
  const selection = useRef({ selected, onSelect })
  const syncingSelection = useRef(false)
  selection.current = { selected, onSelect }
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const [prepared, setPrepared] = useState(() => preparePresortedFileTreeInput([]))
  // Only rebuild the model when the path contents change.
  const pathsKey = useMemo(() => JSON.stringify(paths), [paths])
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
      worker.postMessage({ kind: 'tree', paths: JSON.parse(pathsKey) })
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error))
      worker?.terminate()
    }
    return () => {
      current = false
      worker?.terminate()
    }
  }, [pathsKey, attempt])
  const conflicts = useRef(new Set<string>())
  const { model } = useFileTree({
    preparedInput: prepared,
    density: 'default',
    stickyFolders: true,
    initialExpansion: 'open',
    renderRowDecoration: ({ item }) =>
      item.kind === 'file' && conflicts.current.has(item.path)
        ? {
            text: 'Conflicted',
            title: 'Would conflict when merging New into Old',
            parts: [{ text: 'Conflicted', color: 'var(--git-conflicted)' }],
          }
        : null,
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
    conflicts.current = new Set(files.filter((file) => file.mergeConflict).map((file) => file.path))
    model.resetPaths({ preparedInput: prepared })
    model.setGitStatus(
      files
        .filter((file) => !file.mergeConflict)
        .map((file) => ({ path: file.path, status: gitStatuses[file.status] ?? 'modified' })),
    )
  }, [model, prepared, files])
  useEffect(() => {
    syncingSelection.current = true
    try {
      for (const path of model.getSelectedPaths()) {
        if (path !== selected) model.getItem(path)?.deselect()
      }
      const item = model.getItem(selected)
      if (item) {
        const parts = selected.split('/')
        for (let index = 1; index < parts.length; index++) {
          const parent = model.getItem(parts.slice(0, index).join('/'))
          if (parent && 'expand' in parent) parent.expand()
        }
        item.select()
      }
    } finally {
      syncingSelection.current = false
    }
    if (!section) {
      model.scrollToPath(selected, { focus: false, offset: 'nearest' })
      return
    }
    const frame = requestAnimationFrame(() => {
      const host = model.getFileTreeContainer()
      const row = host?.shadowRoot?.querySelector<HTMLElement>(
        `[data-item-path="${CSS.escape(selected)}"]`,
      )
      if (!row) return
      const header = host?.closest('section')?.querySelector('[data-testid="review-step-header"]')
      // Reveal the selected row below the sticky heading, not the entire section.
      row.style.scrollMarginTop = `${header?.getBoundingClientRect().height ?? 0}px`
      row.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    })
    return () => cancelAnimationFrame(frame)
  }, [model, selected, prepared, section])
  const treeHeight = useFileTreeSelector(model, (tree) =>
    Math.max(tree.getItemHeight(), tree.getVisibleCount() * tree.getItemHeight()),
  )
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
      onClickCapture={(event) => {
        // Selection changes omit clicks on the already selected row.
        const row = event.nativeEvent
          .composedPath()
          .find((node) => node instanceof HTMLElement && node.dataset.itemType === 'file') as
          HTMLElement | undefined
        if (row?.dataset.itemPath === selected) onSelect(selected)
      }}
      className={`file-tree block min-h-0 flex-1 ${section ? '[--trees-padding-inline-override:0px]' : ''}`}
      style={{
        colorScheme: theme,
        ...(section ? { height: treeHeight, flex: 'none' } : {}),
      }}
    />
  )
})
