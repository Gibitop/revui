import { useId, useRef, useState } from 'react'
import type { RevisionSuggestion } from '../../shared/review'
import { GitBranch, GitCommitHorizontal, Tag, Globe, Files, FilePen, ChevronDown } from 'lucide-react'

export function RevisionSelect({ label, value, onChange, suggestions }: { label: string; value: string; onChange: (value: string) => void; suggestions: RevisionSuggestion[] }) {
  const id = useId()
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState('')
  const [active, setActive] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const matches = suggestions.filter((suggestion) => suggestion.value.toLowerCase().includes(filter.toLowerCase())).slice(0, 50)
  return <div className="revision-select" onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false) }}>
    <label htmlFor={id}>{label}</label>
    <RevisionIcon kind={suggestions.find((item) => item.value === value)?.kind ?? 'commit'} />
    <input ref={input} id={id} role="combobox" aria-autocomplete="list" aria-expanded={open} aria-controls={`${id}-options`} aria-activedescendant={open && matches[active] ? `${id}-option-${active}` : undefined} autoComplete="off" required value={value}
      onFocus={() => { setOpen(true); setFilter(''); setActive(0); input.current?.select() }}
      onChange={(event) => { onChange(event.target.value); setFilter(event.target.value); setActive(0); setOpen(true) }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') { event.preventDefault(); setOpen(false) }
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setOpen(true); setActive((value) => Math.max(0, Math.min(matches.length - 1, value + (event.key === 'ArrowDown' ? 1 : -1)))) }
        if (event.key === 'Enter' && open && matches[active]) { event.preventDefault(); onChange(matches[active].value); setOpen(false) }
      }} />
    <button type="button" aria-label={`Suggest ${label.toLowerCase()} revisions`} onClick={() => { input.current?.focus(); setFilter(''); setOpen(!open) }}><ChevronDown size={14} /></button>
    {open && <div id={`${id}-options`} role="listbox" aria-label={`${label} revisions`} className="revision-options">
      {matches.map((suggestion, index) => <button key={suggestion.value} type="button" id={`${id}-option-${index}`} role="option" aria-label={suggestion.value} aria-description={suggestion.kind} tabIndex={-1} aria-selected={active === index} onPointerDown={(event) => event.preventDefault()} onMouseEnter={() => setActive(index)} onClick={() => { onChange(suggestion.value); setOpen(false); input.current?.focus() }}><RevisionIcon kind={suggestion.kind} />{suggestion.value}</button>)}
      {!matches.length && <div className="secondary-text">Press Compare to use this ref</div>}
    </div>}
  </div>
}

function RevisionIcon({ kind }: { kind: RevisionSuggestion['kind'] }) {
  const Icon = { branch: GitBranch, commit: GitCommitHorizontal, tag: Tag, remote: Globe, working: FilePen, index: Files }[kind]
  return <span className="revision-icon" title={kind} data-revision-kind={kind}><Icon size={14} aria-label={kind} /></span>
}
