import { WorkspaceTools } from './WorkspaceTools'
import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Virtualizer } from '@pierre/diffs/react'
import type { Comparison, ContentMatch, LocalThread, Snapshot } from '../../shared/review'
import type { PreferencesPatch, Repository, Settings } from '../../shared/desktop'
import { Button } from '@/components/ui/button'
import { ComparisonControls } from './ComparisonControls'
import { ReviewSidebar } from './ReviewSidebar'
import { ReviewFileCard } from './ReviewFileCard'
import { ContentSearch } from './ContentSearch'
import ReviewWorker from './review.worker?worker'

const defaultComparison: Comparison = {
  base: { kind: 'commit', ref: 'HEAD' },
  target: { kind: 'working' },
  mode: 'direct',
}

export function Review({
  repository,
  settings,
  theme,
  preferences,
  toolbar,
  searchToolbar,
}: {
  toolbar: HTMLElement | null
  searchToolbar: HTMLElement | null
  repository: Repository
  settings: Settings
  theme: 'light' | 'dark'
  preferences: (patch: PreferencesPatch) => void
}) {
  const recent = useQuery({
    queryKey: ['recent-comparison', repository.path],
    staleTime: 0,
    refetchOnMount: 'always',
    queryFn: () => window.desktop.recentComparison(repository.path),
    retry: false,
  })
  if (recent.isPending) return <p className="p-6">Loading last comparison…</p>
  return (
    <>
      {recent.error && (
        <p role="alert" className="border-b bg-muted px-6 py-3">
          {recent.error.message}
        </p>
      )}
      <ReviewSession
        key={repository.path}
        repository={repository}
        settings={settings}
        theme={theme}
        preferences={preferences}
        toolbar={toolbar}
        searchToolbar={searchToolbar}
        initial={recent.data ?? defaultComparison}
      />
    </>
  )
}

