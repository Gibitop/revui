import { CodeIntelligence } from './CodeIntelligence'
import type { CodeLocation } from '../../shared/intelligence'
import { useGitLab, GitLabComposer, GitLabDiscussion } from './GitLab'
import type { Discussion, GitLabReview } from '../../shared/gitlab'
import { IDEButton } from './IDEButton'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { CommentComposer } from './CommentComposer'
import { memo, useEffect, useRef, useState, type ComponentProps, type RefObject } from 'react'
import { replaceEqualDeep, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { File, FileDiff, useVirtualizer, type FileDiffMetadata } from '@pierre/diffs/react'
import {
  VirtualizedFile,
  VirtualizedFileDiff,
  type SelectedLineRange,
  type DiffLineAnnotation,
} from '@pierre/diffs'
import { ArrowRight, ChevronDown, ChevronRight, Copy, Check, CircleAlert } from 'lucide-react'
import type {
  ContentMatch,
  FileContent,
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

// Query-owned contents keep parsed diffs alive across navigation, without retaining old reviews.
const parsedDiffs = new WeakMap<FileContent, FileDiffMetadata>()

// Darken light-theme tokens so syntax stays legible on tinted diff backgrounds.
const codeCSS =
  '[data-line] span[style*="--diffs-token-light"] { color: light-dark(color-mix(in srgb, var(--diffs-token-light) 65%, #000), var(--diffs-token-dark)); } :host { --diffs-font-family: "Geist Mono Variable", monospace; --diffs-font-size: 13px; --diffs-line-height: 20px; } [data-thread-range]:not([data-selected-line]) { background-color: color-mix(in srgb, #3b82f6 14%, transparent); box-shadow: inset 2px 0 #3b82f6; }'

// General MR refreshes must not rerender every file and its content queries.
export const ReviewFileCard = memo(function ReviewFileCard(
  props: Omit<ComponentProps<typeof ReviewFileCardContent>, 'gitlabReview'>,
) {
  const gitlab = useGitLab()
  const previous = useRef<Pick<GitLabReview, 'aligned' | 'pinned' | 'discussions'>>(undefined)
  const review = gitlab?.review
  previous.current = replaceEqualDeep(
    previous.current,
    review
      ? {
          aligned: review.aligned,
          pinned: review.pinned,
          discussions: review.discussions.filter((discussion) => {
            const position = discussion.notes[0]?.position
            return (
              position &&
              (position.new_path === props.path ||
                position.old_path === (props.metadata?.oldPath ?? props.path))
            )
          }),
        }
      : undefined,
  )
  return <ReviewFileCardContent {...props} gitlabReview={previous.current} />
})

const ReviewFileCardContent = memo(function ReviewFileCardContent({
  snapshot,
  path,
  record,
  metadata,
  threads,
  settings,
  theme,
  headerFlash,
  threadFocus,
  threadVisit,
  searchHit,
  workspaceId,
  workspaceReady,
  intelligenceReady,
  onNavigate,
  gitlabReview,
}: {
  gitlabReview?: Pick<GitLabReview, 'aligned' | 'pinned' | 'discussions'>
  onNavigate: (location: CodeLocation, origin: CodeLocation) => void
  workspaceId: string | null
  workspaceReady: boolean
  intelligenceReady: boolean
  snapshot: Snapshot
  path: string
  record?: ReviewRecord
  metadata?: Snapshot['files'][number]
  threads: LocalThread[]
  settings: Pick<Settings, 'diffLayout' | 'wrapLines' | 'preferredIDE'>
  theme: 'light' | 'dark'
  headerFlash: number
  threadFocus: string | null
  threadVisit: number
  searchHit: (ContentMatch & { key: number; codeNavigation?: boolean; fileOnly?: boolean }) | null
}) {
  const gitlab = { review: gitlabReview }
  const virtualizer = useVirtualizer()
  const root = useRef<HTMLElement>(null)
  useEffect(() => {
    if (!headerFlash || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const animation = root.current
      ?.querySelector('header')
      ?.animate(
        [
          { backgroundColor: 'color-mix(in srgb, #3b82f6 22%, var(--surface))' },
          { backgroundColor: 'var(--surface)' },
        ],
        { duration: 1000, easing: 'ease-in' },
      )
    return () => animation?.cancel()
  }, [headerFlash])
  const [visible, setVisible] = useState(false)
  const loadContent = visible || !!searchHit
  const [narrow, setNarrow] = useState(false)
  useEffect(() => {
    if (!loadContent || settings.diffLayout !== 'auto' || !root.current) return
    // Leave at least 400px per column in split view, accounting for side panels.
    const observer = new ResizeObserver(([entry]) => {
      setNarrow(entry.contentRect.width < 800)
    })
    observer.observe(root.current)
    return () => observer.disconnect()
  }, [settings.diffLayout, loadContent])
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
  useEffect(() => {
    if (!searchHit) return
    const file = root.current
    const scroll = file?.closest('[data-testid="diff-scroll"]')?.firstElementChild
    if (file && scroll)
      scroll.scrollTop += file.getBoundingClientRect().top - scroll.getBoundingClientRect().top
  }, [searchHit])
  const [force, setForce] = useState(false)
  const [range, setRange] = useState<SelectedLineRange | null>(null)
  const [selectingRange, setSelectingRange] = useState<SelectedLineRange | null>(null)
  const draft = useRef('')
  const [destination, setDestination] = useState<'local' | 'gitlab'>('gitlab')
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
      // Expand the review pane's viewport; the window's margin is clipped by the pane.
      { root: virtualizer?.getRoot(), rootMargin: '600px 0px' },
    )
    if (root.current) observer.observe(root.current)
    return () => observer.disconnect()
  }, [virtualizer])
  const content = useQuery({
    queryKey: ['review-file', snapshot.id, path, force],
    queryFn: () => window.desktop.loadReviewFile(snapshot.id, path, force),
    enabled: loadContent,
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
  const [diff, setDiff] = useState<FileDiffMetadata | null>(() =>
    content.data ? (parsedDiffs.get(content.data) ?? null) : null,
  )
  const [parseError, setParseError] = useState('')
  useEffect(() => {
    const cached = content.data && parsedDiffs.get(content.data)
    setDiff(cached ?? null)
    setParseError('')
    if (!metadata || !content.data || (!content.data.oldFile && !content.data.newFile)) return
    if (cached) return
    const fileContent = content.data
    let current = true
    const worker = new ReviewWorker()
    worker.onmessage = (event) => {
      if (!current) return
      if (event.data.error) setParseError(event.data.error)
      else {
        parsedDiffs.set(fileContent, event.data.result)
        setDiff(event.data.result)
      }
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
  const save = async (body: string) => {
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
        draft.current = ''
        setRange(null)
      })
      .catch(() => undefined)
  }
  const scrolledHit = useRef<string | null>(null)
  const remoteFocus = gitlab?.review?.discussions.find(
    (discussion) => discussion.id === threadFocus,
  )?.notes[0]?.position
  const remoteCurrent =
    !!remoteFocus &&
    !!gitlab?.review?.aligned &&
    remoteFocus.head_sha === gitlab.review.pinned.head_sha &&
    remoteFocus.base_sha === gitlab.review.pinned.base_sha &&
    remoteFocus.start_sha === gitlab.review.pinned.start_sha
  const anchor = range
    ? {
        line: Math.max(range.start, range.end),
        start: Math.min(range.start, range.end),
        side: range.side ?? ('additions' as const),
        key: `composer:${range.side}:${range.start}:${range.end}`,
      }
    : remoteFocus?.position_type === 'text' &&
        remoteCurrent &&
        Number.isInteger(remoteFocus.new_line ?? remoteFocus.old_line)
      ? {
          line: remoteFocus.new_line ?? remoteFocus.old_line!,
          side: remoteFocus.new_line ? ('additions' as const) : ('deletions' as const),
          key: `gitlab:${threadFocus}:${threadVisit}`,
        }
      : searchHit && !searchHit.fileOnly
        ? { line: searchHit.line, side: 'additions' as const, key: `search:${searchHit.key}` }
        : focusedThread && focusedThread.fingerprint === content.data?.fingerprint
          ? {
              line: focusedThread.end,
              start: focusedThread.start,
              side: focusedThread.side,
              key: `thread:${focusedThread.id}:${threadVisit}`,
            }
          : null
  useEffect(() => {
    if (
      !threadFocus ||
      !remoteFocus ||
      (remoteCurrent && remoteFocus.position_type === 'text') ||
      collapsed
    )
      return
    const frame = requestAnimationFrame(() => {
      const element = Array.from(
        root.current?.querySelectorAll<HTMLElement>('[data-discussion-id]') ?? [],
      ).find((element) => element.dataset.discussionId === threadFocus)
      const scroll = root.current?.closest('[data-testid="diff-scroll"]')?.firstElementChild
      if (element && scroll)
        scroll.scrollTop +=
          element.getBoundingClientRect().top - scroll.getBoundingClientRect().top - 24
    })
    return () => cancelAnimationFrame(frame)
  }, [threadFocus, threadVisit, remoteFocus, remoteCurrent, collapsed])
  const annotations: DiffLineAnnotation<LocalThread | Discussion | 'composer'>[] =
    currentThreads.map((thread) => ({
      side: thread.side,
      lineNumber: thread.end,
      metadata: thread,
    }))
  if (range && (!range.endSide || !range.side || range.endSide === range.side))
    annotations.push({
      side: range.side ?? 'additions',
      lineNumber: Math.max(range.start, range.end),
      metadata: 'composer',
    })
  for (const discussion of gitlab?.review?.discussions ?? []) {
    const position = discussion.notes[0]?.position
    const review = gitlab!.review!
    if (
      review.aligned &&
      position &&
      position.position_type === 'text' &&
      Number.isInteger(position.new_line ?? position.old_line) &&
      position.head_sha === review.pinned.head_sha &&
      position.base_sha === review.pinned.base_sha &&
      position.start_sha === review.pinned.start_sha &&
      (position.new_line ? position.new_path : position.old_path) ===
        (position.new_line ? path : (metadata?.oldPath ?? path))
    )
      annotations.push({
        side: position.new_line ? 'additions' : 'deletions',
        lineNumber: position.new_line ?? position.old_line!,
        metadata: discussion,
      })
  }
  const threadRanges = annotations.flatMap(({ metadata, side, lineNumber }) => {
    if (metadata === 'composer') return []
    if ('notes' in metadata) {
      if (metadata.notes[0]?.resolved) return []
      const start = metadata.notes[0]?.position?.line_range?.start
      return [
        {
          start: (side === 'deletions' ? start?.old_line : start?.new_line) ?? lineNumber,
          end: lineNumber,
          side,
        },
      ]
    }
    return metadata.resolved ? [] : [{ start: metadata.start, end: metadata.end, side }]
  })
  const options = {
    theme: { dark: 'pierre-dark', light: 'pierre-light' } as const,
    themeType: theme,
    diffStyle:
      settings.diffLayout === 'auto' ? (narrow ? 'unified' : 'split') : settings.diffLayout,
    disableFileHeader: true,
    enableLineSelection: true,
    enableGutterUtility: true,
    onGutterUtilityClick: (selection: SelectedLineRange) => {
      setDestination(gitlab?.review?.aligned ? 'gitlab' : 'local')
      setRange(selection)
    },
    preferredHighlighter: 'shiki-js' as const,
    overflow: settings.wrapLines ? ('wrap' as const) : ('scroll' as const),
    onLineSelectionStart: setSelectingRange,
    onLineSelectionChange: setSelectingRange,
    onLineSelectionEnd: (selection: SelectedLineRange | null) => {
      setSelectingRange(null)
      setDestination(gitlab?.review?.aligned ? 'gitlab' : 'local')
      setRange(selection)
    },
    unsafeCSS: codeCSS,
    // A comment in an already visible hunk should not unfold the entire file.
    // Reveal hidden context only when a target range actually extends into it.
    expandUnchanged:
      !!diff &&
      [
        ...threadRanges,
        ...(anchor
          ? [{ start: anchor.start ?? anchor.line, end: anchor.line, side: anchor.side }]
          : []),
      ].some(
        (range) =>
          !diff.hunks.some((hunk) => {
            const start = range.side === 'deletions' ? hunk.deletionStart : hunk.additionStart
            const count = range.side === 'deletions' ? hunk.deletionCount : hunk.additionCount
            return range.start >= start && range.end < start + count
          }),
      ),
    onPostRender: (node: HTMLElement, instance: object) => {
      const split = node.shadowRoot?.querySelector('[data-diff-type="split"]') != null
      const ranges = threadRanges.flatMap((range) => {
        if (!(instance instanceof VirtualizedFileDiff)) return [range]
        const start = instance.getLineIndex(range.start, range.side)
        const end = instance.getLineIndex(range.end, range.side)
        return start && end
          ? [{ ...range, start: start[split ? 1 : 0], end: end[split ? 1 : 0] }]
          : []
      })
      for (const line of node.shadowRoot?.querySelectorAll<HTMLElement>(
        '[data-line-index][data-line], [data-line-index][data-column-number]',
      ) ?? []) {
        const index =
          instance instanceof VirtualizedFileDiff
            ? Number(line.dataset.lineIndex?.split(',')[split ? 1 : 0])
            : Number(line.dataset.line ?? line.dataset.columnNumber)
        const side = split
          ? line.closest('[data-additions]')
            ? 'additions'
            : 'deletions'
          : line.dataset.lineType === 'change-addition'
            ? 'additions'
            : line.dataset.lineType === 'change-deletion'
              ? 'deletions'
              : undefined
        line.toggleAttribute(
          'data-thread-range',
          ranges.some(
            (range) => (!side || side === range.side) && index >= range.start && index <= range.end,
          ),
        )
      }
      if (!anchor || scrolledHit.current === anchor.key) return
      if (!(instance instanceof VirtualizedFileDiff) && !(instance instanceof VirtualizedFile))
        return
      scrolledHit.current = anchor.key
      requestAnimationFrame(() => {
        if (scrolledHit.current !== anchor.key || !node.isConnected) return
        // Read after the virtualizer has updated its layout for expanded context
        // and the new annotation, rather than retaining the previous position.
        const position =
          instance instanceof VirtualizedFileDiff
            ? instance.getLinePosition(anchor.line, anchor.side)
            : instance.getLinePosition(anchor.line)
        if (!position) {
          scrolledHit.current = null
          return
        }
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
  const renderAnnotation = ({
    metadata: thread,
  }: {
    metadata: LocalThread | Discussion | 'composer'
  }) =>
    thread === 'composer' ? (
      <div
        data-testid="thread-composer"
        className="m-3 flex min-w-0 flex-col gap-2 border bg-surface p-3 font-sans text-[13px]/5 font-normal text-foreground"
      >
        {range &&
          (() => {
            const headerActions = gitlab?.review?.aligned && (
              <div
                className="flex items-center gap-1"
                role="group"
                aria-label="Comment destination"
              >
                <Button
                  className="h-6 px-2 text-xs"
                  variant={destination === 'gitlab' ? 'secondary' : 'ghost'}
                  aria-pressed={destination === 'gitlab'}
                  onClick={() => setDestination('gitlab')}
                >
                  GitLab
                </Button>
                <Button
                  className="h-6 px-2 text-xs"
                  variant={destination === 'local' ? 'secondary' : 'ghost'}
                  aria-pressed={destination === 'local'}
                  onClick={() => {
                    setDestination('local')
                  }}
                >
                  Local
                </Button>
              </div>
            )
            const side = range.side ?? 'additions'
            const start = Math.min(range.start, range.end),
              end = Math.max(range.start, range.end)
            const contents =
              side === 'additions'
                ? content.data?.newFile?.contents
                : content.data?.oldFile?.contents
            const lines = contents?.split('\n') ?? []
            if (lines.at(-1) === '') lines.pop()
            const commentRange = { start, end, max: lines.length }
            const onRangeChange = ({ start, end }: { start: number; end: number }) =>
              setRange({ start, end, side })
            const suggestion =
              contents === undefined ||
              (destination === 'gitlab' && gitlab?.review?.aligned && side !== 'additions')
                ? undefined
                : lines.slice(start - 1, end).join('\n')
            return (
              <FileCommentComposer
                draft={draft}
                anchor={
                  destination === 'gitlab' && gitlab?.review?.aligned
                    ? { path, side, line: end, startLine: start }
                    : undefined
                }
                label={`Comment on ${path}`}
                busy={mutation.isPending || !record}
                headerActions={headerActions}
                range={commentRange}
                onRangeChange={onRangeChange}
                suggestion={suggestion}
                onPost={save}
                onClose={() => {
                  setRange(null)
                  draft.current = ''
                }}
              />
            )
          })()}
        {mutation.error && <p role="alert">{mutation.error.message}</p>}
      </div>
    ) : 'notes' in thread ? (
      <GitLabDiscussion discussion={thread} />
    ) : (
      <Thread
        thread={thread}
        current={thread.fingerprint === content.data?.fingerprint}
        sourceContents={
          thread.fingerprint === content.data?.fingerprint
            ? thread.side === 'additions'
              ? content.data?.newFile?.contents
              : content.data?.oldFile?.contents
            : undefined
        }
        mutate={(action) => mutation.mutateAsync(action)}
        pending={mutation.isPending}
      />
    )
  const selectedLines =
    selectingRange ??
    range ??
    (anchor ? { start: anchor.start ?? anchor.line, end: anchor.line, side: anchor.side } : null)
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
        data-git-status={
          metadata?.mergeConflict
            ? 'conflicted'
            : metadata
              ? gitStatuses[metadata.status]
              : undefined
        }
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
        <span className="shrink-0 text-muted-foreground group-data-[git-status=added]:text-git-added group-data-[git-status=untracked]:text-git-added group-data-[git-status=deleted]:text-git-deleted group-data-[git-status=modified]:text-git-modified group-data-[git-status=renamed]:text-git-renamed group-data-[git-status=conflicted]:text-git-conflicted">
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
        <h2
          title={metadata && metadata.oldPath !== path ? `${metadata.oldPath} → ${path}` : path}
          className="flex min-w-0 flex-wrap items-center gap-x-2 text-left font-mono leading-4 group-data-[git-status=added]:text-git-added group-data-[git-status=untracked]:text-git-added group-data-[git-status=deleted]:text-git-deleted group-data-[git-status=modified]:text-git-modified group-data-[git-status=renamed]:text-git-renamed group-data-[git-status=conflicted]:text-git-conflicted"
        >
          {metadata && metadata.oldPath !== path ? (
            <>
              <span className="flex max-w-full items-center gap-2" title={metadata.oldPath}>
                <span className="min-w-0 truncate" dir="rtl">
                  <bdi dir="ltr">{metadata.oldPath}</bdi>
                </span>
                <ArrowRight className="size-4 shrink-0" aria-hidden="true" />
                <span className="sr-only"> to </span>
              </span>
              <span className="max-w-[calc(100%_-_1.5rem)] truncate" dir="rtl" title={path}>
                <bdi dir="ltr">{path}</bdi>
              </span>
            </>
          ) : (
            <span className="min-w-0 truncate" dir="rtl">
              <bdi dir="ltr">{path}</bdi>
            </span>
          )}
        </h2>
        <Button
          variant="ghost"
          size="icon"
          className="shrink-0"
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
        <IDEButton
          repository={snapshot.repository}
          workspaceId={workspaceId}
          disabled={!workspaceReady}
          path={path}
          line={
            range && range.side !== 'deletions' && range.endSide !== 'deletions'
              ? Math.min(range.start, range.end)
              : (searchHit?.line ?? 1)
          }
          settings={settings}
        />
        <span role="status" className="sr-only">
          {copied ? `Copied ${path}` : ''}
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-2.5">
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
          <Label className="flex shrink-0 items-center gap-1.5 whitespace-nowrap">
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
        </div>
      </header>
      {metadata?.mergeConflict && (
        <p
          className="flex items-center gap-2 border-b border-git-conflicted/40 bg-git-conflicted/10 px-4 py-3 text-git-conflicted"
          role="note"
        >
          <CircleAlert className="size-4 shrink-0" aria-hidden="true" />
          <strong>Merge conflict:</strong> This file would conflict when merging New into Old.
        </p>
      )}
      {copyError && (
        <p role="alert" className="flex flex-wrap items-center gap-3 p-4">
          {copyError}
        </p>
      )}
      {!collapsed && (
        <>
          {gitlab?.review?.discussions
            .filter((discussion) => {
              const position = discussion.notes[0]?.position
              if (
                !position ||
                (position.new_path !== path && position.old_path !== (metadata?.oldPath ?? path))
              )
                return false
              return (
                position.position_type === 'file' ||
                !Number.isInteger(position.new_line ?? position.old_line) ||
                !gitlab.review!.aligned ||
                position.head_sha !== gitlab.review!.pinned.head_sha ||
                position.base_sha !== gitlab.review!.pinned.base_sha ||
                position.start_sha !== gitlab.review!.pinned.start_sha
              )
            })
            .map((discussion) => (
              <div className="mx-3" key={discussion.id}>
                <GitLabDiscussion discussion={discussion} />
              </div>
            ))}
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
            <FileDiff<LocalThread | Discussion | 'composer'>
              fileDiff={diff}
              options={options}
              selectedLines={selectedLines}
              lineAnnotations={annotations}
              renderAnnotation={renderAnnotation}
            />
          )}
          {!metadata && content.data?.newFile && (
            <File<LocalThread | Discussion | 'composer'>
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
      {intelligenceReady && (
        <CodeIntelligence
          root={root}
          snapshot={snapshot.id}
          workspace={workspaceId}
          path={path}
          file={content.data?.newFile}
          files={snapshot.files}
          theme={theme}
          onNavigate={onNavigate}
        />
      )}
    </article>
  )
})

// Keep keystrokes below the diff renderer. The ref preserves drafts when annotation
// slots remount after range changes or virtualization.
function FileCommentComposer({
  draft,
  anchor,
  onPost,
  onClose,
  ...props
}: Omit<ComponentProps<typeof CommentComposer>, 'body' | 'onChange' | 'onPost' | 'onCancel'> & {
  draft: RefObject<string>
  anchor?: ComponentProps<typeof GitLabComposer>['anchor']
  onPost: (body: string) => Promise<void>
  onClose: () => void
}) {
  const [body, setBody] = useState(() => draft.current)
  const onChange = (body: string) => {
    draft.current = body
    setBody(body)
  }
  return anchor ? (
    <GitLabComposer
      {...props}
      anchor={anchor}
      value={body}
      onChange={onChange}
      onSaved={onClose}
      onCancel={onClose}
    />
  ) : (
    <CommentComposer
      {...props}
      body={body}
      onChange={onChange}
      onPost={() => void onPost(body)}
      onCancel={onClose}
    />
  )
}
