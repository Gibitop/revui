import { Input } from '@/components/ui/input'
import { useEffect, useState } from 'react'
import { Trash2 } from 'lucide-react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { LocalThread, ReviewAction, ReviewRecord } from '../../shared/review'
import { Button } from '@/components/ui/button'
import { Tooltip } from '@/components/ui/tooltip'

export function Thread({
  thread,
  mutate,
  pending,
}: {
  thread: LocalThread
  mutate: (action: ReviewAction) => Promise<ReviewRecord>
  pending: boolean
}) {
  const [reply, setReply] = useState('')
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30000)
    return () => clearInterval(timer)
  }, [])
  return (
    <section
      data-testid="local-thread"
      className="mx-3 my-2 max-w-200 rounded-sm border bg-surface p-3 font-sans text-[13px]/5 font-normal text-foreground"
      aria-label={`Thread at ${thread.side} line ${thread.start}`}
    >
      <div className="flex items-center gap-2">
        <span data-testid="local-tag" className="rounded-sm border px-1.25 text-muted-foreground">
          Local
        </span>
        {thread.resolved && <span className="text-muted-foreground">Resolved</span>}
        <Button
          variant="ghost"
          className="ml-auto"
          disabled={pending}
          onClick={() =>
            void mutate({ kind: 'resolve', thread: thread.id, resolved: !thread.resolved }).catch(
              () => undefined,
            )
          }
        >
          {thread.resolved ? 'Reopen' : 'Resolve'}
        </Button>
      </div>
      {thread.messages.map((message) => {
        const updated = new Date(message.updatedAt ?? message.createdAt)
        const seconds = Math.max(0, Math.floor((now - updated.getTime()) / 1000))
        const unit =
          seconds < 60
            ? 'second'
            : seconds < 3600
              ? 'minute'
              : seconds < 86400
                ? 'hour'
                : seconds < 2592000
                  ? 'day'
                  : seconds < 31536000
                    ? 'month'
                    : 'year'
        const count = Math.floor(
          seconds /
            { second: 1, minute: 60, hour: 3600, day: 86400, month: 2592000, year: 31536000 }[unit],
        )
        const relative =
          seconds < 10
            ? 'just now'
            : new Intl.RelativeTimeFormat(undefined, { numeric: 'always' }).format(-count, unit)
        return (
          <div
            key={message.id}
            data-testid="thread-message"
            className="my-2 flex items-start gap-2"
          >
            <div className="min-w-0 flex-1">
              <Tooltip label={updated.toLocaleString()}>
                <time
                  data-testid="comment-date"
                  className="mb-1 inline-block text-muted-foreground"
                  tabIndex={0}
                  dateTime={updated.toISOString()}
                  aria-label={`Updated ${relative}`}
                >
                  {relative}
                </time>
              </Tooltip>
              <div className="min-w-0 flex-1 border-b py-2 whitespace-normal wrap-anywhere markdown">
                <Markdown
                  remarkPlugins={[remarkGfm]}
                  skipHtml
                  components={{ img: ({ alt }) => <span>{alt}</span> }}
                >
                  {message.body}
                </Markdown>
              </div>
            </div>
            <Button
              variant="ghost"
              type="button"
              className="h-auto shrink-0 rounded-sm p-1.25 text-muted-foreground hover:text-git-deleted"
              aria-label="Delete comment"
              title="Delete comment"
              disabled={pending}
              onClick={() =>
                void mutate({
                  kind: 'delete-comment',
                  thread: thread.id,
                  message: message.id,
                }).catch(() => undefined)
              }
            >
              <Trash2 size={14} />
            </Button>
          </div>
        )
      })}
      <form
        data-review-editor
        className="mt-2.5 flex items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          void mutate({ kind: 'reply', thread: thread.id, body: reply })
            .then(() => setReply(''))
            .catch(() => undefined)
        }}
      >
        <Input
          className="flex-1"
          aria-label="Reply"
          placeholder="Reply"
          value={reply}
          onChange={(event) => setReply(event.target.value)}
          maxLength={100000}
        />
        <Button type="submit" variant="outline" disabled={!reply.trim() || pending}>
          Reply
        </Button>
      </form>
    </section>
  )
}
