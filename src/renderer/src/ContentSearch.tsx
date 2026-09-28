import { Input } from '@/components/ui/input'
import { Tooltip } from '@/components/ui/tooltip'
import { startTransition, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { useQuery } from '@tanstack/react-query'
import { getFiletypeFromFileName, resolveLanguages, resolveThemes } from '@pierre/diffs'
import SearchHighlightWorker from './search-highlight.worker?worker'
import type { SearchHighlightResponse } from './search-highlight.worker'
import { CaseSensitive, ChevronRight, WholeWord, Regex, Search, X } from 'lucide-react'
import { gitStatuses } from './ReviewSidebar'
import type { ContentMatch, ContentSearchOptions, ReviewFile } from '../../shared/review'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from '@/components/ui/dialog'

export function ContentSearch({
  open,
  onOpenChange,
  snapshotId,
  paths,
  filesByPath,
  theme,
  inputRef,
  onSelect,
  onClear,
  hasHit,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  snapshotId?: string
  paths: string[]
  filesByPath: Map<string, ReviewFile>
  theme: 'light' | 'dark'
  inputRef: RefObject<HTMLInputElement | null>
  onSelect: (match: ContentMatch) => void
  onClear: () => void
  hasHit: boolean
}) {
  const [options, setOptions] = useState<ContentSearchOptions>({})
  const [contentSearch, setContentSearch] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  useEffect(() => {
    const timer = setTimeout(() => setSearchQuery(contentSearch.trim()), 200)
    return () => clearTimeout(timer)
  }, [contentSearch])
  const contentResults = useQuery({
    queryKey: ['content-search', snapshotId, searchQuery, paths, options],
    queryFn: () => window.desktop.searchReviewContents(snapshotId!, searchQuery, paths, options),
    enabled: !!snapshotId && !!searchQuery,
    retry: false,
  })
  const workerRef = useRef<Worker | null>(null)
  const requestId = useRef(0)
  const [highlighted, setHighlighted] = useState<{
    data: typeof contentResults.data
    theme: typeof theme
    tokens: SearchHighlightResponse['tokens']
  } | null>(null)
  useEffect(
    () => () => {
      workerRef.current?.terminate()
      workerRef.current = null
    },
    [],
  )
  useEffect(() => {
    const data = contentResults.data
    if (!open) {
      workerRef.current?.terminate()
      workerRef.current = null
      return
    }
    if (!data?.matches.length) return
    const worker = workerRef.current ?? new SearchHighlightWorker()
    workerRef.current = worker
    const id = ++requestId.current
    const onMessage = (event: MessageEvent<SearchHighlightResponse>) => {
      if (event.data.id !== id) return
      startTransition(() => setHighlighted({ data, theme, tokens: event.data.tokens }))
    }
    worker.addEventListener('message', onMessage)
    let cancelled = false
    void Promise.all([
      resolveLanguages([
        ...new Set(data.matches.map((match) => getFiletypeFromFileName(match.path))),
      ]),
      resolveThemes([theme === 'dark' ? 'pierre-dark' : 'pierre-light']),
    ])
      .then(([languages, themes]) => {
        if (!cancelled) worker.postMessage({ id, matches: data.matches, theme, languages, themes })
      })
      .catch(() => {
        // Plain-text snippets and match highlights remain available if a grammar cannot load.
      })
    return () => {
      cancelled = true
      worker.removeEventListener('message', onMessage)
      worker.postMessage({ id: -id, matches: [], theme })
    }
  }, [contentResults.data, theme, open])
  const highlightedTokens =
    highlighted?.data === contentResults.data && highlighted?.theme === theme
      ? highlighted.tokens
      : undefined
  const resultGroups = useMemo(() => {
    if (!open) return null
    const matchesByPath = new Map<string, ContentMatch[]>()
    for (const match of contentResults.data?.matches ?? []) {
      const matches = matchesByPath.get(match.path)
      if (matches) matches.push(match)
      else matchesByPath.set(match.path, [match])
    }
    return Array.from(matchesByPath, ([path, matches]) => (
      <details
        key={path}
        open
        aria-label={path}
        className="group/card mb-4 overflow-hidden rounded-lg border"
      >
        <summary
          data-git-status={gitStatuses[filesByPath.get(path)?.status ?? '']}
          className="group flex cursor-pointer list-none items-center gap-3 bg-surface px-3 py-2.5 outline-none group-open/card:border-b hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [&::-webkit-details-marker]:hidden"
        >
          <ChevronRight
            aria-hidden="true"
            className="size-4 shrink-0 text-muted-foreground group-open/card:rotate-90"
          />
          <span
            aria-label={filesByPath.get(path)?.status ?? 'Unchanged'}
            className="w-4 shrink-0 text-center font-mono font-semibold text-muted-foreground group-data-[git-status=added]:text-git-added group-data-[git-status=untracked]:text-git-added group-data-[git-status=deleted]:text-git-deleted group-data-[git-status=modified]:text-git-modified group-data-[git-status=renamed]:text-git-renamed"
          >
            {filesByPath.get(path)?.status ?? '–'}
          </span>
          <h3
            className="min-w-0 flex-1 truncate font-mono group-data-[git-status=added]:text-git-added group-data-[git-status=untracked]:text-git-added group-data-[git-status=deleted]:text-git-deleted group-data-[git-status=modified]:text-git-modified group-data-[git-status=renamed]:text-git-renamed"
            title={path}
          >
            {path}
          </h3>
          <span
            className="shrink-0 rounded bg-muted px-2 text-muted-foreground"
            aria-label={`${matches.length} matches`}
          >
            {matches.length}
          </span>
        </summary>
        <div className="p-1">
          {matches.map((match) => {
            const tokens = highlightedTokens?.get(path)?.get(match.line) ?? [
              { content: match.text, color: undefined },
            ]
            let offset = 0
            const snippet = tokens.flatMap((token, tokenIndex) => {
              const start = offset
              const end = start + token.content.length
              offset = end
              const boundaries = [start, end]
              for (const range of match.ranges) {
                if (range.start > start && range.start < end) boundaries.push(range.start)
                if (range.end > start && range.end < end) boundaries.push(range.end)
              }
              boundaries.sort((a, b) => a - b)
              return boundaries.slice(0, -1).map((from, index) => {
                const text = token.content.slice(from - start, boundaries[index + 1] - start)
                const isMatch = match.ranges.some(
                  (range) => range.start <= from && range.end > from,
                )
                return isMatch ? (
                  <mark
                    key={`${tokenIndex}:${index}`}
                    className="rounded-xs bg-amber-200 text-inherit dark:bg-amber-400/30"
                    style={{ color: token.color }}
                  >
                    {text}
                  </mark>
                ) : (
                  <span key={`${tokenIndex}:${index}`} style={{ color: token.color }}>
                    {text}
                  </span>
                )
              })
            })
            return (
              <Button
                variant="ghost"
                key={match.line}
                aria-label={`${path}:${match.line} ${match.text}`}
                className="h-auto w-full justify-start gap-3 rounded-md px-2 py-2 text-left font-mono"
                onClick={() => {
                  onSelect(match)
                  onOpenChange(false)
                }}
              >
                <span className="min-w-8 shrink-0 text-right text-muted-foreground">
                  {match.line}
                </span>
                <span className="min-w-0 truncate whitespace-pre">{snippet}</span>
              </Button>
            )
          })}
        </div>
      </details>
    ))
  }, [contentResults.data, highlightedTokens, filesByPath, onSelect, onOpenChange, open])
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Search contents"
          title="Search contents (⌘/Ctrl+F)"
        >
          <Search />
        </Button>
      </DialogTrigger>
      <DialogContent
        closeLabel="Close search"
        animation="slide-right"
        aria-describedby={undefined}
        className="inset-y-0 right-0 left-auto flex h-dvh w-[50vw] max-w-none translate-x-0 translate-y-0 flex-col gap-0 rounded-none border-y-0 border-r-0 p-0 shadow-2xl"
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          inputRef.current?.focus()
        }}
        onKeyDown={(event) => {
          // Dismiss search even when a closing tooltip also consumes Escape.
          if (event.key === 'Escape' && !event.nativeEvent.isComposing) {
            event.preventDefault()
            onOpenChange(false)
          }
        }}
      >
        <header className="shrink-0 border-b px-6 pt-5 pb-5">
          <DialogTitle className="pr-10 font-semibold">Search file contents</DialogTitle>
          <p className="mt-1 text-muted-foreground">Search within the current file-tree filter.</p>
          <div className="relative mt-4 w-full">
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              ref={inputRef}
              className="h-11 w-full rounded-lg bg-surface pr-37 pl-10"
              aria-label="Search file contents"
              placeholder="Search file contents…"
              value={contentSearch}
              onChange={(event) => setContentSearch(event.target.value)}
            />
            <div className="absolute top-1/2 right-1.5 flex -translate-y-1/2 items-center gap-0.5">
              {(
                [
                  { key: 'matchCase', label: 'Match case', Icon: CaseSensitive },
                  { key: 'wholeWord', label: 'Match whole word', Icon: WholeWord },
                  { key: 'regex', label: 'Use regular expression', Icon: Regex },
                ] as const
              ).map(({ key, label, Icon }) => (
                <Tooltip
                  key={key}
                  label={key === 'regex' ? `${label} (Perl-compatible syntax)` : label}
                >
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={label}
                    aria-pressed={!!options[key]}
                    className="text-muted-foreground aria-pressed:bg-accent aria-pressed:text-foreground aria-pressed:inset-ring aria-pressed:inset-ring-border"
                    onClick={() => setOptions({ ...options, [key]: !options[key] })}
                  >
                    <Icon />
                  </Button>
                </Tooltip>
              ))}
              {(contentSearch || hasHit) && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="text-muted-foreground"
                  aria-label="Clear content search"
                  onClick={() => {
                    setContentSearch('')
                    onClear()
                    inputRef.current?.focus()
                  }}
                >
                  <X size={14} />
                </Button>
              )}
            </div>
          </div>
        </header>
        <section
          className="min-h-0 flex-1 overflow-auto px-3 pb-3"
          aria-label="Content search results"
        >
          <p
            className="sticky top-0 z-10 bg-background px-3 py-4 text-muted-foreground"
            role="status"
          >
            {!contentSearch.trim()
              ? 'Search contents in the filtered files.'
              : contentResults.isFetching || searchQuery !== contentSearch.trim()
                ? 'Searching…'
                : contentResults.error
                  ? contentResults.error.message
                  : `${contentResults.data?.matches.length ?? 0}${contentResults.data?.truncated ? '+' : ''} matches in filtered files`}
          </p>
          {!!contentSearch.trim() && resultGroups}
        </section>
      </DialogContent>
    </Dialog>
  )
}
