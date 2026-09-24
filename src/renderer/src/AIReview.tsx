import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Bot,
  Zap,
  X,
  Square,
  Paperclip,
  LoaderCircle,
  FileSearch,
  Plus,
  ArrowUp,
  MessageSquare,
  Pencil,
  Copy,
  Check,
} from 'lucide-react'
import Markdown, { defaultUrlTransform } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { chatFileReferences } from './chatFiles'
import {
  chatPermissions,
  type ChatPermission,
  type AIAttachment,
  type AIRequest,
  type AIState,
} from '../../shared/ai'
import type { Snapshot } from '../../shared/review'
import type { Settings, PreferencesPatch } from '../../shared/desktop'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'

const AIContext = createContext<{
  state?: AIState
  error: string
  openFile: (path: string, line?: number) => void
  files: ReturnType<typeof chatFileReferences>
  attach: (attachment: AIAttachment) => void
  run: (request: AIRequest) => Promise<AIState | undefined>
} | null>(null)
export const useAIReview = () => useContext(AIContext)

type AIWorkspace = { ready: boolean; busy: boolean; initialize: () => void }

export function AIReviewProvider({
  workspace,
  snapshot,
  open,
  onOpen,
  onState,
  onFile,
  settings,
  preferences,
  children,
}: {
  workspace: AIWorkspace
  snapshot?: Snapshot
  onFile: (path: string, line?: number) => void
  settings: Settings
  preferences: (patch: PreferencesPatch) => void
  open: boolean
  onOpen: (open: boolean) => void
  onState: (state: AIState | undefined) => void
  children: ReactNode
}) {
  const files = useMemo(() => chatFileReferences(snapshot), [snapshot])
  const [state, setState] = useState<AIState>()
  const [error, setError] = useState('')
  const [reviewNotification, setReviewNotification] = useState<{
    completed: string
    count: number
  }>()
  useEffect(() => {
    if (!reviewNotification) return
    const timer = setTimeout(() => setReviewNotification(undefined), 8000)
    return () => clearTimeout(timer)
  }, [reviewNotification])
  const [orderNotification, setOrderNotification] = useState<number>()
  const previousOrder = useRef<{ snapshot: string; key: string | null }>(undefined)
  useEffect(() => {
    if (orderNotification === undefined) return
    const timer = setTimeout(() => setOrderNotification(undefined), 8000)
    return () => clearTimeout(timer)
  }, [orderNotification])
  const [chatAttachments, setChatAttachments] = useState<Record<string, AIAttachment[]>>({})
  const chatId = state?.record.chatId ?? ''
  const attachments = chatAttachments[chatId] ?? []
  const setAttachments = (items: AIAttachment[]) =>
    setChatAttachments((current) => ({ ...current, [chatId]: items }))
  const queryClient = useQueryClient()
  const id = snapshot?.id
  const active = useRef(id)
  const activeChat = useRef<string>(undefined)
  const findingsKey = useRef('')
  const completedReview = useRef('')
  const receive = useCallback(
    (value: AIState) => {
      if (active.current !== value.snapshot) return
      activeChat.current = value.record.chatId
      setState(value)
      if (
        previousOrder.current?.snapshot === value.snapshot &&
        previousOrder.current.key !== value.record.walkthroughKey &&
        value.record.walkthroughKey &&
        !value.order.running &&
        !value.order.error
      )
        setOrderNotification(value.record.walkthrough.length)
      previousOrder.current = { snapshot: value.snapshot, key: value.record.walkthroughKey }
      const completed = `${value.snapshot}:${value.review.completed}`
      if (completedReview.current !== completed) {
        if (
          completedReview.current.startsWith(`${value.snapshot}:`) &&
          value.review.completed > 0 &&
          !value.review.running &&
          !value.review.error
        )
          setReviewNotification({ completed, count: value.review.comments })
        completedReview.current = completed
        void queryClient.invalidateQueries({ queryKey: ['review-record', value.snapshot] })
      }
      const key = JSON.stringify([
        value.snapshot,
        value.record.stale,
        value.record.findings,
        value.order,
        value.record.walkthroughKey,
        value.record.walkthrough,
      ])
      if (findingsKey.current !== key) {
        findingsKey.current = key
        onState(value)
      }
    },
    [onState, queryClient],
  )
  useEffect(() => {
    active.current = id
    setState(undefined)
    setReviewNotification(undefined)
    setOrderNotification(undefined)
    previousOrder.current = undefined
    completedReview.current = ''
    setError('')
    setChatAttachments({})
    onState(undefined)
    findingsKey.current = ''
    if (!id) return
    let current = true
    const update = (value: AIState) => {
      if (current && value.snapshot === id) {
        receive(value)
      }
    }
    const off = window.desktop.onAIChanged(update)
    void window.desktop
      .ai({ kind: 'get', snapshot: id })
      .then(update)
      .catch((error) => {
        if (current) setError(error.message)
      })
    return () => {
      current = false
      active.current = undefined
      off()
    }
  }, [id, onState, receive])
  const run = async (request: AIRequest) => {
    setError('')
    if (request.kind === 'walkthrough' && state)
      setState({
        ...state,
        record: {
          ...state.record,
          walkthrough: state.record.walkthrough.map((group) =>
            group.id === request.id ? { ...group, done: request.done } : group,
          ),
        },
      })
    try {
      const value = await window.desktop.ai(request)
      if (active.current !== id) return undefined
      if (value.snapshot === id) {
        receive(value)
      }
      if (request.kind === 'finding')
        await queryClient.invalidateQueries({ queryKey: ['review-record', id] })
      return value
    } catch (error) {
      if (
        active.current === id &&
        (!('chatId' in request) || !request.chatId || request.chatId === activeChat.current)
      ) {
        setError((error as Error).message)
      }
      return undefined
    }
  }
  return (
    <AIContext.Provider
      value={{
        state,
        error,
        run,
        files,
        openFile: onFile,
        attach: (attachment) => {
          setAttachments([...attachments, attachment])
          onOpen(true)
        },
      }}
    >
      {children}
      <div className="fixed right-5 bottom-5 z-50 flex max-w-sm flex-col gap-3">
        {reviewNotification && (
          <div
            data-testid="ai-review-notification"
            className="flex items-start gap-3 rounded-lg border bg-background p-4 shadow-lg"
          >
            <Check aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-git-added" />
            <div role="status" aria-live="polite" aria-atomic="true" className="min-w-0 flex-1">
              <p className="font-semibold">AI review complete</p>
              <p className="mt-1 text-sm text-muted-foreground">
                {reviewNotification.count === 0
                  ? 'No new issues found.'
                  : `${reviewNotification.count} new ${reviewNotification.count === 1 ? 'issue' : 'issues'} found.`}
              </p>
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="-mt-1 -mr-1 size-7 shrink-0"
              aria-label="Dismiss review notification"
              onClick={() => setReviewNotification(undefined)}
            >
              <X className="size-4" />
            </Button>
          </div>
        )}
        {orderNotification !== undefined && (
          <div
            data-testid="ai-order-notification"
            className="flex items-start gap-3 rounded-lg border bg-background p-4 shadow-lg"
          >
            <Check aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-git-added" />
            <div role="status" aria-live="polite" aria-atomic="true" className="min-w-0 flex-1">
              <p className="font-semibold">AI review order ready</p>
              <p className="mt-1 text-sm text-muted-foreground">
                {orderNotification} review {orderNotification === 1 ? 'step' : 'steps'} prepared.
              </p>
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="-mt-1 -mr-1 size-7 shrink-0"
              aria-label="Dismiss review order notification"
              onClick={() => setOrderNotification(undefined)}
            >
              <X className="size-4" />
            </Button>
          </div>
        )}
      </div>
      {open && id && (
        <AIReviewPanel
          workspace={workspace}
          key={id}
          snapshot={id}
          settings={settings}
          preferences={preferences}
          error={error}
          attachments={attachments}
          setAttachments={setAttachments}
          onClose={() => onOpen(false)}
        />
      )}
    </AIContext.Provider>
  )
}

