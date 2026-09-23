import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { useEffect, useEffectEvent, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ArrowLeftRight, RefreshCw } from 'lucide-react'
import type { Comparison } from '../../shared/review'
import type { Repository } from '../../shared/desktop'
import { RevisionSelect } from './RevisionSelect'
import { Button } from '@/components/ui/button'
import { Tooltip } from '@/components/ui/tooltip'

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
  const [newRevision, setNewRevision] = useState(
    initial.target.kind === 'working'
      ? 'Uncommitted'
      : initial.target.kind === 'index'
        ? 'Index'
        : initial.target.ref,
  )
  const [oldRevision, setOldRevision] = useState(
    initial.base.kind === 'index'
      ? 'Index'
      : initial.base.kind === 'commit'
        ? initial.base.ref
        : 'HEAD',
  )
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
  const options = JSON.stringify(comparison)
  const previousOptions = useRef(options)
  const compare = useEffectEvent(() => onCompare(comparison))
  useEffect(() => {
    if (previousOptions.current === options) return
    previousOptions.current = options
    if (newRevision.trim() && oldRevision.trim()) compare()
  }, [options, newRevision, oldRevision])
  return (
    <div data-testid="comparison-controls" className="comparison-controls flex items-center gap-2">
      <RevisionSelect
        label="Old"
        value={oldRevision}
        onChange={setOldRevision}
        suggestions={[
          ...(newRevision === 'Uncommitted' ? [{ value: 'Index', kind: 'index' as const }] : []),
          ...(refs.data ?? [{ value: 'HEAD', kind: 'commit' as const }]),
        ]}
      />
      <Tooltip label={canSwap ? 'Swap Old and New' : 'Swapping requires two Git revisions'}>
        <span className="inline-flex shrink-0">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Swap Old and New"
            disabled={!canSwap}
            onClick={() => {
              setNewRevision(oldRevision)
              setOldRevision(newRevision)
            }}
          >
            <ArrowLeftRight />
          </Button>
        </span>
      </Tooltip>
      <RevisionSelect
        label="New"
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
      {newRevision !== 'Uncommitted' && newRevision !== 'Index' && oldRevision !== 'Index' && (
        <Label className="mx-2 flex shrink-0 items-center gap-2 whitespace-nowrap">
          <Switch
            checked={mode === 'merge-base'}
            onCheckedChange={(checked) => setMode(checked ? 'merge-base' : 'direct')}
          />
          Merge-base
          <Tooltip label="Compare the New revision with the common ancestor of Old and New. This shows changes introduced on New since the branches diverged.">
            <Button
              variant="ghost"
              type="button"
              aria-label="About merge-base"
              className="size-4.5 rounded-full border p-0"
            >
              ?
            </Button>
          </Tooltip>
        </Label>
      )}
      <Tooltip label="Fetch and refresh comparison">
        <span className="inline-flex shrink-0">
          <Button
            variant="ghost"
            size="icon"
            type="button"
            aria-label="Refresh comparison"
            aria-busy={isPending}
            disabled={isPending || !newRevision.trim() || !oldRevision.trim()}
            onClick={() => onCompare(comparison, true)}
          >
            <RefreshCw className={isPending ? 'animate-spin' : undefined} />
          </Button>
        </span>
      </Tooltip>
    </div>
  )
}
