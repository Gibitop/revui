import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { createPortal } from 'react-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { File, FileDiff, Virtualizer, type FileDiffMetadata } from '@pierre/diffs/react'
import { VirtualizedFile, VirtualizedFileDiff, type SelectedLineRange, type DiffLineAnnotation } from '@pierre/diffs'
import { preparePresortedFileTreeInput, type GitStatus } from '@pierre/trees'
import { FileTree, useFileTree } from '@pierre/trees/react'
import ReviewWorker from './review.worker?worker'
import type { Comparison, ContentMatch, LocalThread, ReviewAction, ReviewRecord, Snapshot } from '../../shared/review'
import type { PreferencesPatch, Repository, Settings } from '../../shared/desktop'
import { Files, FileDiff as FileDiffIcon, MessagesSquare, Search, X, ChevronDown, ChevronRight, Trash2, PanelLeftClose, PanelLeftOpen, Copy, Check, ArrowLeftRight } from 'lucide-react'
import { RevisionSelect } from './RevisionSelect'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Tooltip } from './components/ui/tooltip'
import { Button } from './components/ui/button'

const gitStatuses: Record<string, GitStatus> = { A: 'added', D: 'deleted', M: 'modified', T: 'modified', U: 'modified', R: 'renamed', C: 'added', '?': 'untracked' }
const defaultComparison: Comparison = { base: { kind: 'commit', ref: 'HEAD' }, target: { kind: 'working' }, mode: 'direct' }
const codeCSS = ':host { --diffs-font-family: "Geist Mono Variable", monospace; --diffs-font-size: 13px; --diffs-line-height: 20px; }'

export function Review({ repository, settings, theme, preferences }: { repository: Repository; settings: Settings; theme: 'light' | 'dark'; preferences: (patch: PreferencesPatch) => void }) {
  const recent = useQuery({ queryKey: ['recent-comparison', repository.path], staleTime: 0, refetchOnMount: 'always', queryFn: () => window.desktop.recentComparison(repository.path), retry: false })
  if (recent.isPending || recent.isFetching) return <p className="review-message">Loading last comparison…</p>
  return <>{recent.error && <p role="alert" className="notice">{recent.error.message}</p>}<ReviewSession key={repository.path} repository={repository} settings={settings} theme={theme} preferences={preferences} initial={recent.data ?? defaultComparison} /></>
}

