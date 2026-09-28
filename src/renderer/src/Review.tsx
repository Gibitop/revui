import { AIReviewProvider, AIReviewButton } from './AIReview'
import type { CodeLocation } from '../../shared/intelligence'
import type { AIState } from '../../shared/ai'
import type { GitLabReview } from '../../shared/gitlab'
import { GitLabProvider, GitLabButton } from './GitLab'
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

const emptyThreads: LocalThread[] = []

const defaultComparison: Comparison = {
  base: { kind: 'commit', ref: 'HEAD' },
  target: { kind: 'working' },
  mode: 'direct',
}

export function Review({
  initialMr,
  initialComparison,
  repository,
  settings,
  theme,
  preferences,
  toolbar,
  searchToolbar,
}: {
  initialMr?: number
  initialComparison?: Comparison
  toolbar: HTMLElement | null
  searchToolbar: HTMLElement | null
  repository: Repository
  settings: Settings
  theme: 'light' | 'dark'
  preferences: (patch: PreferencesPatch) => void
}) {
  const recent = useQuery({
    queryKey: ['recent-comparison', repository.path],
    enabled: !initialComparison,
    staleTime: 0,
    refetchOnMount: 'always',
    queryFn: () => window.desktop.recentComparison(repository.path),
    retry: false,
  })
  if (!initialComparison && recent.isPending) return <p className="p-6">Loading last comparison…</p>
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
        initialMr={initialMr}
        initial={initialComparison ?? recent.data ?? defaultComparison}
      />
    </>
  )
}

