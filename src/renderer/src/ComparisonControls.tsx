import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { useId, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ArrowLeftRight, ArrowLeft, Pencil, RefreshCw } from 'lucide-react'
import type { Comparison } from '../../shared/review'
import type { Repository } from '../../shared/desktop'
import { RevisionIcon, RevisionSelect } from './RevisionSelect'
import { Button } from '@/components/ui/button'
import { Tooltip } from '@/components/ui/tooltip'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'

export function ComparisonControls({
  repository,
  initial,
  onCompare,
  isPending,
}: {
  repository: Repository
  initial: Comparison
  onCompare: (comparison: Comparison, refresh?: boolean) => void
  isPending: boolean
}) {
  const modeId = useId()
  const [open, setOpen] = useState(false)
  const appliedNew =
    initial.target.kind === 'working'
      ? 'Uncommitted'
      : initial.target.kind === 'index'
        ? 'Index'
        : initial.target.ref
  const appliedOld =
    initial.base.kind === 'index'
      ? 'Index'
      : initial.base.kind === 'commit'
        ? initial.base.ref
        : 'HEAD'
  const [newRevision, setNewRevision] = useState(appliedNew)
  const [oldRevision, setOldRevision] = useState(appliedOld)
  const [mode, setMode] = useState(initial.mode)
  const refs = useQuery({
    queryKey: ['refs', repository.path],
    queryFn: () => window.desktop.getRepositoryRefs(repository.path),
  })
  const canSwap =
    !!newRevision.trim() &&
    !!oldRevision.trim() &&
    !['Uncommitted', 'Index'].includes(newRevision) &&
    !['Uncommitted', 'Index'].includes(oldRevision)
  const comparison: Comparison = {
    base: oldRevision === 'Index' ? { kind: 'index' } : { kind: 'commit', ref: oldRevision.trim() },
    target:
      newRevision === 'Uncommitted'
        ? { kind: 'working' }
        : newRevision === 'Index'
          ? { kind: 'index' }
          : { kind: 'commit', ref: newRevision.trim() },
    mode: canSwap ? mode : 'direct',
  }
  return (
    <div
      data-testid="comparison-controls"
      className="comparison-controls flex min-w-0 items-center gap-2"
    >
      <div className="flex min-w-0 items-center gap-2 text-sm">
        <span className="shrink-0 text-git-deleted">Old</span>
        <RevisionIcon
          kind={
            initial.base.kind === 'commit'
              ? (refs.data?.find((item) => item.value === appliedOld)?.kind ?? 'commit')
              : initial.base.kind
          }
        />
        <span className="max-w-72 truncate" title={appliedOld}>
          {appliedOld}
        </span>
        <ArrowLeft className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="shrink-0 text-git-added">New</span>
        <RevisionIcon
          kind={
            initial.target.kind === 'commit'
              ? (refs.data?.find((item) => item.value === appliedNew)?.kind ?? 'commit')
              : initial.target.kind
          }
        />
        <span className="max-w-72 truncate" title={appliedNew}>
          {appliedNew}
        </span>
      </div>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (next) {
            setOldRevision(appliedOld)
            setNewRevision(appliedNew)
            setMode(initial.mode)
          }
          setOpen(next)
        }}
      >
        <Tooltip label="Edit comparison">
          <DialogTrigger asChild>
            <Button type="button" variant="ghost" size="icon" aria-label="Edit comparison">
              <Pencil />
            </Button>
          </DialogTrigger>
        </Tooltip>
        <DialogContent
          className="max-w-xl"
          closeLabel="Close comparison"
          onEscapeKeyDown={(event) => {
            if (document.querySelector('[data-slot="combobox-content"]')) event.preventDefault()
          }}
        >
          <DialogTitle className="pr-8 font-semibold">Edit comparison</DialogTitle>
          <DialogDescription className="mt-1 text-sm text-muted-foreground">
            Choose what to compare. Your review updates when you click Compare.
          </DialogDescription>
          <form
            onSubmit={(event) => {
              event.preventDefault()
              if (isPending || !newRevision.trim() || !oldRevision.trim()) return
              onCompare(comparison)
              setOpen(false)
            }}
          >
            <div className="mt-5 mb-6 space-y-5">
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm font-medium">Revisions</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="default"
                  aria-label="Swap Old and New"
                  disabled={!canSwap}
                  onClick={() => {
                    setNewRevision(oldRevision)
                    setOldRevision(newRevision)
                  }}
                >
                  <ArrowLeftRight />
                  Swap old and new
                </Button>
              </div>
              <RevisionSelect
                label="Old"
                description="The base revision to compare against."
                value={oldRevision}
                onChange={setOldRevision}
                suggestions={[
                  ...(newRevision === 'Uncommitted'
                    ? [{ value: 'Index', kind: 'index' as const }]
                    : []),
                  ...(refs.data ?? [{ value: 'HEAD', kind: 'commit' as const }]),
                ]}
              />
              <RevisionSelect
                label="New"
                description="The revision or local changes you want to review."
                value={newRevision}
                onChange={(value) => {
                  setNewRevision(value)
                  if (value !== 'Uncommitted' && oldRevision === 'Index') setOldRevision('HEAD')
                }}
                suggestions={[
                  { value: 'Uncommitted', kind: 'working' },
                  { value: 'Index', kind: 'index' },
                  ...(refs.data ?? [{ value: 'HEAD', kind: 'commit' as const }]),
                ]}
              />
              <div className="flex items-start justify-between gap-4 rounded-lg border bg-muted/30 p-4">
                <div className="space-y-1">
                  <Label htmlFor={modeId} className="text-sm font-medium">
                    Merge-base
                  </Label>
                  <p
                    id={`${modeId}-description`}
                    className="text-sm leading-relaxed text-muted-foreground"
                  >
                    {canSwap
                      ? 'Compare New with the common ancestor of both revisions to see changes since they diverged.'
                      : 'Local changes are compared directly. Merge-base is available when both revisions are commits, branches, or tags.'}
                  </p>
                </div>
                <Switch
                  id={modeId}
                  aria-describedby={`${modeId}-description`}
                  className="mt-0.5"
                  disabled={!canSwap}
                  checked={canSwap && mode === 'merge-base'}
                  onCheckedChange={(checked) => setMode(checked ? 'merge-base' : 'direct')}
                />
              </div>
            </div>
            <div className="flex justify-end gap-2 border-t pt-4">
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={isPending || !newRevision.trim() || !oldRevision.trim()}
              >
                Compare
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
      <Tooltip label="Fetch and refresh comparison">
        <span className="inline-flex shrink-0">
          <Button
            variant="ghost"
            size="icon"
            type="button"
            aria-label="Refresh comparison"
            aria-busy={isPending}
            disabled={isPending}
            onClick={() => onCompare(initial, true)}
          >
            <RefreshCw className={isPending ? 'animate-spin' : undefined} />
          </Button>
        </span>
      </Tooltip>
    </div>
  )
}