function ReviewSession({ repository, settings, theme, preferences, initial }: { repository: Repository; settings: Settings; theme: 'light' | 'dark'; preferences: (patch: PreferencesPatch) => void; initial: Comparison }) {
  const [comparison, setComparison] = useState(initial)
  const [from, setFrom] = useState(initial.target.kind === 'working' ? 'Uncommitted' : initial.target.kind === 'index' ? 'Index' : initial.target.ref)
  const [to, setTo] = useState(initial.base.kind === 'index' ? 'Index' : initial.base.kind === 'commit' ? initial.base.ref : 'HEAD')
  const [mode, setMode] = useState(initial.mode)
  const [sidebarWidth, setSidebarWidth] = useState(settings.sidebarWidth)
  const [contentSearch, setContentSearch] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchHit, setSearchHit] = useState<(ContentMatch & { key: number }) | null>(null)
  const contentSearchRef = useRef<HTMLInputElement>(null)
  const refs = useQuery({ queryKey: ['refs', repository.path], queryFn: () => window.desktop.getRepositoryRefs(repository.path) })
  const [refresh, setRefresh] = useState(0)
  const [selected, setSelected] = useState('')
  const [filter, setFilter] = useState('changed')
  const [search, setSearch] = useState('')
  const [threadVisit, setThreadVisit] = useState(0)
  const [threadFocus, setThreadFocus] = useState<string | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const focusFileSearch = useRef(false)
  useEffect(() => { if (!settings.sidebarCollapsed && focusFileSearch.current) { searchRef.current?.focus(); focusFileSearch.current = false } }, [settings.sidebarCollapsed])
  const snapshot = useQuery({
    queryKey: ['comparison', repository.path, comparison, refresh], retry: false, staleTime: Infinity, gcTime: 0,
    queryFn: async ({ signal }) => {
      const cancel = () => { void window.desktop.cancelComparison() }
      signal.addEventListener('abort', cancel, { once: true })
      try { return await window.desktop.openComparison(repository.path, comparison) }
      finally { signal.removeEventListener('abort', cancel) }
    },
  })
  const records = useQuery({ queryKey: ['review-record', snapshot.data?.id], queryFn: () => window.desktop.getReviewRecord(snapshot.data!.id), enabled: !!snapshot.data, retry: false })
  useEffect(() => { setSelected(snapshot.data?.files[0]?.path ?? ''); setThreadFocus(null); setSearchHit(null) }, [snapshot.data])
  useEffect(() => {
    if (threadFocus && records.data && !records.data.threads.some((thread) => thread.id === threadFocus)) setThreadFocus(null)
  }, [records.data, threadFocus])
  useEffect(() => { const timer = setTimeout(() => setSearchQuery(contentSearch.trim()), 200); return () => clearTimeout(timer) }, [contentSearch])
  const contentResults = useQuery({ queryKey: ['content-search', snapshot.data?.id, searchQuery], queryFn: () => window.desktop.searchReviewContents(snapshot.data!.id, searchQuery), enabled: !!snapshot.data && !!searchQuery, retry: false })
  useEffect(() => () => { void window.desktop.cancelComparison() }, [])
  const changed = snapshot.data?.files.map((file) => file.path) ?? []
  const unresolved = records.data?.threads.filter((thread) => !thread.resolved) ?? []
  const paths = useMemo(() => {
    const paths = filter === 'all' ? snapshot.data?.paths ?? [] : filter === 'unresolved' ? [...new Set(records.data?.threads.filter((thread) => !thread.resolved).map((thread) => thread.path))] : snapshot.data?.files.map((file) => file.path) ?? []
    return paths.filter((path) => path.toLowerCase().includes(search.toLowerCase()))
  }, [snapshot.data, records.data, filter, search])
  const totals = useMemo(() => {
    const included = new Set(paths)
    return (snapshot.data?.files ?? []).reduce((sum, file) => included.has(file.path) ? { additions: sum.additions + (file.additions ?? 0), deletions: sum.deletions + (file.deletions ?? 0) } : sum, { additions: 0, deletions: 0 })
  }, [paths, snapshot.data])
  const select = (path: string) => {
    if (!paths.includes(path)) { setFilter('changed'); setSearch('') }
    setSelected(path)
    setSearchHit(null)
    setThreadFocus(null)
    requestAnimationFrame(() => {
      const file = document.getElementById(`file-${encodeURIComponent(path)}`)
      const scroll = file?.closest('.diff-scroll')
      if (file && scroll) scroll.scrollTop += file.getBoundingClientRect().top - scroll.getBoundingClientRect().top
    })
  }
  const navigate = (direction: number, threads = false) => {
    if (threads) {
      if (!unresolved.length) return
      const index = unresolved.findIndex((thread) => thread.id === threadFocus)
      const thread = unresolved[(index + direction + unresolved.length) % unresolved.length]
      setSelected(thread.path); setSearchHit(null); setThreadFocus(thread.id)
      setThreadVisit((value) => value + 1)
    } else if (changed.length) {
      select(changed[(changed.indexOf(selected) + direction + changed.length) % changed.length])
    }
  }
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'p') { event.preventDefault(); if (settings.sidebarCollapsed) { focusFileSearch.current = true; preferences({ sidebarCollapsed: false }) } else searchRef.current?.focus() }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') { event.preventDefault(); contentSearchRef.current?.focus() }
      if (event.altKey && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) { event.preventDefault(); navigate(event.key === 'ArrowDown' ? 1 : -1, event.shiftKey) }
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  })
  const canSwap = !!from.trim() && !!to.trim() && !['Uncommitted', 'Index'].includes(from) && !['Uncommitted', 'Index'].includes(to)
  const toolbar = document.getElementById('comparison-controls')
  const visiblePaths = settings.reviewLayout === 'focused' || !changed.includes(selected) || threadFocus || searchHit ? (selected ? [selected] : []) : paths.filter((path) => changed.includes(path))

  return <>
    {toolbar && createPortal(<form className="comparison-controls" onSubmit={(event) => {
      event.preventDefault()
      const target: Comparison['target'] = from === 'Uncommitted' ? { kind: 'working' } : from === 'Index' ? { kind: 'index' } : { kind: 'commit', ref: from.trim() }
      const base: Comparison['base'] = to === 'Index' ? { kind: 'index' } : { kind: 'commit', ref: to.trim() }
      setComparison({ base, target, mode: base.kind === 'commit' && target.kind === 'commit' ? mode : 'direct' })
      setRefresh((value) => value + 1)
      void refs.refetch()
    }}>
      <RevisionSelect label="From" value={from} onChange={setFrom} suggestions={[{ value: 'Uncommitted', kind: 'working' }, { value: 'Index', kind: 'index' }, ...(refs.data ?? [{ value: 'HEAD', kind: 'commit' as const }])]} />
      <Tooltip label={canSwap ? 'Swap From and To' : 'Swapping requires two Git revisions'}><span className="inline-flex shrink-0"><Button type="button" variant="ghost" size="icon" aria-label="Swap From and To" disabled={!canSwap} onClick={() => { setFrom(to); setTo(from) }}><ArrowLeftRight /></Button></span></Tooltip>
      <RevisionSelect label="To" value={to} onChange={setTo} suggestions={[...(from === 'Uncommitted' ? [{ value: 'Index', kind: 'index' as const }] : []), ...(refs.data ?? [{ value: 'HEAD', kind: 'commit' as const }])]} />
      {from !== 'Uncommitted' && from !== 'Index' && to !== 'Index' && <label className="merge-base-option"><input type="checkbox" checked={mode === 'merge-base'} onChange={(event) => setMode(event.target.checked ? 'merge-base' : 'direct')} />Merge-base<Tooltip label="Compare the From revision with the common ancestor of From and To. This shows changes introduced on From since the branches diverged."><button type="button" aria-label="About merge-base" className="help-button">?</button></Tooltip></label>}
      <Button variant="outline" type="submit">Compare</Button>
    </form>, toolbar)}
    <div className="review-workspace">
      <aside hidden={settings.sidebarCollapsed} id="review-files-sidebar" className="file-sidebar" aria-label="Review files" style={{ width: sidebarWidth }}>
        <div className="sidebar-controls">
          <div role="tablist" aria-label="File filter" className="file-filter-tabs">
            {([{ value: 'changed', label: 'Changed files', Icon: FileDiffIcon }, { value: 'all', label: 'All files', Icon: Files }, { value: 'unresolved', label: 'Unresolved threads', Icon: MessagesSquare }] as const).map(({ value, label, Icon }, index) => <button key={value} role="tab" aria-label={label} title={label} aria-selected={filter === value} tabIndex={filter === value ? 0 : -1} onClick={() => setFilter(value)} onKeyDown={(event) => {
              if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
              event.preventDefault()
              const next = (index + (event.key === 'ArrowRight' ? 1 : -1) + 3) % 3
              setFilter(['changed', 'all', 'unresolved'][next])
              ;(event.currentTarget.parentElement?.children[next] as HTMLElement)?.focus()
            }}><Icon size={16} /></button>)}
          </div>
          <input ref={searchRef} aria-label="Search files" placeholder="Search files" value={search} onChange={(event) => setSearch(event.target.value)} />
          <span className="secondary-text">{paths.length} files · {unresolved.length} unresolved</span>
          <span className="line-totals" title="Text lines added and deleted in the listed files. Binary files have no line count."><span className="git-added">+{totals.additions}</span><span className="git-deleted">−{totals.deletions}</span><span className="secondary-text">lines</span></span>
        </div>
        {!!snapshot.data && <ReviewTree files={snapshot.data.files} paths={paths} selected={selected} onSelect={select} theme={theme} />}
      </aside>
      {!settings.sidebarCollapsed && <div role="separator" aria-label="Resize file sidebar" aria-orientation="vertical" aria-valuemin={190} aria-valuemax={600} aria-valuenow={sidebarWidth} tabIndex={0} className="sidebar-resizer"
        onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); event.preventDefault() }}
        onPointerMove={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) setSidebarWidth(Math.round(Math.max(190, Math.min(600, window.innerWidth * 0.5, event.clientX)))) }}
        onPointerUp={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) { event.currentTarget.releasePointerCapture(event.pointerId); if (event.clientX < 95) { setSidebarWidth(settings.sidebarWidth); preferences({ sidebarCollapsed: true }) } else preferences({ sidebarWidth }) } }}
        onKeyDown={(event) => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); const width = Math.max(190, Math.min(600, window.innerWidth * 0.5, sidebarWidth + (event.key === 'ArrowRight' ? 20 : -20))); setSidebarWidth(width); preferences({ sidebarWidth: width }) } }} />}
      <section className="review-center" aria-label="Code review">
        <div className="review-options">
          <Button variant="ghost" size="icon" aria-label={settings.sidebarCollapsed ? 'Show file sidebar' : 'Hide file sidebar'} title={settings.sidebarCollapsed ? 'Show file sidebar' : 'Hide file sidebar'} aria-expanded={!settings.sidebarCollapsed} aria-controls="review-files-sidebar" onClick={() => preferences({ sidebarCollapsed: !settings.sidebarCollapsed })}>{settings.sidebarCollapsed ? <PanelLeftOpen /> : <PanelLeftClose />}</Button>
          <Button variant="ghost" disabled={!changed.length} title="Previous change (Alt+↑)" onClick={() => navigate(-1)}>← Change</Button>
          <Button variant="ghost" disabled={!changed.length} title="Next change (Alt+↓)" onClick={() => navigate(1)}>Change →</Button>
          {!!unresolved.length && <><Button variant="ghost" onClick={() => navigate(-1, true)}>← Thread</Button><Button variant="ghost" onClick={() => navigate(1, true)}>Thread →</Button></>}
          {threadFocus && <Button variant="ghost" onClick={() => setThreadFocus(null)}>All changes</Button>}
          <div className="content-search">
            <Search size={14} />
            <input ref={contentSearchRef} aria-label="Search file contents" placeholder="Search file contents" value={contentSearch} onFocus={() => setSearchOpen(true)} onKeyDown={(event) => { if (event.key === 'Escape') setSearchOpen(false) }} onChange={(event) => { setContentSearch(event.target.value); setSearchOpen(true) }} />
            {(contentSearch || searchHit) && <button aria-label="Clear content search" onClick={() => { setContentSearch(''); setSearchHit(null); setSearchOpen(false) }}><X size={14} /></button>}
          </div>

        </div>
        {searchOpen && contentSearch.trim() && <section className="content-search-results" aria-label="Content search results">
          <div className="search-summary"><span>{contentResults.isFetching || searchQuery !== contentSearch.trim() ? 'Searching…' : contentResults.error ? contentResults.error.message : `${contentResults.data?.matches.length ?? 0}${contentResults.data?.truncated ? '+' : ''} matches in reviewed revision`}</span><Button variant="ghost" onClick={() => setSearchOpen(false)}>Close search</Button></div>
          {searchQuery === contentSearch.trim() && contentResults.data?.matches.map((match, index) => <button key={`${match.path}:${match.line}:${index}`} onClick={() => { setSelected(match.path); setThreadFocus(null); setSearchHit({ ...match, key: Date.now() }); setSearchOpen(false) }}><span className="text-code">{match.path}:{match.line}</span><span className="text-code secondary-text">{match.text}</span></button>)}
        </section>}
        {snapshot.isPending && <p className="review-message">Loading comparison… <Button variant="ghost" onClick={() => void window.desktop.cancelComparison()}>Cancel</Button></p>}
        {(snapshot.error || records.error) && <p className="review-message" role="alert">{snapshot.error?.message ?? records.error?.message}</p>}
        {snapshot.data && !visiblePaths.length && <p className="review-message">{paths.length ? 'Select a file to review.' : 'No files match this view.'}</p>}

          <Virtualizer className="diff-scroll">
            {snapshot.data && visiblePaths.map((path) => <ReviewFileCard key={`${snapshot.data.id}:${path}`} snapshot={snapshot.data!} path={path} record={records.data} settings={settings} theme={theme} threadFocus={threadFocus} threadVisit={threadVisit} searchHit={searchHit?.path === path ? searchHit : null} />)}
          </Virtualizer>

      </section>
    </div>
  </>
}

