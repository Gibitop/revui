import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { useRef, useState, type MouseEvent, type ReactNode } from 'react'
import { Check, MessageSquare, Pencil, Trash2, Undo2, Upload, TextQuote } from 'lucide-react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { CommentDate } from './CommentDate'

type Message = { id: string; author: ReactNode; date: string; body: string; editable: boolean }
export function ThreadView({
  source,
  linkBase,
  label,
  discussionId,
  messages,
  pending,
  resolved,
  onResolve,
  onEdit,
  onDelete,
  onUpload,
  uploadDisabledReason,
  loadSuggestion,
  details,
  error,
  reply,
}: {
  source: 'Local' | 'GitLab'
  linkBase?: string
  label: string
  discussionId?: string
  messages: Message[]
  pending: boolean
  resolved: boolean
  onResolve?: () => Promise<unknown>
  onEdit: (id: string, body: string) => Promise<unknown>
  onDelete: (id: string) => Promise<unknown>
  onUpload?: (id: string) => Promise<unknown>
  uploadDisabledReason?: string
  loadSuggestion?: () => Promise<{ contents: string; before?: number }>
  details?: ReactNode
  error?: string
  reply?: (close: () => void) => ReactNode
}) {
  const [deleting, setDeleting] = useState<string>()
  const deleteTrigger = useRef<HTMLButtonElement | null>(null)
  const cancelDelete = useRef<HTMLButtonElement | null>(null)
  const [editing, setEditing] = useState<string>()
  const [body, setBody] = useState('')
  const [replying, setReplying] = useState(false)
  const [working, setWorking] = useState(false)
  const [failure, setFailure] = useState('')
  const busy = pending || working
  const run = async (action: () => Promise<unknown>) => {
    setWorking(true)
    setFailure('')
    try {
      return await action()
    } catch (error) {
      setFailure((error as Error).message)
      return false
    } finally {
      setWorking(false)
    }
  }
  return (
    <section
      data-testid={source === 'Local' ? 'local-thread' : undefined}
      data-discussion-id={discussionId}
      aria-label={label}
      className="my-2 space-y-3 rounded border bg-background p-3 font-sans text-[13px]/5 font-normal text-foreground"
    >
      <Dialog
        open={deleting !== undefined}
        onOpenChange={(open) => {
          if (!open && !working) setDeleting(undefined)
        }}
      >
        <DialogContent
          closeLabel="Cancel deletion"
          onOpenAutoFocus={(event) => {
            event.preventDefault()
            cancelDelete.current?.focus()
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            deleteTrigger.current?.focus()
          }}
        >
          <DialogTitle className="pr-6 text-base font-semibold">Delete comment?</DialogTitle>
          <DialogDescription className="mt-2 text-sm text-muted-foreground">
            This will permanently delete this comment{source === 'GitLab' ? ' from GitLab' : ''}.
          </DialogDescription>
          <blockquote className="mt-4 max-h-32 overflow-auto rounded border bg-muted/30 p-3 text-sm whitespace-pre-wrap wrap-anywhere">
            {messages.find((message) => message.id === deleting)?.body}
          </blockquote>
          {(failure || error) && (
            <p role="alert" className="mt-3 text-sm">
              {failure || error}
            </p>
          )}
          <div className="mt-4 flex justify-end gap-2">
            <Button
              ref={cancelDelete}
              variant="outline"
              disabled={working}
              onClick={() => setDeleting(undefined)}
            >
              Cancel
            </Button>
            <Button
              className="bg-red-600 text-white hover:bg-red-700"
              disabled={busy || !deleting}
              onClick={() => {
                if (deleting) {
                  const id = deleting
                  if (source === 'GitLab') setDeleting(undefined)
                  void run(() => onDelete(id)).then((result) => {
                    if (result !== false) setDeleting(undefined)
                  })
                }
              }}
            >
              {working ? 'Deleting…' : 'Delete comment'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      {(failure || error) && <p role="alert">{failure || error}</p>}
      {messages.map((message, index) => (
        <div
          key={message.id}
          data-testid="thread-message"
          className={`space-y-2 ${index < messages.length - 1 || reply ? 'border-b pb-2' : ''}`}
        >
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground">
            {index === 0 && (
              <span
                data-testid={source === 'Local' ? 'local-tag' : undefined}
                className="rounded border px-1 text-muted-foreground"
              >
                {source}
              </span>
            )}
            {index === 0 && resolved && (
              <span className="inline-flex items-center gap-1 rounded border border-green-600/25 bg-green-500/10 px-1.5 text-xs text-green-700 dark:text-green-400">
                <Check aria-hidden="true" className="size-3" />
                Resolved
              </span>
            )}
            {message.author}
            <span aria-hidden="true">·</span>
            <CommentDate date={message.date} />
            <div className="ml-auto flex shrink-0 items-center gap-1">
              {message.editable && (
                <Button
                  type="button"
                  variant="ghost"
                  className="size-7 p-0"
                  aria-label="Edit"
                  title="Edit"
                  disabled={busy || editing === message.id}
                  onClick={() => {
                    setEditing(message.id)
                    setBody(message.body)
                  }}
                >
                  <Pencil className="size-3.5" />
                </Button>
              )}
              {index === 0 && onResolve && (
                <Button
                  type="button"
                  variant="ghost"
                  className="size-7 p-0"
                  aria-label={resolved ? 'Reopen' : 'Resolve'}
                  title={resolved ? 'Reopen' : 'Resolve'}
                  disabled={busy}
                  onClick={() => void run(onResolve)}
                >
                  {resolved ? <Undo2 className="size-3.5" /> : <Check className="size-3.5" />}
                </Button>
              )}
              {onUpload && (
                <Button
                  type="button"
                  variant="ghost"
                  className="size-7 p-0"
                  aria-label="Upload to GitLab"
                  title={uploadDisabledReason || 'Upload to GitLab'}
                  disabled={busy || !!uploadDisabledReason}
                  onClick={() => void run(() => onUpload(message.id))}
                >
                  <Upload className="size-3.5" />
                </Button>
              )}
              {message.editable && (
                <Button
                  type="button"
                  variant="ghost"
                  className="size-7 p-0 hover:text-git-deleted"
                  aria-label="Delete comment"
                  title="Delete comment"
                  disabled={busy}
                  onClick={(event) => {
                    deleteTrigger.current = event.currentTarget
                    setFailure('')
                    setDeleting(message.id)
                  }}
                >
                  <Trash2 className="size-3.5" />
                </Button>
              )}
            </div>
          </div>
          {index === 0 && details}
          {editing === message.id && !(source === 'GitLab' && working) ? (
            <div className="space-y-2" data-review-editor>
              {loadSuggestion && (
                <Button
                  type="button"
                  variant="ghost"
                  className="h-7 gap-1 px-2 text-xs"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      const suggestion = await loadSuggestion()
                      setBody(
                        (current) =>
                          `${current}${current ? '\n\n' : ''}\`\`\`suggestion${suggestion.before === undefined ? '' : `:-${suggestion.before}+0`}\n${suggestion.contents}\n\`\`\``,
                      )
                    })
                  }
                >
                  <TextQuote className="size-3.5" />
                  Insert suggestion
                </Button>
              )}
              <Textarea
                disabled={busy}
                aria-label={`Edit ${source === 'Local' ? 'local' : 'GitLab'} comment`}
                value={body}
                onChange={(event) => setBody(event.target.value)}
                maxLength={100000}
              />
              <div className="flex gap-2">
                <Button
                  disabled={busy || !body.trim()}
                  onClick={() =>
                    void run(() => onEdit(message.id, body)).then((result) => {
                      if (result !== false) setEditing(undefined)
                    })
                  }
                >
                  Save edit
                </Button>
                <Button variant="ghost" disabled={busy} onClick={() => setEditing(undefined)}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <div className="markdown wrap-anywhere">
              <Markdown
                remarkPlugins={[remarkGfm]}
                skipHtml
                components={{
                  img: ({ alt }) => <span>{alt}</span>,
                  a: ({ href, children }) => {
                    let url: URL
                    try {
                      if (!href) return <span>{children}</span>
                      url = new URL(href, linkBase)
                      if (
                        !['https:', 'http:'].includes(url.protocol) ||
                        url.username ||
                        url.password
                      )
                        return <span>{children}</span>
                    } catch {
                      return <span>{children}</span>
                    }
                    const open = (event: MouseEvent<HTMLAnchorElement>) => {
                      event.preventDefault()
                      if (event.type === 'auxclick' && event.button !== 1) return
                      void window.desktop
                        .openWebLink(url.href)
                        .catch((error: Error) => setFailure(error.message))
                    }
                    return (
                      <a href={url.href} onClick={open} onAuxClick={open}>
                        {children}
                      </a>
                    )
                  },
                }}
              >
                {message.body}
              </Markdown>
            </div>
          )}
        </div>
      ))}
      {reply && (
        <details
          className="group/reply"
          open={replying}
          onToggle={(event) => setReplying(event.currentTarget.open)}
        >
          <summary className="flex cursor-pointer list-none items-center gap-2 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
            <MessageSquare className="size-4" />
            Reply
          </summary>
          {replying && <div className="mt-3">{reply(() => setReplying(false))}</div>}
        </details>
      )}
    </section>
  )
}
