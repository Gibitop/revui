import { useId, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  ArrowRight,
  FolderGit2,
  FolderOpen,
  GitPullRequest,
  Loader2,
  RefreshCw,
  Search,
} from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'

export function RepositoryChoices({
  paths,
  pending,
  onSelect,
}: {
  paths: string[]
  pending: boolean
  onSelect: (path: string, mr?: string) => void
}) {
  const [mrPath, setMrPath] = useState<string | null>(null)
  return (
    <>
      {paths.map((path) => (
        <div
          key={path}
          data-expanded={mrPath === path}
          className="rounded-lg border border-transparent transition-colors data-[expanded=true]:border-border data-[expanded=true]:bg-muted/30"
        >
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              className="group h-auto min-w-0 flex-1 justify-start gap-3 px-3 py-3 text-left"
              title={path}
              disabled={pending}
              onClick={() => onSelect(path)}
            >
              <span className="flex size-9 shrink-0 items-center justify-center rounded-md border bg-surface text-muted-foreground">
                <FolderGit2 />
              </span>
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="truncate font-semibold">{path.split(/[\\/]/).pop()}</span>
                <span className="truncate font-mono text-muted-foreground">{path}</span>
              </span>
              <ArrowRight className="text-muted-foreground opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="mr-3 shrink-0 text-muted-foreground aria-expanded:bg-accent aria-expanded:text-foreground"
              aria-label={`Open merge request in ${path.split(/[\\/]/).pop()}`}
              title="Open merge request"
              disabled={pending}
              aria-expanded={mrPath === path}
              onClick={() => {
                setMrPath(mrPath === path ? null : path)
              }}
            >
              <GitPullRequest />
            </Button>
          </div>
          {mrPath === path && (
            <MergeRequestChoices path={path} pending={pending} onSelect={onSelect} />
          )}
        </div>
      ))}
    </>
  )
}

function MergeRequestChoices({
  path,
  pending,
  onSelect,
}: {
  path: string
  pending: boolean
  onSelect: (path: string, mr: string) => void
}) {
  const inputId = useId()
  const [mr, setMr] = useState('')
  const [search, setSearch] = useState('')
  const { data, error, isPending, isFetching, refetch } = useQuery({
    queryKey: ['open-merge-requests', path],
    queryFn: async () =>
      (await window.desktop.gitlab({ kind: 'list-mrs', repository: path })).matches ?? [],
    retry: false,
    refetchOnWindowFocus: false,
  })
  const matches = data?.filter((item) =>
    `${item.iid} ${item.title} ${item.author.name} ${item.source_branch} ${item.target_branch}`
      .toLowerCase()
      .includes(search.trim().toLowerCase().replace(/^!/, '')),
  )

  return (
    <div className="mx-3 border-t py-3">
      <form
        onSubmit={(event) => {
          event.preventDefault()
          if (mr.trim() && !pending) onSelect(path, mr.trim())
        }}
      >
        <label htmlFor={inputId} className="block text-xs font-medium">
          Open by link or MR ID
        </label>
        <div className="mt-2 flex items-center gap-2 rounded-md border border-input bg-background p-1 focus-within:ring-2 focus-within:ring-ring">
          <Input
            id={inputId}
            autoFocus
            aria-label="Merge request ID or link"
            placeholder="!123 or paste a merge request link"
            className="h-8 w-full flex-1 border-0 bg-transparent px-2 shadow-none focus-visible:ring-0"
            value={mr}
            disabled={pending}
            onChange={(event) => setMr(event.target.value)}
          />
          <Button
            type="submit"
            className="h-8 shrink-0 gap-1.5 px-2.5"
            disabled={pending || !mr.trim()}
          >
            Open MR
            {pending ? <Loader2 className="animate-spin" /> : <ArrowRight />}
          </Button>
        </div>
        <p className="mt-1.5 text-xs text-muted-foreground">
          Open any MR in this repository, including merged or closed requests.
        </p>
      </form>
      <div className="mt-4 flex items-center justify-between gap-2">
        <h3 className="font-semibold">Open merge requests{data ? ` (${data.length})` : ''}</h3>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Refresh open merge requests"
          disabled={isFetching || pending}
          onClick={() => void refetch()}
        >
          <RefreshCw className={isFetching ? 'animate-spin' : ''} />
        </Button>
      </div>
      {error && (
        <div role="status" className="mt-2 rounded-md border bg-background p-3">
          <p className="font-medium">Couldn’t load open merge requests</p>
          <p className="mt-1 text-xs text-muted-foreground wrap-anywhere">{error.message}</p>
          <Button
            variant="outline"
            className="mt-2"
            disabled={isFetching || pending}
            onClick={() => void refetch()}
          >
            Try again
          </Button>
        </div>
      )}
      {isPending && !error && (
        <p role="status" className="flex items-center gap-2 py-5 text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading open merge requests…
        </p>
      )}
      {data && data.length === 0 && !error && (
        <div role="status" className="py-5 text-center text-muted-foreground">
          <GitPullRequest className="mx-auto mb-2 size-5" />
          <p>No open merge requests in this repository.</p>
          <p className="mt-1 text-xs">You can still open an MR by link or ID above.</p>
        </div>
      )}
      {!!data?.length && (
        <>
          <div className="relative mt-2">
            <Search className="pointer-events-none absolute top-2.5 left-3 size-4 text-muted-foreground" />
            <Input
              aria-label="Filter open merge requests"
              placeholder="Filter by title, author, branch or ID…"
              className="w-full pl-9"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
          <div
            className="mt-2 max-h-64 overflow-y-auto rounded-md border bg-background p-1"
            aria-label="Open merge requests"
            aria-busy={isFetching}
          >
            {matches?.map((item) => (
              <Button
                key={item.iid}
                variant="ghost"
                className="group h-auto w-full justify-start gap-2 px-2 py-3 text-left whitespace-normal"
                disabled={pending}
                onClick={() => onSelect(path, String(item.iid))}
              >
                <GitPullRequest className="mt-0.5 shrink-0 self-start text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="block font-medium wrap-anywhere">{item.title}</span>
                  <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                    <span>!{item.iid}</span>
                    <span>{item.author.name}</span>
                    {item.draft && <span className="rounded border px-1.5">Draft</span>}
                  </span>
                  <span
                    className="mt-1 block truncate font-mono text-xs text-muted-foreground"
                    title={`${item.source_branch} → ${item.target_branch}`}
                  >
                    {item.source_branch} → {item.target_branch}
                  </span>
                </span>
                <ArrowRight className="shrink-0 text-muted-foreground group-hover:text-foreground" />
              </Button>
            ))}
            {matches?.length === 0 && (
              <p role="status" className="px-3 py-5 text-center text-muted-foreground">
                No matching merge requests. Try another title, author, branch or ID.
              </p>
            )}
          </div>
        </>
      )}
      {pending && (
        <p role="status" className="mt-2 text-muted-foreground">
          Fetching and opening merge request…
        </p>
      )}
    </div>
  )
}