function ReviewTree({ files, paths, selected, onSelect, theme }: { files: Snapshot['files']; paths: string[]; selected: string; onSelect: (path: string) => void; theme: 'light' | 'dark' }) {
  const selection = useRef({ selected, onSelect })
  selection.current = { selected, onSelect }
  const [prepared, setPrepared] = useState(() => preparePresortedFileTreeInput([]))
  useEffect(() => {
    const worker = new ReviewWorker()
    worker.onmessage = (event) => { if (event.data.result) setPrepared(preparePresortedFileTreeInput(event.data.result)); worker.terminate() }
    worker.postMessage({ kind: 'tree', paths })
    return () => worker.terminate()
  }, [paths])
  const { model } = useFileTree({ preparedInput: prepared, initialExpansion: 'open', onSelectionChange: (selected) => { const path = selected[0]; if (path && path !== selection.current.selected && !model.getItem(path)?.isDirectory()) selection.current.onSelect(path) }, unsafeCSS: ':host { font-family: "Geist Mono Variable", monospace; font-size: 13px; line-height: 20px; }' })
  useEffect(() => { model.resetPaths({ preparedInput: prepared }); model.setGitStatus(files.map((file) => ({ path: file.path, status: gitStatuses[file.status] ?? 'modified' }))) }, [model, prepared, files])
  useEffect(() => { model.getItem(selected)?.select(); model.scrollToPath(selected, { focus: false }) }, [model, selected, prepared])
  return <FileTree model={model} className="file-tree" style={{ colorScheme: theme }} />
}

