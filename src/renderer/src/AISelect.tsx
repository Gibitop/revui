import { useId, useState } from 'react'
import { Combobox } from '@base-ui/react/combobox'
import { Select } from '@base-ui/react/select'
import {
  Bot,
  Check,
  ChevronDown,
  SquareDashed,
  SignalZero,
  CircleOff,
  Minus,
  SignalLow,
  SignalMedium,
  SignalHigh,
  Signal,
  Brain,
  Sparkles,
  type LucideIcon,
} from 'lucide-react'
import type { AIProvider } from '../../shared/ai'
import codex from './assets/ai/codex_light.svg'
import opencode from './assets/ai/opencode.svg'
import openai from './assets/ai/openai.svg'
import claude from './assets/ai/claude-ai-icon.svg'
import gemini from './assets/ai/gemini.svg'
import deepseek from './assets/ai/deepseek.svg'
import qwen from './assets/ai/qwen_light.svg'
import mistral from './assets/ai/mistral-ai_logo.svg'
import grok from './assets/ai/grok-light.svg'
import meta from './assets/ai/meta.svg'
import kimi from './assets/ai/kimi-icon.svg'

import cohere from './assets/ai/cohere.svg'
import perplexity from './assets/ai/perplexity.svg'
import nvidia from './assets/ai/nvidia-icon-light.svg'
import minimax from './assets/ai/lobe/minimax-color.svg'
import zai from './assets/ai/lobe/zai.svg'
import mimo from './assets/ai/lobe/xiaomimimo.svg'
import longcat from './assets/ai/lobe/longcat.svg'
import antgroup from './assets/ai/lobe/antgroup-color.svg'
import stepfun from './assets/ai/lobe/stepfun-color.svg'
import doubao from './assets/ai/lobe/doubao-color.svg'
import bytedance from './assets/ai/lobe/bytedance-color.svg'
import hunyuan from './assets/ai/lobe/hunyuan-color.svg'
import nova from './assets/ai/lobe/nova-color.svg'
import baidu from './assets/ai/lobe/baidu-color.svg'

const modelIcons: [RegExp, string, boolean][] = [
  [/\b(gpt|chatgpt|openai|o[134](?:\b|[-_]))/i, openai, true],
  [/\b(claude|anthropic)/i, claude, false],
  [/\b(gemini|gemma)/i, gemini, false],
  [/\bdeepseek/i, deepseek, false],
  [/\b(qwen|qwq)/i, qwen, true],
  [/\b(mistral|mixtral|codestral|devstral|magistral|ministral|pixtral)/i, mistral, false],
  [/\bgrok/i, grok, true],
  [/\bllama/i, meta, false],
  [/\b(kimi|moonshot)/i, kimi, false],
  [/\bmini[-\s]?max/i, minimax, false],
  [/\b(glm|chatglm|z[.-]?ai|zhipu)/i, zai, true],
  [/\b(mimo|xiaomi)/i, mimo, true],
  [/\blong[-\s]?cat/i, longcat, true],
  [/\b(ling(?=[-\s\d]|$)|antling|inclusionai|bailing)/i, antgroup, false],
  [/\b(stepfun|step[-\s]?\d)/i, stepfun, false],
  [/\bdoubao/i, doubao, false],
  [/\b(seed|seedream|bytedance)/i, bytedance, false],
  [/\bhunyuan/i, hunyuan, false],
  [/\b(ernie|baidu)/i, baidu, false],
  [/\b(nova|amazon)/i, nova, false],
  [/\b(command[-\s]|aya|cohere)/i, cohere, false],
  [/\b(sonar|perplexity)/i, perplexity, true],
  [/\b(nemotron|nvidia)/i, nvidia, true],
]

export function AIIcon({
  provider,
  model,
  className = 'size-4',
}: {
  provider: AIProvider
  model?: string
  className?: string
}) {
  const match = model ? modelIcons.find(([pattern]) => pattern.test(model)) : undefined
  const src = match?.[1] ?? (provider === 'codex' ? codex : opencode)
  const monochrome = match?.[2] ?? provider === 'codex'
  return (
    <span
      aria-hidden="true"
      className={className + ' inline-flex shrink-0 items-center justify-center'}
    >
      {model && !match ? (
        <Bot className="size-full" />
      ) : monochrome ? (
        <span
          className="size-full bg-current"
          style={{
            mask: `url("${src}") center / ${src === openai ? '150%' : 'contain'} no-repeat`,
          }}
        />
      ) : (
        <img src={src} alt="" className="size-full object-contain" />
      )}
    </span>
  )
}

const reasoningIcons: Record<string, LucideIcon> = {
  '': SquareDashed,
  none: CircleOff,
  minimal: Minus,
  low: SignalZero,
  medium: SignalLow,
  high: SignalMedium,
  xhigh: SignalHigh,
  max: Signal,
  ultra: Sparkles,
}

function ReasoningIcon({ effort, label = '' }: { effort: string; label?: string }) {
  if (label.toLowerCase() === 'opencode default') return <AIIcon provider="opencode" />
  const Icon = (effort + ' ' + label).toLowerCase().includes('default')
    ? SquareDashed
    : (reasoningIcons[effort.toLowerCase()] ?? Brain)
  return (
    <span aria-hidden="true" className="inline-flex size-4 shrink-0 items-center justify-center">
      <Icon className="size-full" />
    </span>
  )
}

