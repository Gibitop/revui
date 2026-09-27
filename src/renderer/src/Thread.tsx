import { useAIReview } from './AIReview'
import { ExternalLink } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useMemo, useState } from 'react'
import type { LocalThread, ReviewAction, ReviewRecord } from '../../shared/review'
import { CommentComposer } from './CommentComposer'
import { ThreadView } from './ThreadView'
import { useGitLab } from './GitLab'

export function Thread({
  thread,
  mutate,
  pending,
  current = false,
  sourceContents,
  inOverlay = false,
  onNavigate,
}: {
  thread: LocalThread
  mutate: (action: ReviewAction) => Promise<ReviewRecord>
  pending: boolean
  current?: boolean
  sourceContents?: string
  inOverlay?: boolean
  onNavigate?: () => void
}) {
  const ai = useAIReview()
  const gitlab = useGitLab()
  const [reply, setReply] = useState('')
  const [error, setError] = useState('')
  const review = gitlab?.review
  const suggestionSource = useMemo(
    () =>
      current && sourceContents !== undefined
        ? { contents: sourceContents, line: thread.end }
        : undefined,
    [current, sourceContents, thread.end],
  )
  const suggestion = useMemo(
    () =>
      suggestionSource?.contents
        .split('\n')
        .slice(thread.start - 1, thread.end)
        .join('\n'),
    [suggestionSource, thread.start, thread.end],
  )

  return (
    <ThreadView
      source="Local"
      suggestionSource={suggestionSource}
      label={`Thread at ${thread.side} line ${thread.start}`}
      messages={thread.messages.map((message) => ({
        id: message.id,
        body: message.body,
        date: message.createdAt,
        editable: true,
        author: (
          <span className="inline-flex min-w-0 items-center gap-2 align-middle">
            <span
              aria-hidden="true"
              className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-medium text-muted-foreground ring-1 ring-border"
            >
              {message.author === 'AI' ? 'AI' : 'Y'}
            </span>
            <span className="text-foreground">{message.author ?? 'You'}</span>
          </span>
        ),
      }))}
      onAttach={ai ? () => ai.attach({ thread: thread.id }) : undefined}
      details={
        <>
          {inOverlay ? (
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span className="break-all font-mono">
                {thread.path}:{thread.start}
                {thread.end !== thread.start ? `–${thread.end}` : ''}
              </span>
              {!current && <span>Outdated / unplaced</span>}
              {onNavigate && (
                <Button variant="ghost" className="h-6 gap-1 px-2 text-xs" onClick={onNavigate}>
                  <ExternalLink className="size-3.5" />
                  View in diff
                </Button>
              )}
            </div>
          ) : undefined}
        </>
      }
      loadSuggestion={
        suggestion !== undefined
          ? async () => ({ contents: suggestion, before: thread.end - thread.start })
          : undefined
      }
      pending={pending}
      resolved={thread.resolved}
      error={error}
      onEdit={(id, body) => mutate({ kind: 'edit-comment', thread: thread.id, message: id, body })}
      onDelete={(id) => mutate({ kind: 'delete-comment', thread: thread.id, message: id })}
      onResolve={() => mutate({ kind: 'resolve', thread: thread.id, resolved: !thread.resolved })}
      onUpload={review ? (id) => gitlab!.uploadLocal(thread, id) : undefined}
      uploadDisabledReason={
        !review?.aligned
          ? 'Open the matching MR comparison before publishing.'
          : !current
            ? 'The comment location must match the current file before publishing.'
            : undefined
      }
      reply={(close) => (
        <CommentComposer
          body={reply}
          onChange={setReply}
          label="Reply"
          busy={pending || !!gitlab?.busy}
          onPost={() => {
            setError('')
            void mutate({ kind: 'reply', thread: thread.id, body: reply })
              .then(() => {
                setReply('')
                close()
              })
              .catch((error: Error) => setError(error.message))
          }}
          onCancel={() => {
            setReply('')
            close()
          }}
        />
      )}
    />
  )
}