export function RepositoryDialog({
  open,
  onOpenChange,
  paths,
  pending,
  onSelect,
  error,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  paths: string[]
  pending: boolean
  onSelect: (path?: string, mr?: string) => void
  error: Error | null
}) {
  const [search, setSearch] = useState('')
  const matches = paths.filter((path) => path.toLowerCase().includes(search.trim().toLowerCase()))

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[calc(100dvh-3rem)] max-w-lg overflow-auto"
        closeLabel="Close repository picker"
        onOpenAutoFocus={() => setSearch('')}
      >
        <DialogTitle className="pr-8 font-semibold">Open repository</DialogTitle>
        <DialogDescription className="mt-1 text-muted-foreground">
          Choose a local Git repository to start reviewing.
        </DialogDescription>
        {paths.length > 0 ? (
          <>
            <div className="relative mt-5">
              <Search className="pointer-events-none absolute top-3 left-3 size-4 text-muted-foreground" />
              <Input
                aria-label="Search recent repositories"
                placeholder="Search by name or path…"
                className="h-10 w-full pl-9"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && matches.length === 1 && !pending) {
                    event.preventDefault()
                    onSelect(matches[0])
                  }
                }}
              />
            </div>
            <h2 className="mt-5 mb-2 font-semibold text-muted-foreground">Recent repositories</h2>
            <div className="-mx-1 max-h-[60vh] overflow-auto p-1">
              {matches.length > 0 ? (
                <RepositoryChoices paths={matches} pending={pending} onSelect={onSelect} />
              ) : (
                <div role="status" className="px-3 py-6 text-center text-muted-foreground">
                  No matching repositories. Try another name or open a folder below.
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="my-5 rounded-lg border border-dashed bg-surface px-5 py-6 text-center">
            <FolderGit2 className="mx-auto mb-3 size-6 text-muted-foreground" />
            <p className="font-semibold">Your reviews start here</p>
            <p className="mt-1 text-muted-foreground">
              Open a folder containing a Git repository. It will appear here next time.
            </p>
          </div>
        )}
        <div className="mt-4 border-t pt-4">
          <Button className="h-10 w-full" disabled={pending} onClick={() => onSelect()}>
            {pending ? <Loader2 className="animate-spin" /> : <FolderOpen />}
            {pending ? 'Opening repository…' : 'Open folder…'}
          </Button>
        </div>
        {error && (
          <p role="alert" className="mt-4 rounded-md border bg-muted p-3 wrap-anywhere">
            {error.message}
          </p>
        )}
      </DialogContent>
    </Dialog>
  )
}
