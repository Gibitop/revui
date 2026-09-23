import { useEffect, useRef, useState } from 'react'
import { Loader2, Zap } from 'lucide-react'
import type { Snapshot } from '../../shared/review'
import type { Settings } from '../../shared/desktop'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Tooltip } from '@/components/ui/tooltip'
import { IDEButton } from './IDEButton'

export function WorkspaceTools({
  snapshot,
  active,
  setActive,
  settings,
}: {
  snapshot: Snapshot
  active: string | null
  setActive: (id: string | null) => void
  settings: Settings
}) {
  const operation = useRef(0)
  const [open, setOpen] = useState(false)
  const [ready, setReady] = useState(false)
  const [busy, setBusy] = useState(false)
  const [removing, setRemoving] = useState<string | null>(null)
  const [choice, setChoice] = useState<'worktree' | 'in-place'>('worktree')
  const [needsCheckout, setNeedsCheckout] = useState(false)
  const [error, setError] = useState('')
  const [output, setOutput] = useState('')
  useEffect(() => {
    const currentOperation = operation.current
    let canceled = false
    void window.desktop
      .findWorkspace(snapshot.id)
      .then((record) => {
        if (canceled || operation.current !== currentOperation || !record) return
        setActive(record.id)
        setReady(!!record.initialized)
      })
      .catch(() => {
        /* Explicit initialization reports lookup errors. */
      })
    return () => {
      canceled = true
    }
  }, [snapshot.id, setActive])
  useEffect(() => {
    const changed = (event: Event) => {
      const { repository } = (event as CustomEvent<{ repository: string }>).detail
      if (repository !== snapshot.repository) return
      operation.current += 1
      void window.desktop
        .listWorkspaces(snapshot.repository)
        .then((records) => {
          if (
            !active ||
            !records.some((record) => record.id === active && record.phase === 'ready')
          ) {
            setReady(false)
            setActive(null)
          }
        })
        .catch((error) => setError(String(error)))
    }
    const removal = (event: Event) => {
      const { id, pending } = (event as CustomEvent<{ id: string; pending: boolean }>).detail
      setRemoving((current) =>
        pending ? (id === active ? id : current) : current === id ? null : current,
      )
    }
    window.addEventListener('worktree-removal', removal)
    window.addEventListener('workspaces-changed', changed)
    const unsubscribe = window.desktop.onScriptOutput((data) => setOutput((value) => value + data))
    return () => {
      window.removeEventListener('worktree-removal', removal)
      window.removeEventListener('workspaces-changed', changed)
      unsubscribe()
    }
  }, [snapshot.repository, active, setActive])
  const initialize = async (checkout = false) => {
    const currentOperation = ++operation.current
    setBusy(true)
    setReady(false)
    setError('')
    setOutput('')
    setOpen(false)
    try {
      let id = active
      if (snapshot.comparison.target.kind === 'working') {
        id = null
        setActive(null)
      }
      if (checkout) {
        const record = await window.desktop.prepareWorkspace(snapshot.id, choice)
        if (!record || currentOperation !== operation.current) return
        id = record.id
        setActive(id)
        setNeedsCheckout(false)
      }
      const matched = await window.desktop.initializeWorkspace(snapshot.id, id)
      if (currentOperation !== operation.current) return
      setNeedsCheckout(!matched)
      setReady(!!matched)
      if (matched) setActive(matched.workspace)
      setOpen(!matched)
    } catch (error) {
      if (currentOperation === operation.current) {
        setError(error instanceof Error ? error.message : String(error))
        setOpen(true)
      }
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <Tooltip
        label={
          removing
            ? 'Deleting workspace…'
            : busy
              ? 'Initializing workspace… Click to cancel setup'
              : ready
                ? 'Workspace ready · Run setup again'
                : 'Initialize workspace'
        }
      >
        <span className="inline-flex">
          <Button
            variant="ghost"
            size="icon"
            aria-label={
              removing ? 'Deleting workspace' : busy ? 'Cancel setup' : 'Initialize workspace'
            }
            disabled={!!removing}
            aria-busy={busy || !!removing}
            onClick={() => (busy ? void window.desktop.cancelWorkspaceScript() : void initialize())}
            className={ready && !removing ? 'text-yellow-500 hover:text-yellow-500' : ''}
          >
            {busy || removing ? <Loader2 className="animate-spin" /> : <Zap />}
          </Button>
        </span>
      </Tooltip>
      <IDEButton
        repository={snapshot.repository}
        workspaceId={active}
        path={null}
        line={1}
        settings={settings}
        disabled={!ready || busy || !!removing}
      />
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          closeLabel="Close workspace setup"
          className="max-h-[85vh] max-w-lg space-y-5 overflow-y-auto"
        >
          <div className="space-y-2">
            <DialogTitle>{error ? 'Workspace setup failed' : 'Prepare workspace'}</DialogTitle>
            <DialogDescription>
              {error
                ? 'Initialization could not complete. Review the error below and try again.'
                : 'The review target differs from the current checkout. Choose where to prepare it.'}
            </DialogDescription>
          </div>
          {needsCheckout && !busy && !ready && (
            <fieldset className="space-y-3" disabled={busy}>
              <legend className="sr-only">Checkout location</legend>
              <label className="flex cursor-pointer items-start gap-3 rounded-lg border p-4 has-checked:border-ring has-checked:bg-accent/50">
                <input
                  type="radio"
                  name="checkout"
                  value="worktree"
                  aria-label="New worktree"
                  checked={choice === 'worktree'}
                  onChange={() => setChoice('worktree')}
                  className="mt-1"
                />
                <span>
                  <span className="block font-semibold">New worktree</span>
                  <span className="mt-1 block text-muted-foreground">
                    Prepare a separate directory and keep your current checkout intact.
                  </span>
                </span>
              </label>
              <label className="flex cursor-pointer items-start gap-3 rounded-lg border p-4 has-checked:border-ring has-checked:bg-accent/50 has-disabled:opacity-50">
                <input
                  type="radio"
                  name="checkout"
                  value="in-place"
                  aria-label="Current checkout"
                  checked={choice === 'in-place'}
                  onChange={() => setChoice('in-place')}
                  disabled={snapshot.comparison.target.kind !== 'commit'}
                  className="mt-1"
                />
                <span>
                  <span className="block font-semibold">Current checkout</span>
                  <span className="mt-1 block text-muted-foreground">
                    {snapshot.comparison.target.kind === 'index'
                      ? 'Staged snapshots require a separate worktree when the checkout differs.'
                      : 'Save local changes and switch this directory. Restore it later in Settings → Worktrees.'}
                  </span>
                </span>
              </label>
            </fieldset>
          )}
          {output && (
            <pre
              aria-label="Setup output"
              className="max-h-60 overflow-auto rounded-md border bg-muted/40 p-3 font-mono text-xs whitespace-pre-wrap"
            >
              {output}
            </pre>
          )}
          {error && (
            <p role="alert" className="break-words text-destructive">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2 border-t pt-4">
            <Button variant="outline" onClick={() => setOpen(false)}>
              {error ? 'Close' : 'Cancel'}
            </Button>
            <Button onClick={() => void initialize(needsCheckout)}>
              {needsCheckout ? 'Prepare workspace' : 'Retry setup'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
