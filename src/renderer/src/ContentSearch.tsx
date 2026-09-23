import { Input } from '@/components/ui/input'
import { useEffect, useState, type RefObject } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Search, X } from 'lucide-react'
import type { ContentMatch } from '../../shared/review'
import { Button } from '@/components/ui/button'

export function ContentSearch({
  snapshotId,
  inputRef,
  onSelect,
  onClear,
  hasHit,
}: {
  snapshotId?: string
  inputRef: RefObject<HTMLInputElement | null>
  onSelect: (match: ContentMatch) => void
  onClear: () => void
  hasHit: boolean
}) {
  const [contentSearch, setContentSearch] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  useEffect(() => {
    const timer = setTimeout(() => setSearchQuery(contentSearch.trim()), 200)
    return () => clearTimeout(timer)
  }, [contentSearch])
  const contentResults = useQuery({
    queryKey: ['content-search', snapshotId, searchQuery],
    queryFn: () => window.desktop.searchReviewContents(snapshotId!, searchQuery),
    enabled: !!snapshotId && !!searchQuery,
    retry: false,
  })
  return (
    <>
      <div className="ml-auto flex items-center gap-1.5 text-muted-foreground [&_input]:w-46.25">
        <Search size={14} />
        <Input
          ref={inputRef}
          aria-label="Search file contents"
          placeholder="Search file contents"
          value={contentSearch}
          onFocus={() => setSearchOpen(true)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') setSearchOpen(false)
          }}
          onChange={(event) => {
            setContentSearch(event.target.value)
            setSearchOpen(true)
          }}
        />
        {(contentSearch || hasHit) && (
          <Button
            variant="ghost"
            aria-label="Clear content search"
            onClick={() => {
              setContentSearch('')
              onClear()
              setSearchOpen(false)
            }}
          >
            <X size={14} />
          </Button>
        )}
      </div>
      {searchOpen && contentSearch.trim() && (
        <section
          className="max-h-[35vh] basis-full shrink-0 overflow-auto border-b"
          aria-label="Content search results"
        >
          <div className="flex items-center justify-between px-3 py-1.5">
            <span>
              {contentResults.isFetching || searchQuery !== contentSearch.trim()
                ? 'Searching…'
                : contentResults.error
                  ? contentResults.error.message
                  : `${contentResults.data?.matches.length ?? 0}${contentResults.data?.truncated ? '+' : ''} matches in reviewed revision`}
            </span>
            <Button variant="ghost" onClick={() => setSearchOpen(false)}>
              Close search
            </Button>
          </div>
          {searchQuery === contentSearch.trim() &&
            contentResults.data?.matches.map((match, index) => (
              <Button
                variant="ghost"
                key={`${match.path}:${match.line}:${index}`}
                className="h-auto w-full justify-start gap-3.5 rounded-none border-t px-3 py-1.5 text-left"
                onClick={() => {
                  onSelect(match)
                  setSearchOpen(false)
                }}
              >
                <span className="flex-[0_0_35%] truncate font-mono">
                  {match.path}:{match.line}
                </span>
                <span className="truncate font-mono text-muted-foreground">{match.text}</span>
              </Button>
            ))}
        </section>
      )}
    </>
  )
}