export function AIReviewButton({ open, onClick }: { open: boolean; onClick: () => void }) {
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label="Codex review"
      aria-pressed={open}
      onClick={onClick}
    >
      <Bot className="size-4" />
    </Button>
  )
}

function ChatAttachment({
  attachment,
  snapshot,
  onRemove,
}: {
  attachment: AIAttachment
  snapshot: string
  onRemove?: () => void
}) {
  const ai = useAIReview()!
  const records = useQuery({
    queryKey: ['review-record', snapshot],
    queryFn: () => window.desktop.getReviewRecord(snapshot),
    enabled: 'thread' in attachment,
    retry: false,
  })
  const thread =
    'thread' in attachment
      ? records.data?.threads.find((thread) => thread.id === attachment.thread)
      : undefined
  const file = thread ?? ('path' in attachment ? attachment : undefined)
  const label = file
    ? `${file.path}${file.start ? `:${file.start}${file.end && file.end !== file.start ? `–${file.end}` : ''}` : ''}`
    : 'label' in attachment
      ? attachment.label
      : records.isPending
        ? 'Loading thread…'
        : 'Thread unavailable'
  const first = thread?.messages[0]
  const excerpt = first?.body.replace(/\s+/g, ' ').trim()
  const Icon = 'thread' in attachment ? MessageSquare : Paperclip
  return (
    <div
      data-testid="chat-attachment"
      className="not-prose flex min-w-0 items-start gap-2 rounded-lg border bg-muted/40 px-2.5 py-2 text-xs"
    >
      <Icon aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        {file ? (
          <button
            type="button"
            title={label}
            className="block max-w-full truncate text-left font-medium hover:underline"
            onClick={() => ai.openFile(file.path, file.start)}
          >
            {label}
          </button>
        ) : (
          <span className="block truncate font-medium" title={label}>
            {label}
          </span>
        )}
        {thread && (
          <>
            <p className="mt-1 line-clamp-2 break-words text-foreground" title={excerpt}>
              {excerpt || 'Empty discussion'}
            </p>
            <p className="mt-1 text-muted-foreground">
              {first?.author ?? 'You'} · {thread.messages.length - 1}{' '}
              {thread.messages.length === 2 ? 'reply' : 'replies'}
              {thread.resolved ? ' · Resolved' : ''}
            </p>
          </>
        )}
      </div>
      {onRemove && (
        <button
          type="button"
          className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          aria-label="Remove attachment"
          title="Remove attachment"
          onClick={onRemove}
        >
          <X className="size-3.5" />
        </button>
      )}
    </div>
  )
}

