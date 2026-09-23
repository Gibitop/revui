import type { ReactNode } from 'react'
import { Minus, Plus, TextQuote } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'

export type CommentRange = { start: number; end: number; max: number }

export function CommentComposer({
  body,
  onChange,
  label,
  busy,
  range,
  headerActions,
  onRangeChange,
  suggestion,
  onPost,
  onCancel,
}: {
  body: string
  onChange: (body: string) => void
  label: string
  busy: boolean
  headerActions?: ReactNode
  range?: CommentRange
  onRangeChange?: (range: CommentRange) => void
  suggestion?: string
  onPost: () => void
  onCancel?: () => void
}) {
  return (
    <div className="space-y-2" data-review-editor>
      {range && onRangeChange && (
        <div className="flex items-center justify-between gap-3">
          <div
            className="flex flex-wrap items-center gap-2 text-muted-foreground"
            role="group"
            aria-label="Comment range"
          >
            {(['start', 'end'] as const).map((edge) => (
              <span key={edge} className="inline-flex items-center gap-1">
                {edge === 'start' ? 'From line' : 'to line'}
                <Button
                  type="button"
                  variant="ghost"
                  className="size-6 p-0"
                  aria-label={`Decrease ${edge} line`}
                  disabled={busy || range[edge] <= (edge === 'start' ? 1 : range.start)}
                  onClick={() => onRangeChange({ ...range, [edge]: range[edge] - 1 })}
                >
                  <Minus className="size-3" />
                </Button>
                <span className="min-w-5 text-center font-mono text-foreground">{range[edge]}</span>
                <Button
                  type="button"
                  variant="ghost"
                  className="size-6 p-0"
                  aria-label={`Increase ${edge} line`}
                  disabled={busy || range[edge] >= (edge === 'start' ? range.end : range.max)}
                  onClick={() => onRangeChange({ ...range, [edge]: range[edge] + 1 })}
                >
                  <Plus className="size-3" />
                </Button>
              </span>
            ))}
          </div>
          {headerActions && <div className="ml-auto shrink-0">{headerActions}</div>}
        </div>
      )}
      {suggestion !== undefined && (
        <Button
          type="button"
          variant="ghost"
          className="h-7 gap-1 px-2 text-xs"
          disabled={busy}
          onClick={() =>
            onChange(
              `${body}${body ? '\n\n' : ''}\`\`\`suggestion:-${range ? range.end - range.start : 0}+0\n${suggestion}\n\`\`\``,
            )
          }
        >
          <TextQuote className="size-3.5" />
          Insert suggestion
        </Button>
      )}
      <Textarea
        autoFocus
        aria-label={label}
        placeholder="Write a review comment"
        value={body}
        disabled={busy}
        onChange={(event) => onChange(event.target.value)}
        maxLength={100000}
      />
      <div className="flex items-center gap-2">
        <Button type="button" variant="outline" disabled={busy || !body.trim()} onClick={onPost}>
          Post now
        </Button>
        {onCancel && (
          <Button type="button" variant="ghost" disabled={busy} onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
    </div>
  )
}
