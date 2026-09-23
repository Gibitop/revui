import { useId, useState } from 'react'
import type { RevisionSuggestion } from '../../shared/review'
import {
  GitBranch,
  GitCommitHorizontal,
  Tag,
  Globe,
  Files,
  FilePen,
  ChevronDown,
} from 'lucide-react'
import {
  Combobox,
  ComboboxInput,
  ComboboxTrigger,
  ComboboxContent,
  ComboboxList,
  ComboboxItem,
  ComboboxEmpty,
} from '@/components/ui/combobox'
import { Label } from '@/components/ui/label'

export function RevisionSelect({
  label,
  value,
  onChange,
  suggestions,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  suggestions: RevisionSuggestion[]
}) {
  const id = useId()
  const [filter, setFilter] = useState('')
  const matches = suggestions
    .filter((suggestion) => suggestion.value.toLowerCase().includes(filter.toLowerCase()))
    .slice(0, 50)
  return (
    <Combobox
      modal={false}
      items={matches.map((item) => item.value)}
      filter={null}
      inputValue={value}
      value={value}
      autoHighlight
      onInputValueChange={(next, details) => {
        if (details.reason === 'input-change') {
          onChange(next)
          setFilter(next)
        }
      }}
      onValueChange={(next) => {
        if (next) onChange(next)
      }}
    >
      <div className="flex w-[clamp(130px,16vw,210px)] items-center rounded-md border border-input bg-background">
        <Label htmlFor={id} className="pl-2 text-muted-foreground">
          {label}
        </Label>
        <RevisionIcon kind={suggestions.find((item) => item.value === value)?.kind ?? 'commit'} />
        <ComboboxInput
          id={id}
          required
          onFocus={(event) => {
            setFilter('')
            event.currentTarget.select()
          }}
        />
        <ComboboxTrigger
          aria-label={`Suggest ${label.toLowerCase()} revisions`}
          className="p-1.5 text-muted-foreground"
        >
          <ChevronDown size={14} />
        </ComboboxTrigger>
      </div>
      <ComboboxContent>
        <ComboboxEmpty className="p-1.5 text-muted-foreground">
          No matching suggestions
        </ComboboxEmpty>
        <ComboboxList>
          {matches.map((suggestion) => (
            <ComboboxItem
              key={suggestion.value}
              value={suggestion.value}
              aria-label={suggestion.value}
              aria-description={suggestion.kind}
            >
              <RevisionIcon kind={suggestion.kind} />
              {suggestion.value}
            </ComboboxItem>
          ))}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  )
}

function RevisionIcon({ kind }: { kind: RevisionSuggestion['kind'] }) {
  const Icon = {
    branch: GitBranch,
    commit: GitCommitHorizontal,
    tag: Tag,
    remote: Globe,
    working: FilePen,
    index: Files,
  }[kind]
  return (
    <span
      className="ml-1 inline-flex shrink-0 text-muted-foreground"
      title={kind}
      data-revision-kind={kind}
    >
      <Icon size={14} aria-label={kind} />
    </span>
  )
}