export function AISelect({
  label,
  ariaLabel,
  value,
  options,
  provider,
  onChange,
  disabled = false,
  searchable = false,
  reasoning = false,
}: {
  label: string
  ariaLabel: string
  value: string
  options: {
    value: string
    label: string
    provider?: AIProvider
    model?: string
    description?: string
  }[]
  provider?: AIProvider
  disabled?: boolean
  searchable?: boolean
  reasoning?: boolean
  onChange: (value: string) => void
}) {
  const id = useId()
  const [container, setContainer] = useState<HTMLDivElement | null>(null)
  const [search, setSearch] = useState('')
  const selected = options.find((option) => option.value === value)
  if (searchable) {
    const query = search.trim().toLowerCase()
    const matches = options.filter((option) =>
      (option.label + ' ' + option.value).toLowerCase().includes(query),
    )
    return (
      <div ref={setContainer} className="min-w-0 space-y-1">
        <label htmlFor={id}>{label}</label>
        <Combobox.Root
          items={matches.map((option) => option.value)}
          filter={null}
          value={value}
          inputValue={search}
          disabled={disabled}
          autoHighlight
          onInputValueChange={setSearch}
          onOpenChange={() => setSearch('')}
          onValueChange={(next) => {
            if (next !== null) onChange(next)
          }}
        >
          <Combobox.Trigger
            id={id}
            aria-label={ariaLabel}
            className="flex h-9 w-full items-center gap-2 rounded-md border bg-background px-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          >
            {provider && (
              <AIIcon provider={selected?.provider ?? provider} model={selected?.model} />
            )}
            <span className="min-w-0 flex-1 truncate">{selected?.label ?? value}</span>
            <ChevronDown aria-hidden="true" className="size-4 shrink-0" />
          </Combobox.Trigger>
          <Combobox.Portal container={container}>
            <Combobox.Positioner align="start" sideOffset={4} className="z-60">
              <Combobox.Popup
                data-model-search-popup=""
                className="flex max-h-[min(var(--available-height),360px)] min-w-[var(--anchor-width)] max-w-[var(--available-width)] flex-col overflow-hidden rounded-md border bg-background text-foreground shadow-lg outline-none"
              >
                <div className="shrink-0 border-b p-2">
                  <Combobox.Input
                    aria-label={`Search ${ariaLabel}s`}
                    placeholder="Search models…"
                    className="h-9 w-full rounded-md border bg-background px-2 outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  />
                </div>
                <Combobox.Empty className="p-3 text-muted-foreground empty:p-0">
                  No matching models.
                </Combobox.Empty>
                <Combobox.List className="min-h-0 overflow-y-auto p-1 empty:p-0">
                  {matches.map((option) => (
                    <Combobox.Item
                      key={option.value}
                      value={option.value}
                      className="flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 outline-none data-highlighted:bg-accent"
                    >
                      {provider && (
                        <AIIcon provider={option.provider ?? provider} model={option.model} />
                      )}
                      <span className="min-w-0 flex-1 wrap-anywhere">{option.label}</span>
                      <Combobox.ItemIndicator>
                        <Check aria-hidden="true" className="size-4" />
                      </Combobox.ItemIndicator>
                    </Combobox.Item>
                  ))}
                </Combobox.List>
              </Combobox.Popup>
            </Combobox.Positioner>
          </Combobox.Portal>
        </Combobox.Root>
      </div>
    )
  }
  return (
    <div ref={setContainer} className="min-w-0 space-y-1">
      <label htmlFor={id}>{label}</label>
      <Select.Root
        value={value}
        disabled={disabled}
        items={options}
        onValueChange={(next) => {
          if (next !== null) onChange(next)
        }}
      >
        <Select.Trigger
          id={id}
          aria-label={ariaLabel}
          className="flex h-9 w-full items-center gap-2 rounded-md border bg-background px-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
        >
          {provider && <AIIcon provider={selected?.provider ?? provider} model={selected?.model} />}
          {reasoning && <ReasoningIcon effort={value} label={selected?.label} />}
          <Select.Value className="min-w-0 flex-1 truncate">
            {selected?.label ?? value}
          </Select.Value>
          <Select.Icon>
            <ChevronDown aria-hidden="true" className="size-4 shrink-0" />
          </Select.Icon>
        </Select.Trigger>
        <Select.Portal container={container}>
          <Select.Positioner
            align="start"
            alignItemWithTrigger={false}
            sideOffset={4}
            className="z-60"
          >
            <Select.Popup className="max-h-[min(var(--available-height),320px)] min-w-[var(--anchor-width)] max-w-[min(var(--available-width),480px)] overflow-y-auto rounded-md border bg-background p-1 text-foreground shadow-lg outline-none">
              <Select.List>
                {options.map((option) => (
                  <Select.Item
                    key={option.value}
                    value={option.value}
                    label={option.label}
                    title={option.description}
                    className="flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 outline-none data-disabled:opacity-50 data-highlighted:bg-accent"
                  >
                    {provider && (
                      <AIIcon provider={option.provider ?? provider} model={option.model} />
                    )}
                    {reasoning && <ReasoningIcon effort={option.value} label={option.label} />}
                    <Select.ItemText className="min-w-0 flex-1 wrap-anywhere">
                      {option.label}
                    </Select.ItemText>
                    <Select.ItemIndicator>
                      <Check aria-hidden="true" className="size-4" />
                    </Select.ItemIndicator>
                  </Select.Item>
                ))}
              </Select.List>
            </Select.Popup>
          </Select.Positioner>
        </Select.Portal>
      </Select.Root>
    </div>
  )
}
