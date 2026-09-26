import { useEffect, useState } from 'react'
import { Check, Copy, FolderGit2, FolderOpen, GitBranch, Loader2, Tag, Trash2 } from 'lucide-react'
import type { WorkspaceListing } from '../../shared/workspace'
import { Tooltip } from '@/components/ui/tooltip'
import { Button } from '@/components/ui/button'

export function WorktreeSettings({ platform }: { platform: string }) {
  const [records, setRecords] = useState<WorkspaceListing[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState<string | null>(null)
  const fileManager =
    platform === 'darwin' ? 'Finder' : platform === 'win32' ? 'Explorer' : 'file manager'
  useEffect(() => {
    let canceled = false
    let refreshing = false
    let known: WorkspaceListing[] = []
    const refresh = async () => {
      if (refreshing) return
      refreshing = true
      try {
        const records = await window.desktop.listWorkspaces()
        if (canceled) return
        const removed = known.filter((record) => !records.some((next) => next.id === record.id))
        known = records
        setRecords(records)
        for (const repository of new Set(removed.map((record) => record.repository)))
          window.dispatchEvent(new CustomEvent('workspaces-changed', { detail: { repository } }))
      } catch (error) {
        if (!canceled) setError(String(error))
      } finally {
        refreshing = false
      }
    }
    void refresh()
    window.addEventListener('focus', refresh)
    return () => {
      canceled = true
      window.removeEventListener('focus', refresh)
    }
  }, [])
  const run = async (repository: string, action: () => Promise<void>, removing?: string) => {
    setBusy(true)
    setError('')
    if (removing)
      window.dispatchEvent(
        new CustomEvent('worktree-removal', { detail: { id: removing, pending: true } }),
      )
    try {
      await action()
      window.dispatchEvent(new CustomEvent('workspaces-changed', { detail: { repository } }))
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error))
    } finally {
      try {
        setRecords(await window.desktop.listWorkspaces())
      } catch (error) {
        setError(String(error))
      }
      if (removing)
        window.dispatchEvent(
          new CustomEvent('worktree-removal', { detail: { id: removing, pending: false } }),
        )
      setBusy(false)
    }
  }
  const visible = records.filter((record) => record.phase !== 'restored')
  return (
    <>
      <div className="space-y-4">
        {visible.length === 0 && (
          <div className="rounded-lg border border-dashed p-6 text-center text-muted-foreground">
            <FolderGit2 className="mx-auto mb-3 size-6" />
            <p>No managed workspaces yet.</p>
            <p className="mt-1">
              Use the lightning bolt in the top bar to prepare a review target.
            </p>
          </div>
        )}
        {[...new Set(visible.map((record) => record.repository))].map((repository) => (
          <section key={repository} className="space-y-3" aria-label={repository}>
            <div>
              <h3 className="font-semibold">{repository.split(/[\\/]/).pop()}</h3>
              <p className="mt-1 break-all font-mono text-xs text-muted-foreground">{repository}</p>
            </div>
            {visible
              .filter((record) => record.repository === repository)
              .map((record) => (
                <section key={record.id} className="space-y-3 rounded-lg border p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      <div className="inline-flex items-center gap-1">
                        <h4 className="font-mono font-semibold" title={record.target}>
                          {record.target.slice(0, 12)}
                        </h4>
                        <Tooltip
                          label={copied === `${record.id}:revision` ? 'Copied' : 'Copy revision'}
                        >
                          <Button
                            variant="ghost"
                            size="icon"
                            className="shrink-0 text-muted-foreground"
                            aria-label="Copy revision"
                            onClick={() => {
                              setError('')
                              void window.desktop
                                .workspaceAction(record.id, 'copy-revision')
                                .then(() => setCopied(`${record.id}:revision`))
                                .catch((error) => setError(String(error)))
                            }}
                            onBlur={() => setCopied(null)}
                          >
                            {copied === `${record.id}:revision` ? (
                              <Check aria-hidden="true" />
                            ) : (
                              <Copy aria-hidden="true" />
                            )}
                          </Button>
                        </Tooltip>
                      </div>
                      {record.refs.map((ref) => (
                        <span
                          key={`${ref.kind}:${ref.name}`}
                          title={`${ref.kind === 'tag' ? 'Tag' : 'Branch'}: ${ref.name}`}
                          className="inline-flex min-w-0 max-w-full items-center gap-1.5 rounded bg-muted px-2 py-1 text-xs text-muted-foreground"
                        >
                          {ref.kind === 'tag' ? (
                            <Tag className="size-3 shrink-0" aria-hidden="true" />
                          ) : (
                            <GitBranch className="size-3 shrink-0" aria-hidden="true" />
                          )}
                          <span className="break-all">{ref.name}</span>
                        </span>
                      ))}
                      {record.kind === 'in-place' && (
                        <span className="text-xs text-muted-foreground">Current checkout</span>
                      )}
                      {record.phase !== 'ready' && (
                        <span className="rounded bg-muted px-2 py-1 text-xs capitalize">
                          {record.phase}
                        </span>
                      )}
                    </div>
                    {record.kind === 'worktree' && (
                      <Tooltip label="Remove worktree">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="-mt-1 -mr-1 shrink-0 text-muted-foreground hover:text-destructive"
                          aria-label="Remove worktree"
                          disabled={busy}
                          onClick={() =>
                            void run(
                              record.repository,
                              () => window.desktop.removeWorkspace(record.id),
                              record.id,
                            )
                          }
                        >
                          <Trash2 aria-hidden="true" />
                        </Button>
                      </Tooltip>
                    )}
                  </div>
                  <div className="flex items-start gap-1">
                    <p className="min-w-0 flex-1 break-all pt-1.5 font-mono text-xs">
                      {record.path}
                    </p>
                    <Tooltip label={copied === record.id ? 'Copied' : 'Copy path'}>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="shrink-0 text-muted-foreground"
                        aria-label="Copy path"
                        onClick={() => {
                          setError('')
                          void window.desktop
                            .workspaceAction(record.id, 'copy-path')
                            .then(() => setCopied(record.id))
                            .catch((error) => setError(String(error)))
                        }}
                        onBlur={() => setCopied(null)}
                      >
                        {copied === record.id ? (
                          <Check aria-hidden="true" />
                        ) : (
                          <Copy aria-hidden="true" />
                        )}
                      </Button>
                    </Tooltip>
                    <Tooltip label={`Open in ${fileManager}`}>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="shrink-0 text-muted-foreground"
                        aria-label={`Open in ${fileManager}`}
                        onClick={() => {
                          setError('')
                          void window.desktop
                            .workspaceAction(record.id, 'open')
                            .catch((error) => setError(String(error)))
                        }}
                      >
                        <FolderOpen aria-hidden="true" />
                      </Button>
                    </Tooltip>
                  </div>
                  {record.stash && (
                    <p className="break-all text-xs text-muted-foreground">
                      Recovery stash: {record.stash}
                    </p>
                  )}
                  {record.error && <p className="break-words text-destructive">{record.error}</p>}
                  {record.kind === 'in-place' && (
                    <div className="flex flex-wrap gap-2 border-t pt-3">
                      <Button
                        variant="outline"
                        disabled={busy}
                        onClick={() =>
                          void run(record.repository, () =>
                            window.desktop.restoreWorkspace(record.id),
                          )
                        }
                      >
                        Restore original
                      </Button>
                      <Button
                        variant="ghost"
                        disabled={busy}
                        onClick={() =>
                          void run(record.repository, () =>
                            window.desktop.acknowledgeRestoration(record.id),
                          )
                        }
                      >
                        I restored manually…
                      </Button>
                    </div>
                  )}
                </section>
              ))}
          </section>
        ))}
      </div>
      {busy && (
        <p role="status" className="mt-4 flex items-center gap-2 text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Updating workspace…
        </p>
      )}
      {error && (
        <p role="alert" className="mt-4 break-words text-destructive">
          {error}
        </p>
      )}
    </>
  )
}