function AIReviewPanel({
  workspace,
  snapshot,
  error,
  attachments,
  setAttachments,
  onClose,
  settings,
  preferences,
}: {
  workspace: AIWorkspace
  settings: Settings
  preferences: (patch: PreferencesPatch) => void
  snapshot: string
  error: string
  attachments: AIAttachment[]
  setAttachments: (items: AIAttachment[]) => void
  onClose: () => void
}) {
  const ai = useAIReview()!
  const chatId = ai.state?.record.chatId ?? ''
  const [edits, setEdits] = useState<Record<string, { id: string; text: string } | undefined>>({})
  const edit = edits[chatId]
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const text = drafts[chatId] ?? ''
  const setText = (value: string | ((current: string) => string)) =>
    setDrafts((current) => ({
      ...current,
      [chatId]: typeof value === 'function' ? value(current[chatId] ?? '') : value,
    }))
  const transcriptRef = useRef<HTMLDivElement>(null)
  const composerRef = useRef<HTMLTextAreaElement>(null)
  const followReply = useRef(true)
  const [copiedMessage, setCopiedMessage] = useState('')
  const [copyError, setCopyError] = useState('')
  useEffect(() => {
    if (!copiedMessage) return
    const timer = setTimeout(() => setCopiedMessage(''), 2000)
    return () => clearTimeout(timer)
  }, [copiedMessage])
  const [changingChat, setChangingChat] = useState(false)
  const [changingPermission, setChangingPermission] = useState(false)
  const [approvalPending, setApprovalPending] = useState<string>()
  const [sending, setSending] = useState<Record<string, boolean>>({})
  const [width, setWidth] = useState(settings.aiPanelWidth)
  const panelRef = useRef<HTMLElement>(null)
  const dividerRef = useRef<HTMLDivElement>(null)
  const pendingWidth = useRef(width)
  const resizeFrame = useRef<number | null>(null)
  const applyWidth = (next: number) => {
    if (panelRef.current) panelRef.current.style.width = `${next}px`
    dividerRef.current?.setAttribute('aria-valuenow', String(next))
  }
  useEffect(
    () => () => {
      if (resizeFrame.current !== null) cancelAnimationFrame(resizeFrame.current)
    },
    [],
  )
  const sendingRef = useRef(new Set<string>())
  const state = ai.state
  const busy = !!sending[chatId] || !!state?.chats[chatId]?.running
  const needsWorkspace = !workspace.ready && !!state && state.record.permission !== 'read-only'
  const lastUser = state?.record.messages.filter((message) => message.role === 'user').at(-1)
  const saveEdit = async () => {
    if (!edit?.text.trim() || sendingRef.current.has(chatId) || needsWorkspace) return
    sendingRef.current.add(chatId)
    setSending((current) => ({ ...current, [chatId]: true }))
    const result = await ai.run({
      kind: 'send',
      snapshot,
      chatId,
      editMessage: edit.id,
      workspace: null,
      mode: 'chat',
      text: edit.text,
      attachments: [],
    })
    if (result) setEdits((current) => ({ ...current, [chatId]: undefined }))
    sendingRef.current.delete(chatId)
    setSending((current) => ({ ...current, [chatId]: false }))
  }
  const chats = state
    ? [
        ...state.record.otherChats,
        {
          id: state.record.chatId,
          created: state.record.chatCreated,
          messages: state.record.messages,
        },
      ].sort((a, b) => a.created - b.created)
    : []
  const changeChat = async (request: AIRequest) => {
    setChangingChat(true)
    await ai.run(request)
    setChangingChat(false)
    composerRef.current?.focus()
  }
  useEffect(() => {
    followReply.current = true
    if (transcriptRef.current) transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight
  }, [chatId])
  useEffect(() => {
    if (followReply.current && transcriptRef.current)
      transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight
  }, [state?.record.messages, busy])
  const send = async () => {
    if (
      sendingRef.current.has(chatId) ||
      changingChat ||
      changingPermission ||
      needsWorkspace ||
      state?.chats[chatId]?.running ||
      !state ||
      !text.trim() ||
      !!edit
    )
      return
    followReply.current = true
    sendingRef.current.add(chatId)
    setSending((current) => ({ ...current, [chatId]: true }))
    const result = await ai.run({
      kind: 'send',
      chatId,
      snapshot,
      workspace: null,
      mode: 'chat',
      text,
      attachments,
    })
    if (result) {
      setText((current) => (current === text ? '' : current))
      setAttachments([])
    }
    sendingRef.current.delete(chatId)
    setSending((current) => ({ ...current, [chatId]: false }))
  }
  return (
    <>
      <div
        ref={dividerRef}
        role="separator"
        aria-label="Resize AI panel"
        aria-orientation="vertical"
        aria-valuemin={380}
        aria-valuemax={800}
        aria-valuenow={width}
        tabIndex={0}
        className="z-20 -mx-0.75 w-1.75 shrink-0 touch-none cursor-col-resize bg-[linear-gradient(to_right,transparent_3px,var(--border)_3px,var(--border)_4px,transparent_4px)] hover:bg-[linear-gradient(to_right,transparent_2.5px,var(--ring)_2.5px,var(--ring)_4.5px,transparent_4.5px)] focus-visible:bg-[linear-gradient(to_right,transparent_2.5px,var(--ring)_2.5px,var(--ring)_4.5px,transparent_4.5px)] focus-visible:outline-none"
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId)
          event.preventDefault()
        }}
        onPointerMove={(event) => {
          if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
          pendingWidth.current = Math.round(
            Math.max(
              380,
              Math.min(800, window.innerWidth * 0.5, window.innerWidth - event.clientX),
            ),
          )
          // Update geometry once per frame without rerendering Markdown on every pointer move.
          if (resizeFrame.current === null)
            resizeFrame.current = requestAnimationFrame(() => {
              resizeFrame.current = null
              applyWidth(pendingWidth.current)
            })
        }}
        onPointerUp={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId)
            if (resizeFrame.current !== null) cancelAnimationFrame(resizeFrame.current)
            resizeFrame.current = null
            const next = Math.round(
              Math.max(
                380,
                Math.min(800, window.innerWidth * 0.5, window.innerWidth - event.clientX),
              ),
            )
            applyWidth(next)
            setWidth(next)
            preferences({ aiPanelWidth: next })
          }
        }}
        onPointerCancel={() => {
          if (resizeFrame.current !== null) cancelAnimationFrame(resizeFrame.current)
          resizeFrame.current = null
          applyWidth(width)
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
            event.preventDefault()
            const next = Math.max(
              380,
              Math.min(
                800,
                window.innerWidth * 0.5,
                width + (event.key === 'ArrowLeft' ? 20 : -20),
              ),
            )
            setWidth(next)
            preferences({ aiPanelWidth: next })
          }
        }}
      />
      <aside
        ref={panelRef}
        style={{ width }}
        aria-label="Codex review panel"
        className="flex h-full min-w-[380px] max-w-[50vw] shrink-0 flex-col border-l bg-surface"
      >
        <div className="flex items-center gap-2 border-b p-2">
          <strong>Codex</strong>
          <Button
            className="ml-1"
            variant="ghost"
            disabled={!state || state.review.running}
            aria-busy={state?.review.running ?? false}
            onClick={() => void ai.run({ kind: 'review', snapshot })}
          >
            {state?.review.running ? (
              <LoaderCircle className="size-4 motion-safe:animate-spin" aria-hidden="true" />
            ) : (
              <FileSearch className="size-4" aria-hidden="true" />
            )}
            {state?.review.running ? 'Reviewing…' : 'Review changes'}
          </Button>
          {state?.review.running && (
            <Button
              variant="ghost"
              size="icon"
              aria-label="Cancel review"
              title="Cancel review"
              onClick={() => void ai.run({ kind: 'cancel-review', snapshot })}
            >
              <Square className="size-4" aria-hidden="true" />
            </Button>
          )}
          <span className="flex-1" />
          <Button variant="ghost" size="icon" aria-label="Close Codex" onClick={onClose}>
            <X className="size-4" />
          </Button>
        </div>
        <div className="flex items-center border-b bg-muted/30 px-2" aria-label="Chat controls">
          <div
            role="tablist"
            aria-label="Chats"
            className="flex min-w-0 flex-1 gap-1 overflow-x-auto py-1.5"
          >
            {chats.map((chat) => {
              const title =
                chat.messages.find((message) => message.role === 'user')?.text.split('\n')[0] ||
                'New chat'
              const selected = chat.id === chatId
              return (
                <div
                  key={chat.id}
                  className={`flex shrink-0 items-center rounded-md ${selected ? 'bg-background shadow-sm' : 'text-muted-foreground'}`}
                >
                  <button
                    role="tab"
                    id={`chat-tab-${chat.id}`}
                    aria-selected={selected}
                    tabIndex={selected ? 0 : -1}
                    aria-controls="chat-transcript"
                    title={title}
                    disabled={changingChat}
                    className="max-w-36 truncate rounded-md px-2 py-2 text-xs disabled:opacity-60"
                    onClick={() => void changeChat({ kind: 'select-chat', snapshot, id: chat.id })}
                    onKeyDown={(event) => {
                      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
                      event.preventDefault()
                      const index = chats.findIndex((item) => item.id === chat.id)
                      const next =
                        chats[
                          event.key === 'Home'
                            ? 0
                            : event.key === 'End'
                              ? chats.length - 1
                              : (index + (event.key === 'ArrowRight' ? 1 : -1) + chats.length) %
                                chats.length
                        ]
                      void changeChat({ kind: 'select-chat', snapshot, id: next.id }).then(() =>
                        document.getElementById(`chat-tab-${next.id}`)?.focus(),
                      )
                    }}
                  >
                    {state?.chats[chat.id]?.running && (
                      <LoaderCircle
                        aria-hidden="true"
                        className="mr-1 inline size-3 motion-safe:animate-spin"
                      />
                    )}
                    {!!state?.chats[chat.id]?.approvals && (
                      <span aria-label="Needs approval" className="mr-1">
                        ?
                      </span>
                    )}
                    {state?.chats[chat.id]?.error && (
                      <span aria-label="Chat error" className="mr-1">
                        !
                      </span>
                    )}
                    {title}
                  </button>
                  <button
                    aria-label={`Close chat: ${title}`}
                    title="Close chat"
                    disabled={changingChat}
                    className="mr-1 rounded p-1 hover:bg-muted disabled:opacity-40"
                    onClick={() => void changeChat({ kind: 'close-chat', snapshot, id: chat.id })}
                  >
                    <X className="size-3" />
                  </button>
                </div>
              )
            })}
          </div>
          <Button
            variant="ghost"
            size="icon"
            aria-label="New chat"
            title="New chat"
            disabled={!state || changingChat}
            onClick={() => void changeChat({ kind: 'new-chat', snapshot })}
          >
            <Plus className="size-4" />
          </Button>
        </div>
        {state?.review.error && (
          <p role="alert" className="border-b p-3">
            {state.review.error}
          </p>
        )}
        {(error || state?.error) && (
          <p role="alert" className="border-b p-3">
            {error || state?.error}
          </p>
        )}
        {state?.record.stale && (
          <p role="status" className="border-b p-3">
            The comparison changed. New messages use the current comparison; previous chat remains
            available.
          </p>
        )}
        {state?.approvals.map((approval) => (
          <div
            key={approval.id}
            role="alertdialog"
            aria-label="Codex approval"
            className="space-y-2 border-b p-3"
          >
            <p className="font-medium">Approval needed</p>
            <pre className="max-h-48 overflow-auto rounded bg-muted p-2 text-xs whitespace-pre-wrap wrap-anywhere">
              {approval.command}
            </pre>
            {approval.cwd && (
              <p className="text-xs text-muted-foreground wrap-anywhere">{approval.cwd}</p>
            )}
            {approval.reason && <p className="text-sm">{approval.reason}</p>}
            <div className="flex justify-end gap-2">
              {[false, true].map((allow) => (
                <Button
                  key={String(allow)}
                  variant={allow ? 'default' : 'outline'}
                  disabled={approvalPending === approval.id}
                  onClick={() => {
                    setApprovalPending(approval.id)
                    void ai
                      .run({ kind: 'approval', snapshot, chatId, id: approval.id, allow })
                      .finally(() => setApprovalPending(undefined))
                  }}
                >
                  {allow ? 'Allow' : 'Deny'}
                </Button>
              ))}
            </div>
          </div>
        ))}
        <div
          ref={transcriptRef}
          id="chat-transcript"
          role="tabpanel"
          aria-labelledby={chatId ? `chat-tab-${chatId}` : undefined}
          className="min-h-0 flex-1 overflow-auto p-4"
          onScroll={(event) => {
            const element = event.currentTarget
            followReply.current =
              element.scrollHeight - element.scrollTop - element.clientHeight < 64
          }}
        >
          {!state && (
            <div role="status" className="flex items-center gap-2 text-muted-foreground">
              <LoaderCircle className="size-4 animate-spin" />
              Loading chats…
            </div>
          )}
          <div className="space-y-5">
            {state?.record.messages.map((message) => {
              if (message.role === 'tool') return null
              const content = (
                <div className="prose-review">
                  <Markdown
                    urlTransform={(url) => (ai.files.resolve(url) ? url : defaultUrlTransform(url))}
                    remarkPlugins={
                      message.role === 'assistant' ? [remarkGfm, ai.files.plugin] : [remarkGfm]
                    }
                    components={{
                      pre: ({ children }) => <pre tabIndex={0}>{children}</pre>,
                      table: ({ children }) => (
                        <div
                          className="chat-table"
                          role="region"
                          aria-label="Response table"
                          tabIndex={0}
                        >
                          <table>{children}</table>
                        </div>
                      ),
                      img: ({ alt }) => <span>{alt}</span>,
                      a: ({ href, children }) => {
                        const reference = href?.startsWith('#review-file=') ? href.slice(13) : href
                        const file = reference ? ai.files.resolve(reference) : undefined
                        if (file)
                          return (
                            <a
                              href={`#file-${encodeURIComponent(file.path)}`}
                              title={`Open ${file.path}${file.line ? `:${file.line}` : ''}`}
                              className="cursor-pointer text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary"
                              onClick={(event) => {
                                event.preventDefault()
                                ai.openFile(file.path, file.line)
                              }}
                            >
                              {children}
                            </a>
                          )
                        if (!href || !/^https?:\/\//i.test(href)) return <span>{children}</span>
                        return (
                          <a
                            href={href}
                            className="underline"
                            onClick={(event) => {
                              event.preventDefault()
                              void window.desktop.openWebLink(href).catch(() => undefined)
                            }}
                          >
                            {children}
                          </a>
                        )
                      },
                    }}
                  >
                    {message.role === 'user' ? (message.prompt ?? message.text) : message.text}
                  </Markdown>
                  {message.role === 'user' && !!message.attachments?.length && (
                    <div className="mt-2 space-y-2">
                      {message.attachments.map((attachment, index) => (
                        <ChatAttachment key={index} attachment={attachment} snapshot={snapshot} />
                      ))}
                    </div>
                  )}
                </div>
              )
              return (
                <div
                  key={message.id}
                  className={`min-w-0 break-words ${message.role === 'user' ? 'group/message ml-auto w-fit max-w-[90%]' : ''}`}
                  data-testid={message.role === 'user' ? 'chat-user-message' : undefined}
                >
                  {message.role === 'assistant' && (
                    <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                      <Bot className="size-3.5" />
                      Codex
                    </div>
                  )}
                  <div
                    className={
                      message.role === 'user'
                        ? `ml-auto max-w-full rounded-xl bg-muted px-3 py-2 ${edit?.id === message.id ? 'w-full' : 'w-fit'}`
                        : undefined
                    }
                  >
                    {edit?.id === message.id ? (
                      <div className="space-y-2">
                        <Textarea
                          autoFocus
                          aria-label="Edit message"
                          value={edit.text}
                          onChange={(event) =>
                            setEdits((current) => ({
                              ...current,
                              [chatId]: { id: message.id, text: event.target.value },
                            }))
                          }
                          onKeyDown={(event) => {
                            if (event.key === 'Escape')
                              setEdits((current) => ({ ...current, [chatId]: undefined }))
                            if (
                              event.key === 'Enter' &&
                              !event.shiftKey &&
                              !event.nativeEvent.isComposing &&
                              event.keyCode !== 229
                            ) {
                              event.preventDefault()
                              void saveEdit()
                            }
                          }}
                        />
                        <div className="flex justify-end gap-2">
                          <Button
                            variant="ghost"
                            disabled={!!sending[chatId]}
                            onClick={() =>
                              setEdits((current) => ({ ...current, [chatId]: undefined }))
                            }
                          >
                            Cancel edit
                          </Button>
                          <Button
                            disabled={!edit.text.trim() || !!sending[chatId] || needsWorkspace}
                            onClick={() => void saveEdit()}
                          >
                            Save & resend
                          </Button>
                        </div>
                      </div>
                    ) : (
                      content
                    )}
                  </div>
                  {copyError === message.id && (
                    <p role="alert" className="mt-1 text-xs text-muted-foreground">
                      Could not copy message. Please try again.
                    </p>
                  )}
                  {message.role === 'user' && edit?.id !== message.id && (
                    <div
                      data-testid="chat-message-actions"
                      className="chat-message-actions mt-1 flex h-8 items-center justify-end gap-1 pr-2 text-muted-foreground opacity-0 pointer-events-none transition-opacity group-hover/message:opacity-100 group-hover/message:pointer-events-auto group-focus-within/message:opacity-100 group-focus-within/message:pointer-events-auto"
                    >
                      {message.createdAt && (
                        <time
                          className="mr-2 text-xs tabular-nums"
                          dateTime={message.createdAt}
                          title={new Date(message.createdAt).toLocaleString()}
                        >
                          {new Date(message.createdAt).toLocaleTimeString([], {
                            hour: '2-digit',
                            minute: '2-digit',
                            hour12: false,
                          })}
                        </time>
                      )}
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={
                          copiedMessage === message.id ? 'Message copied' : 'Copy message'
                        }
                        title={copiedMessage === message.id ? 'Copied' : 'Copy message'}
                        onClick={() => {
                          setCopyError('')
                          void window.desktop
                            .copyText(message.prompt ?? message.text)
                            .then(() => setCopiedMessage(message.id))
                            .catch(() => setCopyError(message.id))
                        }}
                      >
                        {copiedMessage === message.id ? (
                          <Check className="size-4" />
                        ) : (
                          <Copy className="size-4" />
                        )}
                      </Button>
                      {message.id === lastUser?.id && (
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label="Edit last message"
                          title="Edit last message"
                          disabled={!!sending[chatId]}
                          onClick={() =>
                            setEdits((current) => ({
                              ...current,
                              [chatId]: { id: message.id, text: message.prompt ?? message.text },
                            }))
                          }
                        >
                          <Pencil className="size-3.5" />
                        </Button>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
            {busy && (
              <div role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
                <LoaderCircle className="size-3.5 motion-safe:animate-spin" />
                Codex is working…
              </div>
            )}
          </div>
        </div>
        <form
          className="space-y-2 border-t p-3"
          onSubmit={(event) => {
            event.preventDefault()
            void send()
          }}
        >
          {!workspace.ready && (
            <div className="rounded-md border bg-muted/30 p-3 text-xs">
              <p className="text-muted-foreground">
                {state?.record.permission && state.record.permission !== 'read-only'
                  ? 'A matching workspace is required for edits'
                  : 'AI works better with an initialized workspace'}
              </p>
              <Button
                variant="outline"
                className="mt-2 h-7 px-2 text-xs"
                disabled={workspace.busy}
                onClick={workspace.initialize}
              >
                {workspace.busy ? (
                  <LoaderCircle className="size-3 motion-safe:animate-spin" />
                ) : (
                  <Zap className="size-3" />
                )}
                Initialize workspace
              </Button>
            </div>
          )}
          {attachments.map((attachment, index) => (
            <ChatAttachment
              key={index}
              attachment={attachment}
              snapshot={snapshot}
              onRemove={() => setAttachments(attachments.filter((_, i) => i !== index))}
            />
          ))}
          <Textarea
            ref={composerRef}
            className="min-h-24 max-h-60 resize-y rounded-lg"
            aria-label="Message Codex"
            placeholder="Ask about this review…"
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (
                event.key === 'Enter' &&
                !event.shiftKey &&
                !event.nativeEvent.isComposing &&
                event.keyCode !== 229
              ) {
                event.preventDefault()
                void send()
              }
            }}
          />
          <div className="flex items-center justify-end gap-2">
            <select
              aria-label="Chat permissions"
              className="mr-auto min-w-0 max-w-48 rounded-md border bg-background px-2 py-1.5 text-xs"
              value={state?.record.permission ?? 'read-only'}
              title={
                state?.record.permission === 'full'
                  ? 'Unrestricted file and command access, without approval prompts.'
                  : state?.record.permission === 'ask'
                    ? 'Can edit the review workspace; asks before crossing sandbox boundaries.'
                    : state?.record.permission === 'auto'
                      ? 'Can edit the review workspace; Codex reviews eligible approval requests.'
                      : 'Read-only sandbox, without approval prompts.'
              }
              disabled={!state || busy || changingChat || changingPermission}
              onChange={(event) => {
                setChangingPermission(true)
                void ai
                  .run({
                    kind: 'permission',
                    snapshot,
                    chatId,
                    permission: event.target.value as ChatPermission,
                  })
                  .finally(() => setChangingPermission(false))
              }}
            >
              {Object.entries(chatPermissions).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
            <Button
              disabled={
                busy ||
                changingChat ||
                changingPermission ||
                needsWorkspace ||
                !!edit ||
                !state ||
                !text.trim()
              }
              type="submit"
            >
              <ArrowUp className="size-4" /> Send
            </Button>
            {busy && (
              <>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => void ai.run({ kind: 'cancel', snapshot, chatId })}
                >
                  <Square className="mr-1 size-3" />
                  Cancel
                </Button>
              </>
            )}
          </div>
        </form>
      </aside>
    </>
  )
}