function ReviewFileCard({ snapshot, path, record, settings, theme, threadFocus, threadVisit, searchHit }: { snapshot: Snapshot; path: string; record?: ReviewRecord; settings: Settings; theme: 'light' | 'dark'; threadFocus: string | null; threadVisit: number; searchHit: (ContentMatch & { key: number }) | null }) {
  const root = useRef<HTMLElement>(null)
  const [copied, setCopied] = useState(false)
  const [copyError, setCopyError] = useState('')
  useEffect(() => { if (!copied) return; const timer = setTimeout(() => setCopied(false), 2000); return () => clearTimeout(timer) }, [copied])
  const [collapsed, setCollapsed] = useState(false)
  useEffect(() => { if (searchHit || threadFocus) setCollapsed(false) }, [searchHit, threadFocus, threadVisit])
  const [visible, setVisible] = useState(false)
  const [force, setForce] = useState(false)
  const [range, setRange] = useState<SelectedLineRange | null>(null)
  const [body, setBody] = useState('')
  const [pendingReviewed, setPendingReviewed] = useState<boolean | null>(null)
  const queryClient = useQueryClient()
  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => { if (entry.isIntersecting) { setVisible(true); observer.disconnect() } }, { rootMargin: '600px' })
    if (root.current) observer.observe(root.current)
    return () => observer.disconnect()
  }, [])
  const content = useQuery({ queryKey: ['review-file', snapshot.id, path, force], queryFn: () => window.desktop.loadReviewFile(snapshot.id, path, force), enabled: visible, retry: false, staleTime: Infinity })
  const mutation = useMutation({
    mutationFn: (action: ReviewAction) => window.desktop.updateReviewRecord(snapshot.id, action),
    scope: { id: `record-${snapshot.id}` },
    onError: () => setPendingReviewed(null),
    onSuccess: (record, action) => { queryClient.setQueryData(['review-record', snapshot.id], record); if (action.kind === 'reviewed' && action.reviewed) setCollapsed(true) },
  })
  const reviewed = !!content.data && record?.reviewed[path] === content.data.fingerprint
  useEffect(() => {
    if (pendingReviewed !== null && pendingReviewed === reviewed) setPendingReviewed(null)
  }, [pendingReviewed, reviewed])
  const [diff, setDiff] = useState<FileDiffMetadata | null>(null)
  const [parseError, setParseError] = useState('')
  const metadata = snapshot.files.find((file) => file.path === path)
  useEffect(() => {
    setDiff(null); setParseError('')
    if (!metadata || !content.data || (!content.data.oldFile && !content.data.newFile)) return
    const worker = new ReviewWorker()
    worker.onmessage = (event) => { if (event.data.error) setParseError(event.data.error); else setDiff(event.data.result); worker.terminate() }
    worker.onerror = (event) => { setParseError(event.message); worker.terminate() }
    worker.postMessage({ kind: 'diff', content: content.data })
    return () => worker.terminate()
  }, [content.data, metadata])
  const threads = record?.threads.filter((thread) => thread.path === path) ?? []
  const currentThreads = threads.filter((thread) => thread.fingerprint === content.data?.fingerprint)
  const outdated = threads.filter((thread) => thread.fingerprint !== content.data?.fingerprint)

  const focusedThread = threads.find((thread) => thread.id === threadFocus)
  const save = async (event: FormEvent) => {
    event.preventDefault()
    if (!range || (range.endSide && range.side && range.endSide !== range.side)) return
    await mutation.mutateAsync({ kind: 'thread', path, side: range.side ?? 'additions', start: Math.min(range.start, range.end), end: Math.max(range.start, range.end), body }).then(() => { setBody(''); setRange(null) }).catch(() => undefined)
  }
  const scrolledHit = useRef<string | null>(null)
  const anchor = searchHit ? { line: searchHit.line, side: 'additions' as const, key: `search:${searchHit.key}` } : focusedThread && focusedThread.fingerprint === content.data?.fingerprint ? { line: focusedThread.start, side: focusedThread.side, key: `thread:${focusedThread.id}:${threadVisit}` } : null
  const options = {
    theme: { dark: 'pierre-dark', light: 'pierre-light' } as const, themeType: theme, diffStyle: settings.diffLayout,
    disableFileHeader: true, enableLineSelection: true, preferredHighlighter: 'shiki-js' as const,
    overflow: settings.wrapLines ? 'wrap' as const : 'scroll' as const,
    onLineSelectionEnd: setRange, unsafeCSS: codeCSS, expandUnchanged: !!anchor,
    onPostRender: (node: HTMLElement, instance: object) => {
      if (!anchor || scrolledHit.current === anchor.key) return
      if (!(instance instanceof VirtualizedFileDiff) && !(instance instanceof VirtualizedFile)) return
      const position = instance instanceof VirtualizedFileDiff ? instance.getLinePosition(anchor.line, anchor.side) : instance.getLinePosition(anchor.line)
      if (!position) return
      scrolledHit.current = anchor.key
      requestAnimationFrame(() => {
        const scroll = root.current?.closest('.diff-scroll')
        if (scroll) scroll.scrollTop += node.getBoundingClientRect().top - scroll.getBoundingClientRect().top + position.top - 40
      })
    },
  }
  const annotations: DiffLineAnnotation<LocalThread | 'draft'>[] = currentThreads.map((thread) => ({ side: thread.side, lineNumber: thread.end, metadata: thread }))
  if (range && (!range.endSide || !range.side || range.endSide === range.side)) annotations.push({ side: range.side ?? 'additions', lineNumber: Math.max(range.start, range.end), metadata: 'draft' })
  const renderAnnotation = ({ metadata: thread }: { metadata: LocalThread | 'draft' }) => thread === 'draft' ? <form className="thread-composer" onSubmit={save}>
    <textarea autoFocus aria-label={`Comment on ${path}`} placeholder="Write a local review comment" value={body} onChange={(event) => setBody(event.target.value)} required maxLength={100000} />
    <div><Button variant="outline" disabled={!body.trim() || mutation.isPending || !record}>Save thread</Button><Button type="button" variant="ghost" onClick={() => setRange(null)}>Cancel</Button></div>
    {mutation.error && <p role="alert">{mutation.error.message}</p>}
  </form> : <Thread thread={thread} mutate={(action) => mutation.mutateAsync(action)} pending={mutation.isPending} />
  const selectedLines = range ?? (anchor ? { start: anchor.line, end: anchor.line, side: anchor.side } : null)
  return <article ref={root} id={`file-${encodeURIComponent(path)}`} className={`file-card${collapsed ? ' collapsed' : ''}`} aria-label={path}>
    <header className="file-heading" data-git-status={metadata ? gitStatuses[metadata.status] : undefined}>
      <button className="file-collapse" aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${path}`} aria-expanded={!collapsed} onClick={() => setCollapsed(!collapsed)}>{collapsed ? <ChevronRight size={16} /> : <ChevronDown size={16} />}</button>
      <span className="file-status" title={metadata?.status === 'U' ? 'Conflicted' : metadata ? gitStatuses[metadata.status] : 'Unchanged'}>{metadata?.status ?? '='}</span>
      <h2 className="text-code">{metadata && metadata.oldPath !== path ? `${metadata.oldPath} → ${path}` : path}</h2>
      <Button variant="ghost" size="icon" aria-label={`Copy relative path for ${path}`} title={copied ? 'Copied relative path' : 'Copy relative path'} onClick={() => { setCopyError(''); void window.desktop.copyRelativePath(path).then(() => setCopied(true)).catch((error: unknown) => setCopyError(`Could not copy the relative path: ${error instanceof Error ? error.message : String(error)}`)) }}>{copied ? <Check /> : <Copy />}</Button>
      <span role="status" className="sr-only">{copied ? `Copied ${path}` : ''}</span>
      {metadata && metadata.oldMode !== metadata.newMode && <span className="secondary-text text-code">{metadata.oldMode} → {metadata.newMode}</span>}

      <label className="reviewed-label"><input type="checkbox" aria-label={`Reviewed ${path}`} disabled={!content.data || content.data.large || !record || mutation.isPending} checked={pendingReviewed ?? reviewed} onChange={(event) => { setPendingReviewed(event.target.checked); mutation.mutate({ kind: 'reviewed', path, reviewed: event.target.checked }) }} />Reviewed</label>
    </header>
    {copyError && <p role="alert" className="file-message">{copyError}</p>}
    {!collapsed && <>
    {content.isPending && <p className="file-message">{visible ? 'Loading file…' : 'Scroll to load file'}</p>}
    {content.error && <p role="alert" className="file-message">{content.error.message}</p>}
    {content.data?.summary && <p className="file-message">{content.data.summary} <span className="secondary-text">{content.data.bytes.toLocaleString()} bytes</span>{content.data.large && <Button variant="outline" onClick={() => setForce(true)}>Load complete file</Button>}</p>}
    {parseError && <p role="alert" className="file-message">Could not render diff: {parseError}</p>}
    {diff && <FileDiff<LocalThread | 'draft'> fileDiff={diff} options={options} selectedLines={selectedLines} lineAnnotations={annotations} renderAnnotation={renderAnnotation} />}
    {!metadata && content.data?.newFile && <File<LocalThread | 'draft'> file={content.data.newFile} options={options} selectedLines={selectedLines} lineAnnotations={annotations} renderAnnotation={renderAnnotation} />}
    {content.data && !content.data.summary && !content.data.oldFile?.contents && !content.data.newFile?.contents && <p className="file-message">Empty file; metadata shown above.</p>}
    {!!outdated.length && (content.data || content.error) && <details className="outdated-threads" open={!!focusedThread && outdated.includes(focusedThread)}><summary>{outdated.length} outdated threads — preserved from earlier content</summary>{outdated.map((thread) => <Thread key={thread.id} thread={thread} mutate={(action) => mutation.mutateAsync(action)} pending={mutation.isPending} />)}</details>}
    </>}
    {mutation.error && !range && <p className="file-message" role="alert">{mutation.error.message}</p>}
  </article>
}

function Thread({ thread, mutate, pending }: { thread: LocalThread; mutate: (action: ReviewAction) => Promise<ReviewRecord>; pending: boolean }) {
  const [reply, setReply] = useState('')
  const [now, setNow] = useState(Date.now)
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 30000); return () => clearInterval(timer) }, [])
  return <section className="local-thread" aria-label={`Thread at ${thread.side} line ${thread.start}`}>
    <div className="thread-meta"><span className="local-tag">Local</span>{thread.resolved && <span className="secondary-text">Resolved</span>}<Button variant="ghost" disabled={pending} onClick={() => void mutate({ kind: 'resolve', thread: thread.id, resolved: !thread.resolved }).catch(() => undefined)}>{thread.resolved ? 'Reopen' : 'Resolve'}</Button></div>
    {thread.messages.map((message) => {
      const updated = new Date(message.updatedAt ?? message.createdAt)
      const seconds = Math.max(0, Math.floor((now - updated.getTime()) / 1000))
      const unit = seconds < 60 ? 'second' : seconds < 3600 ? 'minute' : seconds < 86400 ? 'hour' : seconds < 2592000 ? 'day' : seconds < 31536000 ? 'month' : 'year'
      const count = Math.floor(seconds / { second: 1, minute: 60, hour: 3600, day: 86400, month: 2592000, year: 31536000 }[unit])
      const relative = seconds < 10 ? 'just now' : new Intl.RelativeTimeFormat(undefined, { numeric: 'always' }).format(-count, unit)
      return <div key={message.id} className="thread-message"><div className="comment-content"><Tooltip label={updated.toLocaleString()}><time className="comment-date" tabIndex={0} dateTime={updated.toISOString()} aria-label={`Updated ${relative}`}>{relative}</time></Tooltip><div className="thread-body markdown"><Markdown remarkPlugins={[remarkGfm]} skipHtml components={{ img: ({ alt }) => <span>{alt}</span> }}>{message.body}</Markdown></div></div><button type="button" className="delete-comment" aria-label="Delete comment" title="Delete comment" disabled={pending} onClick={() => void mutate({ kind: 'delete-comment', thread: thread.id, message: message.id }).catch(() => undefined)}><Trash2 size={14} /></button></div>
    })}
    <form onSubmit={(event) => { event.preventDefault(); void mutate({ kind: 'reply', thread: thread.id, body: reply }).then(() => setReply('')).catch(() => undefined) }}><input aria-label="Reply" placeholder="Reply" value={reply} onChange={(event) => setReply(event.target.value)} maxLength={100000} /><Button variant="outline" disabled={!reply.trim() || pending}>Reply</Button></form>
  </section>
}
