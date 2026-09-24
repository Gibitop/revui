import { useState } from 'react'
import { ArrowRight, FolderGit2, FolderOpen, GitPullRequest, Loader2, Search } from 'lucide-react'
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
  const [mr, setMr] = useState('')
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
                setMr('')
              }}
            >
              <GitPullRequest />
            </Button>
          </div>
          {mrPath === path && (
            <form
              className="mx-3 border-t py-3"
              onSubmit={(event) => {
                event.preventDefault()
                if (mr.trim() && !pending) onSelect(path, mr.trim())
              }}
            >
              <div>
                <p className="text-xs font-medium text-muted-foreground">Merge request</p>
                <div className="mt-2 flex items-center gap-2 rounded-md border border-input bg-background p-1 focus-within:ring-2 focus-within:ring-ring">
                  <Input
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
              </div>
            </form>
          )}
        </div>
      ))}
    </>
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
            <div className="-mx-1 max-h-[40vh] overflow-auto p-1">
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
