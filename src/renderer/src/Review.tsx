import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Virtualizer } from '@pierre/diffs/react'
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react'
import type { Comparison, ContentMatch, LocalThread, Snapshot } from '../../shared/review'
import type { PreferencesPatch, Repository, Settings } from '../../shared/desktop'
import { Button } from '@/components/ui/button'
import { ComparisonControls } from './ComparisonControls'
import { ReviewSidebar } from './ReviewSidebar'
import { ReviewFileCard } from './ReviewFileCard'
import { ContentSearch } from './ContentSearch'

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
}: {
  toolbar: HTMLElement | null
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
}: {
  toolbar: HTMLElement | null
  repository: Repository
  settings: Settings
  theme: 'light' | 'dark'
  preferences: (patch: PreferencesPatch) => void
  initial: Comparison
}) {
  const [initialComparison] = useState(initial)
  const [sidebarWidth, setSidebarWidth] = useState(settings.sidebarWidth)
  const [searchHit, setSearchHit] = useState<(ContentMatch & { key: number }) | null>(null)
  const contentSearchRef = useRef<HTMLInputElement>(null)

  const queryClient = useQueryClient()
  const request = useRef<{ id: string; snapshotId?: string } | null>(null)
  const [snapshot, setSnapshot] = useState<{ data?: Snapshot; error?: Error; isPending: boolean }>({
    isPending: true,
  })
  const openComparison = useCallback(
    (comparison: Comparison) => {
      const previous = request.current
      if (previous) {
        void window.desktop.cancelComparison(previous.id)
        for (const key of ['review-record', 'review-file', 'content-search'])
          queryClient.removeQueries({ queryKey: [key, previous.snapshotId] })
      }
      const current = { id: crypto.randomUUID(), snapshotId: undefined as string | undefined }
      request.current = current
      setSnapshot({ isPending: true })
      void window.desktop
        .openComparison(repository.path, comparison, current.id)
        .then((data) => {
          if (request.current !== current) return
          current.snapshotId = data.id
          setSnapshot({ data, isPending: false })
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
      void window.desktop.cancelComparison(current.id)
      for (const key of ['review-record', 'review-file', 'content-search'])
        queryClient.removeQueries({ queryKey: [key, current.snapshotId] })
    }
  }, [initialComparison, openComparison, queryClient])
  const [selected, setSelected] = useState('')
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
    const paths =
      filter === 'all'
        ? (snapshot.data?.paths ?? [])
        : filter === 'unresolved'
          ? [
              ...new Set(
                filterThreads?.filter((thread) => !thread.resolved).map((thread) => thread.path),
              ),
            ]
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
    requestAnimationFrame(() => {
      const file = document.getElementById(`file-${encodeURIComponent(path)}`)
      const scroll = file?.closest('[data-testid="diff-scroll"]')?.firstElementChild
      if (file && scroll)
        scroll.scrollTop += file.getBoundingClientRect().top - scroll.getBoundingClientRect().top
    })
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
    if (document.querySelector('[role="dialog"][data-state="open"]')) return
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
      contentSearchRef.current?.focus()
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

  return (
    <>
      {toolbar &&
        createPortal(
          <ComparisonControls
            repository={repository}
            initial={initialComparison}
            onCompare={openComparison}
          />,
          toolbar,
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
          unresolvedCount={unresolved.length}
          totals={totals}
          selected={selected}
          select={select}
          theme={theme}
        />
        <section className="flex min-w-0 flex-1 flex-col" aria-label="Code review">
          <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b px-3 py-2 [&>*]:shrink-0">
            <Button
              variant="ghost"
              size="icon"
              aria-label={settings.sidebarCollapsed ? 'Show file sidebar' : 'Hide file sidebar'}
              title={settings.sidebarCollapsed ? 'Show file sidebar' : 'Hide file sidebar'}
              aria-expanded={!settings.sidebarCollapsed}
              aria-controls="review-files-sidebar"
              onClick={() => preferences({ sidebarCollapsed: !settings.sidebarCollapsed })}
            >
              {settings.sidebarCollapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
            </Button>
            <Button
              variant="ghost"
              disabled={!changed.length}
              title="Previous change (Alt+↑)"
              onClick={() => navigate(-1)}
            >
              ← Change
            </Button>
            <Button
              variant="ghost"
              disabled={!changed.length}
              title="Next change (Alt+↓)"
              onClick={() => navigate(1)}
            >
              Change →
            </Button>
            {!!unresolved.length && (
              <>
                <Button variant="ghost" onClick={() => navigate(-1, true)}>
                  ← Thread
                </Button>
                <Button variant="ghost" onClick={() => navigate(1, true)}>
                  Thread →
                </Button>
              </>
            )}
            {threadFocus && (
              <Button variant="ghost" onClick={() => setThreadFocus(null)}>
                All changes
              </Button>
            )}
            <ContentSearch
              snapshotId={snapshot.data?.id}
              inputRef={contentSearchRef}
              onSelect={(match) => {
                setSelected(match.path)
                setThreadFocus(null)
                setSearchHit({ ...match, key: Date.now() })
              }}
              onClear={() => setSearchHit(null)}
              hasHit={!!searchHit}
            />
          </div>
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
