import { useState } from 'react'
import { ArrowRight, FolderGit2, FolderOpen, Loader2, Search } from 'lucide-react'
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
  onSelect: (path: string) => void
}) {
  return (
    <>
      {paths.map((path) => (
        <Button
          key={path}
          variant="ghost"
          className="group h-auto w-full justify-start gap-3 px-3 py-3 text-left"
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
  onSelect: (path?: string) => void
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
