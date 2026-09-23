import { FolderOpen } from 'lucide-react'
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
          className="h-auto w-full flex-col items-start gap-1 rounded-none border-t px-0 py-3 text-left whitespace-normal"
          disabled={pending}
          onClick={() => onSelect(path)}
        >
          <span className="font-semibold">{path.split(/[\\/]/).pop()}</span>
          <span className="font-mono text-muted-foreground wrap-anywhere">{path}</span>
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
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent closeLabel="Close repository picker">
        <DialogTitle className="font-semibold">Open repository</DialogTitle>
        <DialogDescription className="sr-only">
          Select a recent repository or add one from your computer.
        </DialogDescription>
        <div className="my-4 max-h-[45vh] overflow-auto">
          <RepositoryChoices paths={paths} pending={pending} onSelect={onSelect} />
        </div>
        <Button variant="outline" disabled={pending} onClick={() => onSelect()}>
          <FolderOpen />
          Add repository
        </Button>
        {error && (
          <p role="alert" className="mt-4">
            {error.message}
          </p>
        )}
      </DialogContent>
    </Dialog>
  )
}
