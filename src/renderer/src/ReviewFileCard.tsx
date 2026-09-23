import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { File, FileDiff, type FileDiffMetadata } from '@pierre/diffs/react'
import {
  VirtualizedFile,
  VirtualizedFileDiff,
  type SelectedLineRange,
  type DiffLineAnnotation,
} from '@pierre/diffs'
import { ArrowRight, ChevronDown, ChevronRight, Copy, Check } from 'lucide-react'
import type {
  ContentMatch,
  LocalThread,
  ReviewAction,
  ReviewRecord,
  Snapshot,
} from '../../shared/review'
import type { Settings } from '../../shared/desktop'
import ReviewWorker from './review.worker?worker'
import { Button } from '@/components/ui/button'
import { Thread } from './Thread'
import { gitStatuses } from './ReviewSidebar'
const codeCSS =
  ':host { --diffs-font-family: "Geist Mono Variable", monospace; --diffs-font-size: 13px; --diffs-line-height: 20px; }'

export function ReviewFileCard({
  snapshot,
  path,
  record,
  metadata,
  threads,
  settings,
  theme,
  threadFocus,
  threadVisit,
  searchHit,
}: {
  snapshot: Snapshot
  path: string
  record?: ReviewRecord
  metadata?: Snapshot['files'][number]
  threads: LocalThread[]
  settings: Settings
  theme: 'light' | 'dark'
  threadFocus: string | null
  threadVisit: number
  searchHit: (ContentMatch & { key: number }) | null
}) {
  const root = useRef<HTMLElement>(null)
  const [copied, setCopied] = useState(false)
  const [copyError, setCopyError] = useState('')
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 2000)
    return () => clearTimeout(timer)
  }, [copied])
  const [collapsed, setCollapsed] = useState(false)
  useEffect(() => {
    if (searchHit || threadFocus) setCollapsed(false)
  }, [searchHit, threadFocus, threadVisit])
  const [visible, setVisible] = useState(false)
  const [force, setForce] = useState(false)
  const [range, setRange] = useState<SelectedLineRange | null>(null)
  const [selectingRange, setSelectingRange] = useState<SelectedLineRange | null>(null)
  const [body, setBody] = useState('')
  const [pendingReviewed, setPendingReviewed] = useState<boolean | null>(null)
  const queryClient = useQueryClient()
  useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setVisible(true)
          observer.disconnect()
        }
      },
      { rootMargin: '600px' },
    )
    if (root.current) observer.observe(root.current)
    return () => observer.disconnect()
  }, [])
  const content = useQuery({
    queryKey: ['review-file', snapshot.id, path, force],
    queryFn: () => window.desktop.loadReviewFile(snapshot.id, path, force),
    enabled: visible,
    retry: false,
    staleTime: Infinity,
  })
  const mutation = useMutation({
    mutationFn: (action: ReviewAction) => window.desktop.updateReviewRecord(snapshot.id, action),
    scope: { id: `record-${snapshot.id}` },
    onError: () => setPendingReviewed(null),
    onSuccess: (record, action) => {
      if (queryClient.getQueryState(['review-record', snapshot.id])) {
        queryClient.setQueryData(['review-record', snapshot.id], record)
      }
      if (action.kind === 'reviewed' && action.reviewed) setCollapsed(true)
    },
  })
  const reviewed = !!content.data && record?.reviewed[path] === content.data.fingerprint
  useEffect(() => {
    if (pendingReviewed !== null && pendingReviewed === reviewed) setPendingReviewed(null)
  }, [pendingReviewed, reviewed])
  const [diff, setDiff] = useState<FileDiffMetadata | null>(null)
  const [parseError, setParseError] = useState('')
  useEffect(() => {
    setDiff(null)
    setParseError('')
    if (!metadata || !content.data || (!content.data.oldFile && !content.data.newFile)) return
    let current = true
    const worker = new ReviewWorker()
    worker.onmessage = (event) => {
      if (!current) return
      if (event.data.error) setParseError(event.data.error)
      else setDiff(event.data.result)
      worker.terminate()
    }
    worker.onerror = (event) => {
      event.preventDefault()
      if (current) setParseError(event.message)
      worker.terminate()
    }
    worker.postMessage({ kind: 'diff', content: content.data })
    return () => {
      current = false
      worker.terminate()
    }
  }, [content.data, metadata])
  const currentThreads = threads.filter(
    (thread) => thread.fingerprint === content.data?.fingerprint,
  )
  const outdated = threads.filter((thread) => thread.fingerprint !== content.data?.fingerprint)

  const focusedThread = threads.find((thread) => thread.id === threadFocus)
  const save = async (event: FormEvent) => {
    event.preventDefault()
    if (!range || (range.endSide && range.side && range.endSide !== range.side)) return
    await mutation
      .mutateAsync({
        kind: 'thread',
        path,
        side: range.side ?? 'additions',
        start: Math.min(range.start, range.end),
        end: Math.max(range.start, range.end),
        body,
      })
      .then(() => {
        setBody('')
        setRange(null)
      })
      .catch(() => undefined)
  }
  const scrolledHit = useRef<string | null>(null)
  const anchor = searchHit
    ? { line: searchHit.line, side: 'additions' as const, key: `search:${searchHit.key}` }
    : focusedThread && focusedThread.fingerprint === content.data?.fingerprint
      ? {
          line: focusedThread.start,
          side: focusedThread.side,
          key: `thread:${focusedThread.id}:${threadVisit}`,
        }
      : null
  const options = {
    theme: { dark: 'pierre-dark', light: 'pierre-light' } as const,
    themeType: theme,
    diffStyle: settings.diffLayout,
    disableFileHeader: true,
    enableLineSelection: true,
    enableGutterUtility: true,
    onGutterUtilityClick: setRange,
    preferredHighlighter: 'shiki-js' as const,
    overflow: settings.wrapLines ? ('wrap' as const) : ('scroll' as const),
    onLineSelectionStart: setSelectingRange,
    onLineSelectionChange: setSelectingRange,
    onLineSelectionEnd: (selection: SelectedLineRange | null) => {
      setSelectingRange(null)
      setRange(selection)
    },
    unsafeCSS: codeCSS,
    expandUnchanged: !!anchor,
    onPostRender: (node: HTMLElement, instance: object) => {
      if (!anchor || scrolledHit.current === anchor.key) return
      if (!(instance instanceof VirtualizedFileDiff) && !(instance instanceof VirtualizedFile))
        return
      const position =
        instance instanceof VirtualizedFileDiff
          ? instance.getLinePosition(anchor.line, anchor.side)
          : instance.getLinePosition(anchor.line)
      if (!position) return
      scrolledHit.current = anchor.key
      requestAnimationFrame(() => {
        const scroll = root.current?.closest('[data-testid="diff-scroll"]')?.firstElementChild
        if (scroll)
          scroll.scrollTop +=
            node.getBoundingClientRect().top -
            scroll.getBoundingClientRect().top +
            position.top -
            (root.current?.querySelector('header')?.getBoundingClientRect().height ?? 40) -
            8
      })
    },
  }
  const annotations: DiffLineAnnotation<LocalThread | 'draft'>[] = currentThreads.map((thread) => ({
    side: thread.side,
    lineNumber: thread.end,
    metadata: thread,
  }))
  if (range && (!range.endSide || !range.side || range.endSide === range.side))
    annotations.push({
      side: range.side ?? 'additions',
      lineNumber: Math.max(range.start, range.end),
      metadata: 'draft',
    })
  const renderAnnotation = ({ metadata: thread }: { metadata: LocalThread | 'draft' }) =>
    thread === 'draft' ? (
      <form
        data-testid="thread-composer"
        className="m-3 flex min-w-0 flex-col gap-2 border bg-surface p-3 font-sans text-[13px]/5 font-normal text-foreground"
        onSubmit={save}
      >
        <Textarea
          autoFocus
          aria-label={`Comment on ${path}`}
          placeholder="Write a local review comment"
          value={body}
          onChange={(event) => setBody(event.target.value)}
          required
          maxLength={100000}
        />
        <div>
          <Button
            type="submit"
            variant="outline"
            disabled={!body.trim() || mutation.isPending || !record}
          >
            Save thread
          </Button>
          <Button type="button" variant="ghost" onClick={() => setRange(null)}>
            Cancel
          </Button>
        </div>
        {mutation.error && <p role="alert">{mutation.error.message}</p>}
      </form>
    ) : (
      <Thread
        thread={thread}
        mutate={(action) => mutation.mutateAsync(action)}
        pending={mutation.isPending}
      />
    )
  const selectedLines =
    selectingRange ??
    range ??
    (anchor ? { start: anchor.line, end: anchor.line, side: anchor.side } : null)
  return (
    <article
      ref={root}
      id={`file-${encodeURIComponent(path)}`}
      className={collapsed ? 'border-b' : 'min-h-25 border-b'}
      aria-label={path}
    >
      <header
        data-testid="file-heading"
        className="group sticky top-0 z-10 flex items-center gap-2.5 border-b bg-surface px-3 py-2"
        data-git-status={metadata ? gitStatuses[metadata.status] : undefined}
      >
        <Button
          variant="ghost"
          className="h-auto shrink-0 rounded-sm p-1.25"
          aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${path}`}
          aria-expanded={!collapsed}
          onClick={() => setCollapsed(!collapsed)}
        >
          {collapsed ? <ChevronRight size={16} /> : <ChevronDown size={16} />}
        </Button>
        <span className="shrink-0 text-muted-foreground group-data-[git-status=added]:text-git-added group-data-[git-status=untracked]:text-git-added group-data-[git-status=deleted]:text-git-deleted group-data-[git-status=modified]:text-git-modified group-data-[git-status=renamed]:text-git-renamed">
          {metadata
            ? ({
                A: 'Added',
                D: 'Deleted',
                M: 'Modified',
                T: 'Type changed',
                U: 'Conflicted',
                R: 'Renamed',
                C: 'Copied',
                '?': 'Untracked',
              }[metadata.status] ?? 'Changed')
            : 'Unchanged'}
        </span>
        <h2 className="wrap-anywhere font-mono group-data-[git-status=added]:text-git-added group-data-[git-status=untracked]:text-git-added group-data-[git-status=deleted]:text-git-deleted group-data-[git-status=modified]:text-git-modified group-data-[git-status=renamed]:text-git-renamed">
          {metadata && metadata.oldPath !== path ? (
            <>
              {metadata.oldPath}{' '}
              <ArrowRight className="inline size-4 align-middle" aria-hidden="true" />
              <span className="sr-only"> to </span> {path}
            </>
          ) : (
            path
          )}
        </h2>
        <Button
          variant="ghost"
          size="icon"
          aria-label={`Copy relative path for ${path}`}
          title={copied ? 'Copied relative path' : 'Copy relative path'}
          onClick={() => {
            setCopyError('')
            void window.desktop
              .copyRelativePath(path)
              .then(() => setCopied(true))
              .catch((error: unknown) =>
                setCopyError(
                  `Could not copy the relative path: ${error instanceof Error ? error.message : String(error)}`,
                ),
              )
          }}
        >
          {copied ? <Check /> : <Copy />}
        </Button>
        <span role="status" className="sr-only">
          {copied ? `Copied ${path}` : ''}
        </span>
        {metadata && metadata.additions !== null && metadata.deletions !== null && (
          <span className="flex shrink-0 gap-2 font-mono text-xs tabular-nums">
            <span className="text-git-added" aria-label={`${metadata.additions} lines added`}>
              +{metadata.additions}
            </span>
            <span className="text-git-deleted" aria-label={`${metadata.deletions} lines deleted`}>
              −{metadata.deletions}
            </span>
          </span>
        )}
        {metadata && metadata.oldMode !== metadata.newMode && (
          <span className="text-muted-foreground font-mono">
            {metadata.oldMode}{' '}
            <ArrowRight className="inline size-4 align-middle" aria-hidden="true" />
            <span className="sr-only"> to </span> {metadata.newMode}
          </span>
        )}

        <Label className="ml-auto flex items-center gap-1.5 whitespace-nowrap">
          <Checkbox
            aria-label={`Reviewed ${path}`}
            disabled={!content.data || content.data.large || !record || mutation.isPending}
            checked={pendingReviewed ?? reviewed}
            onCheckedChange={(checked) => {
              setPendingReviewed(checked === true)
              mutation.mutate({ kind: 'reviewed', path, reviewed: checked === true })
            }}
          />
          Reviewed
        </Label>
      </header>
      {copyError && (
        <p role="alert" className="flex flex-wrap items-center gap-3 p-4">
          {copyError}
        </p>
      )}
      {!collapsed && (
        <>
          {content.isPending && (
            <p className="flex flex-wrap items-center gap-3 p-4">
              {visible ? 'Loading file…' : 'Scroll to load file'}
            </p>
          )}
          {content.error && (
            <p role="alert" className="flex flex-wrap items-center gap-3 p-4">
              {content.error.message}
            </p>
          )}
          {content.data?.summary && (
            <p className="flex flex-wrap items-center gap-3 p-4">
              {content.data.summary}{' '}
              <span className="text-muted-foreground">
                {content.data.bytes.toLocaleString()} bytes
              </span>
              {content.data.large && (
                <Button variant="outline" onClick={() => setForce(true)}>
                  Load complete file
                </Button>
              )}
            </p>
          )}
          {parseError && (
            <p role="alert" className="flex flex-wrap items-center gap-3 p-4">
              Could not render diff: {parseError}
            </p>
          )}
          {diff && (
            <FileDiff<LocalThread | 'draft'>
              fileDiff={diff}
              options={options}
              selectedLines={selectedLines}
              lineAnnotations={annotations}
              renderAnnotation={renderAnnotation}
            />
          )}
          {!metadata && content.data?.newFile && (
            <File<LocalThread | 'draft'>
              file={content.data.newFile}
              options={options}
              selectedLines={selectedLines}
              lineAnnotations={annotations}
              renderAnnotation={renderAnnotation}
            />
          )}
          {content.data &&
            !content.data.summary &&
            !content.data.oldFile?.contents &&
            !content.data.newFile?.contents && (
              <p className="flex flex-wrap items-center gap-3 p-4">
                Empty file; metadata shown above.
              </p>
            )}
          {!!outdated.length && (content.data || content.error) && (
            <details
              className="m-3 [&_summary]:cursor-pointer [&_summary]:text-muted-foreground"
              open={!!focusedThread && outdated.includes(focusedThread)}
            >
              <summary>{outdated.length} outdated threads — preserved from earlier content</summary>
              {outdated.map((thread) => (
                <Thread
                  key={thread.id}
                  thread={thread}
                  mutate={(action) => mutation.mutateAsync(action)}
                  pending={mutation.isPending}
                />
              ))}
            </details>
          )}
        </>
      )}
      {mutation.error && !range && (
        <p className="flex flex-wrap items-center gap-3 p-4" role="alert">
          {mutation.error.message}
        </p>
      )}
    </article>
  )
}
