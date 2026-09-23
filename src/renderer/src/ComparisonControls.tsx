import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ArrowLeftRight } from 'lucide-react'
import type { Comparison } from '../../shared/review'
import type { Repository } from '../../shared/desktop'
import { RevisionSelect } from './RevisionSelect'
import { Button } from '@/components/ui/button'
import { Tooltip } from '@/components/ui/tooltip'

export function ComparisonControls({
  repository,
  initial,
  onCompare,
}: {
  repository: Repository
  initial: Comparison
  onCompare: (comparison: Comparison) => void
}) {
  const [from, setFrom] = useState(
    initial.target.kind === 'working'
      ? 'Uncommitted'
      : initial.target.kind === 'index'
        ? 'Index'
        : initial.target.ref,
  )
  const [to, setTo] = useState(
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
    !!from.trim() &&
    !!to.trim() &&
    !['Uncommitted', 'Index'].includes(from) &&
    !['Uncommitted', 'Index'].includes(to)
  return (
    <form
      data-testid="comparison-controls"
      className="flex items-center gap-2"
      onSubmit={(event) => {
        event.preventDefault()
        const target: Comparison['target'] =
          from === 'Uncommitted'
            ? { kind: 'working' }
            : from === 'Index'
              ? { kind: 'index' }
              : { kind: 'commit', ref: from.trim() }
        const base: Comparison['base'] =
          to === 'Index' ? { kind: 'index' } : { kind: 'commit', ref: to.trim() }
        onCompare({
          base,
          target,
          mode: base.kind === 'commit' && target.kind === 'commit' ? mode : 'direct',
        })
        void refs.refetch()
      }}
    >
      <RevisionSelect
        label="From"
        value={from}
        onChange={setFrom}
        suggestions={[
          { value: 'Uncommitted', kind: 'working' },
          { value: 'Index', kind: 'index' },
          ...(refs.data ?? [{ value: 'HEAD', kind: 'commit' as const }]),
        ]}
      />
      <Tooltip label={canSwap ? 'Swap From and To' : 'Swapping requires two Git revisions'}>
        <span className="inline-flex shrink-0">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Swap From and To"
            disabled={!canSwap}
            onClick={() => {
              setFrom(to)
              setTo(from)
            }}
          >
            <ArrowLeftRight />
          </Button>
        </span>
      </Tooltip>
      <RevisionSelect
        label="To"
        value={to}
        onChange={setTo}
        suggestions={[
          ...(from === 'Uncommitted' ? [{ value: 'Index', kind: 'index' as const }] : []),
          ...(refs.data ?? [{ value: 'HEAD', kind: 'commit' as const }]),
        ]}
      />
      {from !== 'Uncommitted' && from !== 'Index' && to !== 'Index' && (
        <Label className="flex shrink-0 items-center gap-1 whitespace-nowrap">
          <Checkbox
            checked={mode === 'merge-base'}
            onCheckedChange={(checked) => setMode(checked === true ? 'merge-base' : 'direct')}
          />
          Merge-base
          <Tooltip label="Compare the From revision with the common ancestor of From and To. This shows changes introduced on From since the branches diverged.">
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
      <Button variant="outline" type="submit">
        Compare
      </Button>
    </form>
  )
}