function ReviewSession({
  initialMr,
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
  initialMr?: number
}) {
  const [aiState, setAIState] = useState<AIState>()
  const [mrIid, setMrIid] = useState(initialMr)
  const [gitlabReview, setGitlabReview] = useState<GitLabReview>()
  const [initialComparison] = useState(initial)
  const [controls, setControls] = useState({ comparison: initial, version: 0 })
  const [searchHit, setSearchHit] = useState<
    (ContentMatch & { key: number; codeNavigation?: boolean; fileOnly?: boolean }) | null
  >(null)
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
  const [codeReviewSource, setCodeReviewSource] = useState('')
  const [headerFlash, setHeaderFlash] = useState({ path: '', visit: 0 })
  const diffScrollRef = useRef<HTMLDivElement>(null)
  const [activeWorkspace, setActiveWorkspace] = useState<string | null>(null)
  const workspaceTools = useRef<{ initialize: () => void }>(null)
  const [workspaceStatus, setWorkspaceStatus] = useState<{
    snapshot: string
    ready: boolean
    ideReady: boolean
    busy: boolean
  }>()

  const [scrollTarget, setScrollTarget] = useState<{ path: string } | null>(null)
  const [filter, setFilter] = useState('changed')
  const [fileOrder, setFileOrder] = useState('fs')
  const [search, setSearch] = useState('')
  const [threadVisit, setThreadVisit] = useState(0)
  const [threadFocus, setThreadFocus] = useState<string | null>(null)
  const codeHistory = useRef<{ locations: CodeLocation[]; index: number }>({
    locations: [],
    index: -1,
  })
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
    codeHistory.current = { locations: [], index: -1 }
    setFileOrder('fs')
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
      !records.data.threads.some((thread) => thread.id === threadFocus) &&
      !gitlabReview?.discussions.some((thread) => thread.id === threadFocus) &&
      !aiState?.record.findings.some(
        (finding) =>
          finding.id === threadFocus &&
          !aiState.record.stale &&
          (finding.state === 'pending' || finding.state === 'accepted'),
      )
    )
      setThreadFocus(null)
  }, [records.data, threadFocus, gitlabReview, aiState])
  // Sidebar preferences should not invalidate every mounted diff card.
  const fileSettings = useMemo(
    () => ({
      diffLayout: settings.diffLayout,
      wrapLines: settings.wrapLines,
      preferredIDE: settings.preferredIDE,
    }),
    [settings.diffLayout, settings.wrapLines, settings.preferredIDE],
  )
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
  const remoteThreads = useMemo(() => {
    if (!gitlabReview?.aligned) return []
    return gitlabReview.discussions.flatMap((discussion) => {
      const note = discussion.notes[0]
      const position = note?.position
      if (
        !note?.resolvable ||
        !position ||
        position.position_type !== 'text' ||
        !Number.isInteger(position.new_line ?? position.old_line) ||
        position.head_sha !== gitlabReview.pinned.head_sha ||
        position.base_sha !== gitlabReview.pinned.base_sha ||
        position.start_sha !== gitlabReview.pinned.start_sha
      )
        return []
      const file = snapshot.data?.files.find((file) =>
        position.new_line ? file.path === position.new_path : file.oldPath === position.old_path,
      )
      return file
        ? [
            {
              id: discussion.id,
              path: file.path,
              resolved: note.resolved,
              start: position.new_line ?? position.old_line!,
            },
          ]
        : []
    })
  }, [gitlabReview, snapshot.data])
  const unresolved = useMemo(
    () => [...(records.data?.threads ?? []), ...remoteThreads].filter((thread) => !thread.resolved),
    [records.data?.threads, remoteThreads],
  )
  const filterThreads = filter === 'unresolved' ? records.data?.threads : undefined
  const filterRemoteThreads = filter === 'unresolved' ? remoteThreads : undefined
  const paths = useMemo(() => {
    const unresolvedPaths = new Set(
      [...(filterThreads ?? []), ...(filterRemoteThreads ?? [])]
        .filter((thread) => !thread.resolved)
        .map((thread) => thread.path),
    )
    const paths =
      filter === 'all'
        ? (snapshot.data?.paths ?? [])
        : filter === 'unresolved'
          ? [...unresolvedPaths]
          : (snapshot.data?.files.map((file) => file.path) ?? [])
    const orderedPaths =
      fileOrder === 'ai'
        ? aiState?.snapshot === snapshot.data?.id &&
          !aiState?.order.running &&
          !aiState?.order.error
          ? (
              aiState?.record.walkthrough.flatMap((section) => {
                if (settings.fileView === 'flat') return section.paths
                const included = new Set(section.paths)
                return snapshot.data?.paths.filter((path) => included.has(path)) ?? []
              }) ?? []
            ).filter((path) => paths.includes(path))
          : []
        : paths
    return orderedPaths.filter((path) => path.toLowerCase().includes(search.toLowerCase()))
  }, [
    snapshot.data,
    filterThreads,
    filterRemoteThreads,
    filter,
    search,
    fileOrder,
    settings.fileView,
    aiState,
  ])
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
  const navigableThreads = useMemo(() => {
    if (!unresolved.length) return []
    const threadPaths = fileOrder === 'ai' ? paths : [...(snapshot.data?.paths ?? []), ...paths]
    const threadOrder = new Map([...new Set(threadPaths)].map((path, index) => [path, index]))
    return unresolved
      .filter((thread) => filter !== 'unresolved' || paths.includes(thread.path))
      .sort(
        (a, b) =>
          (threadOrder.get(a.path) ?? threadPaths.length) -
            (threadOrder.get(b.path) ?? threadPaths.length) ||
          a.path.localeCompare(b.path, undefined, { numeric: true }) ||
          a.start - b.start ||
          a.id.localeCompare(b.id),
      )
  }, [fileOrder, paths, snapshot.data?.paths, unresolved, filter])
  const select = useCallback(
    (path: string, flashHeader = false) => {
      if (flashHeader) setHeaderFlash((previous) => ({ path, visit: previous.visit + 1 }))
      if (!paths.includes(path)) {
        setFilter('changed')
        setSearch('')
      }
      setSelected(path)
      setSearchHit(null)
      const thread =
        filter === 'unresolved'
          ? navigableThreads.find((thread) => thread.path === path)
          : undefined
      setThreadFocus(thread?.id ?? null)
      if (thread) setThreadVisit((value) => value + 1)
      setScrollTarget(thread ? null : { path })
    },
    [paths, filter, navigableThreads],
  )
  const navigationPaths = fileOrder === 'ai' ? paths : changed
  const navigate = (direction: number, threads = false) => {
    if (threads || filter === 'unresolved') {
      if (!navigableThreads.length) return
      const index = navigableThreads.findIndex((thread) => thread.id === threadFocus)
      const thread =
        navigableThreads[
          index < 0
            ? direction > 0
              ? 0
              : navigableThreads.length - 1
            : (index + direction + navigableThreads.length) % navigableThreads.length
        ]
      setScrollTarget(null)
      setSelected(thread.path)
      setSearchHit(null)
      setThreadFocus(thread.id)
      setThreadVisit((value) => value + 1)
    } else if (navigationPaths.length) {
      const index = navigationPaths.indexOf(selected)
      select(
        navigationPaths[
          index < 0
            ? direction > 0
              ? 0
              : navigationPaths.length - 1
            : (index + direction + navigationPaths.length) % navigationPaths.length
        ],
      )
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
      (event.metaKey || event.ctrlKey) &&
      !event.altKey &&
      !event.shiftKey &&
      (event.key === '[' || event.key === ']')
    ) {
      event.preventDefault()
      const history = codeHistory.current
      const index = history.index + (event.key === '[' ? -1 : 1)
      if (index >= 0 && index < history.locations.length) {
        history.index = index
        navigateCode(history.locations[index])
      }
      return
    }
    if (
      event.shiftKey &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey &&
      event.key.toLowerCase() === 'f'
    ) {
      event.preventDefault()
      if (!event.repeat) preferences({ sidebarCollapsed: !settings.sidebarCollapsed })
      return
    }
    if (
      !event.altKey &&
      !event.shiftKey &&
      (event.key === 'ArrowUp' || event.key === 'ArrowDown')
    ) {
      event.preventDefault()
      navigate(event.key === 'ArrowDown' ? 1 : -1, event.metaKey || event.ctrlKey)
    }
    if (event.altKey && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault()
      navigate(event.key === 'ArrowDown' ? 1 : -1, event.shiftKey)
    }
  })
  useEffect(() => {
    const key = (event: KeyboardEvent) => onReviewKey(event)
    const captureNavigation = (event: KeyboardEvent) => {
      if (
        (event.key === 'ArrowUp' || event.key === 'ArrowDown') &&
        event.target instanceof HTMLElement &&
        event.target.closest('.file-tree, .flat-file-list, [data-testid="diff-scroll"]')
      ) {
        // Handle navigation before the tree or diff consumes the arrow key.
        onReviewKey(event)
        if (event.defaultPrevented) event.stopPropagation()
      }
    }
    window.addEventListener('keydown', captureNavigation, true)
    window.addEventListener('keydown', key)
    return () => {
      window.removeEventListener('keydown', captureNavigation, true)
      window.removeEventListener('keydown', key)
    }
  }, [])

  const navigateCode = useCallback(
    (location: CodeLocation, origin?: CodeLocation) => {
      if (origin) {
        if (filesByPath.has(origin.path)) setCodeReviewSource(origin.path)
        const history = codeHistory.current
        history.locations.splice(history.index + 1)
        const current = history.locations[history.index]
        // Moving within the current file updates its return position; it is not another jump.
        if (current?.path === origin.path) history.locations[history.index] = origin
        else history.locations.push(origin)
        history.locations.push(location)
        history.index = history.locations.length - 1
      }
      setScrollTarget(null)
      setSelected(location.path)
      setThreadFocus(null)
      setSearchHit({
        path: location.path,
        line: location.line,
        codeNavigation: true,
        fileOnly: location.fileOnly,
        text: '',
        ranges: [],
        key: Date.now(),
      })
    },
    [filesByPath],
  )

  const codeDestination =
    searchHit?.codeNavigation && !paths.includes(searchHit.path) ? searchHit.path : null
  const threadFocused = !!threadFocus && !paths.includes(selected)
  const reviewPath = codeDestination ? codeReviewSource : selected
  const visiblePaths =
    settings.reviewLayout === 'focused' ||
    threadFocused ||
    (!!searchHit && !searchHit.codeNavigation && !paths.includes(searchHit.path)) ||
    (!filesByPath.has(selected) && !threadFocus && !searchHit)
      ? reviewPath
        ? [reviewPath]
        : []
      : paths.filter(
          (path) => filesByPath.has(path) || path === selected || path === searchHit?.path,
        )

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

  const syncScrolledFile = useEffectEvent(() => {
    if (codeDestination || scrollTarget || visiblePaths.length < 2) return
    const scroll = diffScrollRef.current?.firstElementChild
    const content = scroll?.firstElementChild
    if (!scroll || !content) return
    const top = scroll.getBoundingClientRect().top + 1
    let active = content.firstElementChild
    for (const card of content.children) {
      if (card.getBoundingClientRect().top > top) break
      active = card
    }
    if (scroll.scrollTop > 0 && scroll.scrollTop + scroll.clientHeight >= scroll.scrollHeight - 1)
      active = content.lastElementChild
    const path = active?.getAttribute('aria-label')
    if (path && path !== selected && visiblePaths.includes(path)) {
      setSelected(path)
      setThreadFocus(null)
    }
  })
  useEffect(() => {
    const scroll = diffScrollRef.current?.firstElementChild
    if (!scroll) return
    let frame = 0
    const onScroll = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => syncScrolledFile())
    }
    scroll.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      scroll.removeEventListener('scroll', onScroll)
      cancelAnimationFrame(frame)
    }
  }, [])

  return (
    <>
      {toolbar &&
        createPortal(
          <div className="flex items-center gap-2">
            <ComparisonControls
              key={controls.version}
              repository={repository}
              initial={controls.comparison}
              isPending={snapshot.isPending}
              onCompare={(comparison, refresh) => {
                const change = ++comparisonChange.current
                void window.desktop
                  .leaveWorkspace(repository.path)
                  .then((allowed) => {
                    if (allowed && change === comparisonChange.current) {
                      if (!refresh) {
                        setMrIid(undefined)
                        setControls((current) => ({ comparison, version: current.version }))
                      }
                      openComparison(comparison, refresh)
                    }
                  })
                  .catch((error) => setSnapshot((current) => ({ ...current, error })))
              }}
            />
            {snapshot.data && (
              <WorkspaceTools
                key={snapshot.data.id}
                ref={workspaceTools}
                onStatus={setWorkspaceStatus}
                snapshot={snapshot.data}
                active={activeWorkspace}
                setActive={setActiveWorkspace}
                settings={settings}
              />
            )}
          </div>,
          toolbar,
        )}
      <GitLabProvider
        iid={mrIid}
        localThreads={records.data?.threads}
        snapshot={snapshot.data}
        onReviewChange={setGitlabReview}
        onNavigateThread={(path, discussion) => {
          setScrollTarget(null)
          setSelected(path)
          setSearchHit(null)
          setThreadFocus(discussion)
          setThreadVisit((value) => value + 1)
        }}
        onCompare={(comparison) => {
          void window.desktop
            .leaveWorkspace(repository.path)
            .then((allowed) => {
              if (allowed) {
                setControls((current) => ({ comparison, version: current.version + 1 }))
                openComparison(comparison, true)
              }
            })
            .catch((error) => setSnapshot((current) => ({ ...current, error })))
        }}
      >
        {searchToolbar &&
          createPortal(
            <>
              <ContentSearch
                snapshotId={snapshot.data?.id}
                paths={paths}
                filesByPath={filesByPath}
                theme={theme}
                inputRef={contentSearchRef}
                open={searchOpen}
                onOpenChange={setSearchOpen}
                onSelect={(match) => {
                  setScrollTarget(null)
                  setSelected(match.path)
                  setThreadFocus(null)
                  setSearchHit({ ...match, key: Date.now() })
                }}
                onClear={() => setSearchHit(null)}
                hasHit={!!searchHit}
              />
              <GitLabButton />
              {snapshot.data && (
                <AIReviewButton
                  open={settings.aiPanelOpen}
                  onClick={() => preferences({ aiPanelOpen: !settings.aiPanelOpen })}
                />
              )}
            </>,
            searchToolbar,
          )}
        <div className="flex min-h-0 flex-1 overflow-hidden">
          <AIReviewProvider
            workspace={{
              ready: workspaceStatus?.snapshot === snapshot.data?.id && !!workspaceStatus?.ready,
              busy: workspaceStatus?.snapshot === snapshot.data?.id && !!workspaceStatus?.busy,
              initialize: () => workspaceTools.current?.initialize(),
            }}
            settings={settings}
            preferences={preferences}
            snapshot={snapshot.data}
            open={settings.aiPanelOpen}
            onOpen={(aiPanelOpen) => preferences({ aiPanelOpen })}
            onState={setAIState}
            onFile={(path, line) => {
              select(path)
              if (!filesByPath.has(path)) {
                setFilter('all')
                setFileOrder('fs')
              } else if (!paths.includes(path) && fileOrder === 'ai') setFileOrder('fs')
              if (line && filesByPath.get(path)?.status !== 'D')
                setSearchHit({ path, line, text: '', ranges: [], key: Date.now() })
            }}
          >
            <ReviewSidebar
              order={fileOrder}
              setOrder={setFileOrder}
              snapshot={snapshot.data}
              settings={settings}
              preferences={preferences}
              filter={filter}
              setFilter={(value) => {
                setFilter(value)
                if (value !== 'unresolved') return
                const candidates = navigableThreads.filter((thread) =>
                  thread.path.toLowerCase().includes(search.toLowerCase()),
                )
                const thread =
                  candidates.find((thread) => thread.path === selected) ?? candidates[0]
                if (!thread) return
                setScrollTarget(null)
                setSelected(thread.path)
                setSearchHit(null)
                setThreadFocus(thread.id)
                setThreadVisit((visit) => visit + 1)
              }}
              search={search}
              setSearch={setSearch}
              searchRef={searchRef}
              paths={paths}
              totals={totals}
              selected={selected}
              select={(path) => select(path, true)}
              theme={theme}
              canNavigate={
                filter === 'unresolved' ? !!navigableThreads.length : !!navigationPaths.length
              }
              navigate={(direction) => navigate(direction)}
              threadFocused={threadFocused}
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
                  {fileOrder === 'ai' &&
                  !aiState?.order.error &&
                  (!aiState || aiState.order.running || !aiState.record.walkthroughKey)
                    ? 'Your review guide is being prepared. You can switch to Filesystem order to browse now.'
                    : paths.length
                      ? 'Select a file to review.'
                      : 'No files match this view.'}
                </p>
              )}

              <div className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
                {[
                  { key: 'review', paths: visiblePaths },
                  ...(codeDestination ? [{ key: 'destination', paths: [codeDestination] }] : []),
                ].map((pane) => (
                  <div
                    key={pane.key}
                    ref={pane.key === 'review' ? diffScrollRef : undefined}
                    data-testid={
                      pane.key === 'review' && codeDestination
                        ? 'preserved-diff-scroll'
                        : 'diff-scroll'
                    }
                    aria-hidden={pane.key === 'review' && !!codeDestination ? true : undefined}
                    className={
                      pane.key === 'destination'
                        ? 'absolute inset-0 flex min-h-0 min-w-0'
                        : `flex min-h-0 min-w-0 flex-1 ${codeDestination ? 'invisible' : ''}`
                    }
                  >
                    <Virtualizer className="min-h-0 min-w-0 flex-1 overflow-auto overscroll-contain">
                      {snapshot.data &&
                        pane.paths.map((path) => (
                          <ReviewFileCard
                            key={`${snapshot.data!.id}:${path}`}
                            onNavigate={navigateCode}
                            workspaceId={activeWorkspace}
                            intelligenceReady={
                              workspaceStatus?.snapshot === snapshot.data!.id &&
                              workspaceStatus.ready &&
                              workspaceStatus.ideReady &&
                              !workspaceStatus.busy
                            }
                            workspaceReady={
                              workspaceStatus?.snapshot === snapshot.data!.id &&
                              workspaceStatus.ideReady &&
                              !workspaceStatus.busy
                            }
                            snapshot={snapshot.data!}
                            path={path}
                            record={records.data}
                            metadata={filesByPath.get(path)}
                            threads={threadsByPath.get(path) ?? emptyThreads}
                            settings={fileSettings}
                            theme={theme}
                            headerFlash={headerFlash.path === path ? headerFlash.visit : 0}
                            threadFocus={path === selected ? threadFocus : null}
                            threadVisit={path === selected && threadFocus ? threadVisit : 0}
                            searchHit={searchHit?.path === path ? searchHit : null}
                          />
                        ))}
                    </Virtualizer>
                  </div>
                ))}
              </div>
            </section>
          </AIReviewProvider>
        </div>
      </GitLabProvider>
    </>
  )
}