function ReviewSession({
  repository,
  settings,
  theme,
  preferences,
  initial,
  toolbar,
  searchToolbar,
}: {
  toolbar: HTMLElement | null
  searchToolbar: HTMLElement | null
  repository: Repository
  settings: Settings
  theme: 'light' | 'dark'
  preferences: (patch: PreferencesPatch) => void
  initial: Comparison
}) {
  const [initialComparison] = useState(initial)
  const [sidebarWidth, setSidebarWidth] = useState(settings.sidebarWidth)
  const [searchHit, setSearchHit] = useState<(ContentMatch & { key: number }) | null>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const contentSearchRef = useRef<HTMLInputElement>(null)

  const queryClient = useQueryClient()
  const request = useRef<{ id: string; snapshotId?: string; worker?: Worker } | null>(null)
  const [snapshot, setSnapshot] = useState<{ data?: Snapshot; error?: Error; isPending: boolean }>({
    isPending: true,
  })
  const openComparison = useCallback(
    (comparison: Comparison, refresh = false) => {
      const previous = request.current
      if (previous) {
        previous.worker?.terminate()
        void window.desktop.cancelComparison(previous.id)
        for (const key of ['review-record', 'review-file', 'content-search'])
          queryClient.removeQueries({ queryKey: [key, previous.snapshotId] })
      }
      const current = {
        id: crypto.randomUUID(),
        snapshotId: undefined as string | undefined,
        worker: undefined as Worker | undefined,
      }
      request.current = current
      setSnapshot({ isPending: true })
      void window.desktop
        .openComparison(repository.path, comparison, current.id, refresh)
        .then(async (data) => {
          if (request.current !== current) return
          if (refresh) void queryClient.invalidateQueries({ queryKey: ['refs', repository.path] })
          current.snapshotId = data.id
          const worker = new ReviewWorker()
          current.worker = worker
          try {
            const ordered = await new Promise<Snapshot>((resolve, reject) => {
              worker.onmessage = (event) => {
                if (event.data.error) reject(new Error(event.data.error))
                else resolve(event.data.result)
              }
              worker.onerror = (event) => {
                event.preventDefault()
                reject(new Error(event.message))
              }
              worker.postMessage({ kind: 'snapshot', snapshot: data })
            })
            if (request.current === current) setSnapshot({ data: ordered, isPending: false })
          } finally {
            worker.terminate()
            current.worker = undefined
          }
        })
        .catch((error: unknown) => {
          if (request.current === current)
            setSnapshot({
              error: error instanceof Error ? error : new Error(String(error)),
              isPending: false,
            })
        })
    },
    [repository.path, queryClient],
  )
  useEffect(() => {
    openComparison(initialComparison)
    return () => {
      const current = request.current
      request.current = null
      if (!current) return
      current.worker?.terminate()
      void window.desktop.cancelComparison(current.id)
      for (const key of ['review-record', 'review-file', 'content-search'])
        queryClient.removeQueries({ queryKey: [key, current.snapshotId] })
    }
  }, [initialComparison, openComparison, queryClient])
  const comparisonChange = useRef(0)
  const [selected, setSelected] = useState('')
  const [activeWorkspace, setActiveWorkspace] = useState<string | null>(null)

  const [scrollTarget, setScrollTarget] = useState<{ path: string } | null>(null)
  const [filter, setFilter] = useState('changed')
  const [search, setSearch] = useState('')
  const [threadVisit, setThreadVisit] = useState(0)
  const [threadFocus, setThreadFocus] = useState<string | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const focusFileSearch = useRef(false)
  useEffect(() => {
    if (!settings.sidebarCollapsed && focusFileSearch.current) {
      searchRef.current?.focus()
      focusFileSearch.current = false
    }
  }, [settings.sidebarCollapsed])
  const records = useQuery({
    queryKey: ['review-record', snapshot.data?.id],
    queryFn: () => window.desktop.getReviewRecord(snapshot.data!.id),
    enabled: !!snapshot.data,
    retry: false,
  })
  useEffect(() => {
    setSelected(snapshot.data?.files[0]?.path ?? '')
    setActiveWorkspace(null)
    setScrollTarget(null)
    setThreadFocus(null)
    setSearchHit(null)
  }, [snapshot.data])
  useEffect(() => {
    if (
      threadFocus &&
      records.data &&
      !records.data.threads.some((thread) => thread.id === threadFocus)
    )
      setThreadFocus(null)
  }, [records.data, threadFocus])
  const filesByPath = useMemo(
    () => new Map(snapshot.data?.files.map((file) => [file.path, file])),
    [snapshot.data],
  )
  const changed = useMemo(() => [...filesByPath.keys()], [filesByPath])
  const threadsByPath = useMemo(() => {
    const result = new Map<string, LocalThread[]>()
    for (const thread of records.data?.threads ?? []) {
      const threads = result.get(thread.path) ?? []
      threads.push(thread)
      result.set(thread.path, threads)
    }
    return result
  }, [records.data])
  const unresolved = records.data?.threads.filter((thread) => !thread.resolved) ?? []
  const filterThreads = filter === 'unresolved' ? records.data?.threads : undefined
  const paths = useMemo(() => {
    const unresolvedPaths = new Set(
      filterThreads?.filter((thread) => !thread.resolved).map((thread) => thread.path),
    )
    const paths =
      filter === 'all'
        ? (snapshot.data?.paths ?? [])
        : filter === 'unresolved'
          ? (snapshot.data?.paths ?? []).filter((path) => unresolvedPaths.has(path))
          : (snapshot.data?.files.map((file) => file.path) ?? [])
    return paths.filter((path) => path.toLowerCase().includes(search.toLowerCase()))
  }, [snapshot.data, filterThreads, filter, search])
  const totals = useMemo(() => {
    const included = new Set(paths)
    return (snapshot.data?.files ?? []).reduce(
      (sum, file) =>
        included.has(file.path)
          ? {
              additions: sum.additions + (file.additions ?? 0),
              deletions: sum.deletions + (file.deletions ?? 0),
            }
          : sum,
      { additions: 0, deletions: 0 },
    )
  }, [paths, snapshot.data])
  const select = (path: string) => {
    if (!paths.includes(path)) {
      setFilter('changed')
      setSearch('')
    }
    setSelected(path)
    setSearchHit(null)
    setThreadFocus(null)
    setScrollTarget({ path })
  }
  const navigate = (direction: number, threads = false) => {
    if (threads) {
      if (!unresolved.length) return
      const index = unresolved.findIndex((thread) => thread.id === threadFocus)
      const thread = unresolved[(index + direction + unresolved.length) % unresolved.length]
      setSelected(thread.path)
      setSearchHit(null)
      setThreadFocus(thread.id)
      setThreadVisit((value) => value + 1)
    } else if (changed.length) {
      select(changed[(changed.indexOf(selected) + direction + changed.length) % changed.length])
    }
  }
  const onReviewKey = useEffectEvent((event: KeyboardEvent) => {
    if (event.defaultPrevented || document.querySelector('[role="dialog"][data-state="open"]'))
      return
    if (
      event.target instanceof HTMLElement &&
      event.target.closest('textarea, [contenteditable="true"], [data-review-editor]')
    )
      return
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'p') {
      event.preventDefault()
      if (settings.sidebarCollapsed) {
        focusFileSearch.current = true
        preferences({ sidebarCollapsed: false })
      } else searchRef.current?.focus()
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') {
      event.preventDefault()
      setSearchOpen(true)
    }
    if (
      event.target instanceof HTMLElement &&
      event.target.closest('input, select, [role="combobox"]')
    )
      return
    if (
      !event.altKey &&
      !event.shiftKey &&
      (event.key === 'ArrowLeft' || event.key === 'ArrowRight')
    ) {
      event.preventDefault()
      navigate(event.key === 'ArrowRight' ? 1 : -1, event.metaKey || event.ctrlKey)
    }
    if (event.altKey && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault()
      navigate(event.key === 'ArrowDown' ? 1 : -1, event.shiftKey)
    }
  })
  useEffect(() => {
    const key = (event: KeyboardEvent) => onReviewKey(event)
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [])

  const visiblePaths =
    settings.reviewLayout === 'focused' || !filesByPath.has(selected) || threadFocus || searchHit
      ? selected
        ? [selected]
        : []
      : paths.filter((path) => filesByPath.has(path))

  useEffect(() => {
    if (!scrollTarget || threadFocus || searchHit) return
    const file = document.getElementById(`file-${encodeURIComponent(scrollTarget.path)}`)
    const scroll = file?.closest('[data-testid="diff-scroll"]')?.firstElementChild
    const content = scroll?.firstElementChild
    if (!file || !scroll || !content) return

    // Loading, parsing and virtualized rendering can all change the target's offset.
    // Keep the navigation anchored until the user takes control of the viewport.
    let frame = 0
    const align = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        scroll.scrollTop += file.getBoundingClientRect().top - scroll.getBoundingClientRect().top
      })
    }
    const observer = new ResizeObserver(align)
    observer.observe(scroll)
    observer.observe(content)
    for (const card of content.children) {
      observer.observe(card)
      if (card === file) break
    }
    const cancel = () => {
      observer.disconnect()
      cancelAnimationFrame(frame)
      setScrollTarget(null)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey) return
      if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key))
        cancel()
    }
    scroll.addEventListener('wheel', cancel, { passive: true })
    scroll.addEventListener('touchstart', cancel, { passive: true })
    window.addEventListener('pointerdown', cancel)
    window.addEventListener('keydown', onKey)
    align()
    return () => {
      observer.disconnect()
      cancelAnimationFrame(frame)
      scroll.removeEventListener('wheel', cancel)
      scroll.removeEventListener('touchstart', cancel)
      window.removeEventListener('pointerdown', cancel)
      window.removeEventListener('keydown', onKey)
    }
  }, [scrollTarget, snapshot.data, paths, settings.reviewLayout, threadFocus, searchHit])

  return (
    <>
      {toolbar &&
        createPortal(
          <div className="flex items-center gap-2">
            <ComparisonControls
              repository={repository}
              initial={initialComparison}
              isPending={snapshot.isPending}
              onCompare={(comparison, refresh) => {
                const change = ++comparisonChange.current
                void window.desktop
                  .leaveWorkspace(repository.path)
                  .then((allowed) => {
                    if (allowed && change === comparisonChange.current)
                      openComparison(comparison, refresh)
                  })
                  .catch((error) => setSnapshot((current) => ({ ...current, error })))
              }}
            />
            {snapshot.data && (
              <WorkspaceTools
                key={snapshot.data.id}
                snapshot={snapshot.data}
                active={activeWorkspace}
                setActive={setActiveWorkspace}
                settings={settings}
              />
            )}
          </div>,
          toolbar,
        )}
      {searchToolbar &&
        createPortal(
          <ContentSearch
            snapshotId={snapshot.data?.id}
            paths={paths}
            filesByPath={filesByPath}
            theme={theme}
            inputRef={contentSearchRef}
            open={searchOpen}
            onOpenChange={setSearchOpen}
            onSelect={(match) => {
              setSelected(match.path)
              setThreadFocus(null)
              setSearchHit({ ...match, key: Date.now() })
            }}
            onClear={() => setSearchHit(null)}
            hasHit={!!searchHit}
          />,
          searchToolbar,
        )}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <ReviewSidebar
          snapshot={snapshot.data}
          settings={settings}
          sidebarWidth={sidebarWidth}
          setSidebarWidth={setSidebarWidth}
          preferences={preferences}
          filter={filter}
          setFilter={setFilter}
          search={search}
          setSearch={setSearch}
          searchRef={searchRef}
          paths={paths}
          totals={totals}
          selected={selected}
          select={select}
          theme={theme}
          canNavigate={!!changed.length}
          navigate={(direction) => navigate(direction)}
          threadFocused={!!threadFocus}
          onShowAll={() => setThreadFocus(null)}
        />
        <section className="flex min-w-0 flex-1 flex-col" aria-label="Code review">
          {snapshot.isPending && (
            <p className="p-6">
              Loading comparison…{' '}
              <Button
                variant="ghost"
                onClick={() => {
                  const current = request.current
                  request.current = null
                  if (current) void window.desktop.cancelComparison(current.id)
                  setSnapshot({ isPending: false })
                }}
              >
                Cancel
              </Button>
            </p>
          )}
          {(snapshot.error || records.error) && (
            <p className="p-6" role="alert">
              {snapshot.error?.message ?? records.error?.message}
            </p>
          )}
          {snapshot.data && !visiblePaths.length && (
            <p className="p-6">
              {paths.length ? 'Select a file to review.' : 'No files match this view.'}
            </p>
          )}

          <div data-testid="diff-scroll" className="flex min-h-0 flex-1">
            <Virtualizer className="min-h-0 flex-1 overflow-auto overscroll-contain">
              {snapshot.data &&
                visiblePaths.map((path) => (
                  <ReviewFileCard
                    key={`${snapshot.data!.id}:${path}`}
                    workspaceId={activeWorkspace}
                    snapshot={snapshot.data!}
                    path={path}
                    record={records.data}
                    metadata={filesByPath.get(path)}
                    threads={threadsByPath.get(path) ?? []}
                    settings={settings}
                    theme={theme}
                    threadFocus={threadFocus}
                    threadVisit={threadVisit}
                    searchHit={searchHit?.path === path ? searchHit : null}
                  />
                ))}
            </Virtualizer>
          </div>
        </section>
      </div>
    </>
  )
}
