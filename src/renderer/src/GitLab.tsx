import { optimisticGitLabReview } from './gitlab-state'
import { Thread } from './Thread'
import { ThreadView } from './ThreadView'
import { CommentComposer, type CommentRange } from './CommentComposer'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import gitlabLogo from './assets/gitlab/gitlab.svg'
import { Switch } from '@/components/ui/switch'
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import {
  Copy,
  Ban,
  CircleCheck,
  CircleDashed,
  CircleMinus,
  CircleX,
  Clock3,
  Pause,
  Play,
  ArrowRight,
  Check,
  ChevronRight,
  ExternalLink,
  Eye,
  EyeOff,
  GitPullRequest,
  LoaderCircle,
  MessageSquare,
  RefreshCw,
  ShieldCheck,
  Upload,
  X,
} from 'lucide-react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type {
  Anchor,
  Discussion,
  GitLabConfig,
  GitLabRequest,
  GitLabReview,
  GitLabUser,
  MR,
} from '../../shared/gitlab'
import type { Comparison, Snapshot, LocalThread, ReviewAction } from '../../shared/review'
import { Button } from '@/components/ui/button'
import { Tooltip } from '@/components/ui/tooltip'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'

type GitLabContextValue = {
  snapshot?: Snapshot
  review?: GitLabReview
  busy: boolean
  uploadLocal: (thread: LocalThread, message: string) => Promise<boolean>
  act: (
    request: GitLabRequest,
    options?: { requirePosted: boolean; onPosted?: (discussion: string) => void },
  ) => Promise<boolean>
}
const GitLabContext = createContext<GitLabContextValue | null>(null)
export const useGitLab = () => useContext(GitLabContext)

function GitLabPerson({ user }: { user: GitLabUser }) {
  const context = useGitLab()
  const session = context?.review?.session
  const { data } = useQuery({
    queryKey: ['gitlab-avatar', session, user.id, user.avatar_url],
    enabled: !!session && !!user.avatar_url,
    staleTime: Infinity,
    retry: false,
    queryFn: () => window.desktop.gitlab({ kind: 'avatar', session: session!, user: user.id }),
  })
  const [failedImage, setFailedImage] = useState<string>()
  return (
    <span className="inline-flex min-w-0 items-center gap-2 align-middle" title={user.name}>
      <span
        className="flex size-6 shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted text-[10px] font-medium text-muted-foreground ring-1 ring-border"
        aria-hidden="true"
      >
        {data?.avatar && failedImage !== data.avatar ? (
          <img
            src={data.avatar}
            alt=""
            className="size-full object-cover"
            onError={() => setFailedImage(data.avatar!)}
          />
        ) : (
          user.name
            .trim()
            .split(/\s+/)
            .slice(0, 2)
            .map((part) => part[0])
            .join('')
            .toUpperCase()
        )}
      </span>
      <span className="truncate">{user.name}</span>
    </span>
  )
}

const pipelineStates = {
  success: {
    label: 'Passed',
    icon: CircleCheck,
    color: 'border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
  },
  failed: {
    label: 'Failed',
    icon: CircleX,
    color: 'border-red-500/25 bg-red-500/10 text-red-700 dark:text-red-400',
  },
  running: {
    label: 'Running',
    icon: LoaderCircle,
    color: 'border-blue-500/25 bg-blue-500/10 text-blue-700 dark:text-blue-400',
  },
  pending: { label: 'Pending', icon: Clock3 },
  created: { label: 'Created', icon: CircleDashed },
  preparing: { label: 'Preparing', icon: LoaderCircle },
  waiting_for_resource: { label: 'Waiting for resource', icon: Clock3 },
  waiting_for_callback: { label: 'Waiting for callback', icon: Clock3 },
  manual: { label: 'Manual action', icon: Play },
  scheduled: { label: 'Scheduled', icon: Clock3 },
  canceling: { label: 'Canceling', icon: Pause },
  canceled: {
    label: 'Canceled',
    icon: Ban,
    color: 'border-border bg-muted/50 text-muted-foreground',
  },
  skipped: {
    label: 'Skipped',
    icon: CircleMinus,
    color: 'border-border bg-muted/50 text-muted-foreground',
  },
}

export function GitLabSettings() {
  const [url, setURL] = useState('')
  const [caCertificate, setCertificate] = useState('')
  const [ignoreTls, setIgnoreTls] = useState(false)
  const token = useRef<HTMLInputElement>(null)
  const [config, setConfig] = useState<GitLabConfig>()
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<'connect' | 'disconnect' | null>(null)
  const [showToken, setShowToken] = useState(false)
  useEffect(() => {
    let active = true
    void window.desktop
      .gitlab({ kind: 'config' })
      .then(({ config }) => {
        if (active && config) {
          setConfig(config)
          setURL(config.url)
          setCertificate(config.caCertificate ?? '')
          setIgnoreTls(config.ignoreTls ?? false)
        }
      })
      .catch((error: Error) => {
        if (active) setError(error.message)
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [])
  return (
    <form
      className="flex h-full min-h-0 flex-col"
      onSubmit={(event) => {
        event.preventDefault()
        setBusy('connect')
        setError('')
        const secret = token.current!.value
        token.current!.value = ''
        setShowToken(false)
        void window.desktop
          .gitlab({ kind: 'configure', url: url.trim(), token: secret, caCertificate, ignoreTls })
          .then(({ config }) => {
            setConfig(config)
            window.dispatchEvent(new Event('gitlab-configured'))
          })
          .catch((error: Error) => setError(error.message))
          .finally(() => setBusy(null))
      }}
    >
      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">
        <div className="mt-6 flex items-center gap-3 rounded-md border bg-muted/30 p-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-md border bg-background">
            <span
              aria-hidden="true"
              className="size-5 bg-current"
              style={{ mask: `url("${gitlabLogo}") center / contain no-repeat` }}
            />
          </div>
          <div className="min-w-0">
            <p className="font-semibold" role="status">
              {loading ? 'Loading connection…' : config?.configured ? 'Connected' : 'Not connected'}
            </p>
            <p
              className="truncate text-muted-foreground"
              title={config?.configured ? config.url : undefined}
            >
              {config?.configured
                ? `${config.url}${config.version ? ` · GitLab ${config.version}` : ''}`
                : 'Use GitLab.com or your team’s GitLab instance.'}
            </p>
          </div>
        </div>

        <fieldset disabled={!!busy || loading} className="mt-6 space-y-5 disabled:opacity-50">
          <label className="block space-y-2">
            <span className="block font-semibold">GitLab URL</span>
            <Input
              aria-label="GitLab instance URL"
              className="w-full"
              aria-describedby="gitlab-url-help"
              type="url"
              required
              value={url}
              onChange={(event) => setURL(event.target.value)}
              placeholder="https://gitlab.com"
              spellCheck={false}
              autoCapitalize="none"
            />
            <span id="gitlab-url-help" className="block text-muted-foreground">
              The address of your GitLab instance, without a project path.
            </span>
          </label>
          <div className="space-y-2">
            <label htmlFor="gitlab-token" className="font-semibold">
              Personal access token
            </label>
            <div className="relative">
              <Input
                id="gitlab-token"
                aria-label="GitLab token"
                aria-describedby="gitlab-token-help"
                ref={token}
                type={showToken ? 'text' : 'password'}
                autoComplete="off"
                required
                className="w-full pr-10"
                placeholder={
                  config?.configured
                    ? 'Enter a token to update your connection'
                    : 'Paste your access token'
                }
              />
              <Button
                variant="ghost"
                size="icon"
                className="absolute top-0 right-0"
                aria-label={showToken ? 'Hide token' : 'Show token'}
                aria-pressed={showToken}
                onClick={() => setShowToken(!showToken)}
              >
                {showToken ? <EyeOff /> : <Eye />}
              </Button>
            </div>
            <p id="gitlab-token-help" className="text-muted-foreground">
              In GitLab, open your user settings → Access tokens. Create a token with the{' '}
              <code className="rounded bg-muted px-1 font-mono text-foreground">api</code> scope.
            </p>
            <p className="flex items-center gap-1.5 text-muted-foreground">
              <ShieldCheck className="size-3.5 shrink-0" aria-hidden="true" />
              Stored encrypted on this device.
            </p>
          </div>

          <details className="group rounded-md border">
            <summary className="flex cursor-pointer list-none items-center gap-2 rounded-md p-3 outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
              <ChevronRight className="size-4 shrink-0 text-muted-foreground group-open:rotate-90" />
              <span>
                <span className="block font-semibold">Advanced connection settings</span>
                <span className="block text-muted-foreground">
                  Custom certificates for self-hosted GitLab.
                </span>
              </span>
            </summary>
            <div className="space-y-4 border-t p-3">
              <label className="block space-y-2">
                <span className="font-semibold">
                  CA certificate{' '}
                  <span className="font-normal text-muted-foreground">(optional)</span>
                </span>
                <Textarea
                  aria-label="GitLab CA certificate"
                  value={caCertificate}
                  onChange={(event) => setCertificate(event.target.value)}
                  placeholder="Paste a PEM certificate"
                  className="min-h-24 font-mono"
                  spellCheck={false}
                />
                <span className="block text-muted-foreground">
                  Only needed if your team uses a private certificate authority.
                </span>
              </label>
              <div className="flex items-start justify-between gap-4 border-t pt-4">
                <label htmlFor="gitlab-verify-tls" className="cursor-pointer">
                  <span className="block font-semibold">Verify server certificate</span>
                  <span className="mt-1 block text-muted-foreground">
                    Keep enabled to verify that you’re connecting to your GitLab server.
                  </span>
                </label>
                <Switch
                  id="gitlab-verify-tls"
                  className="mt-0.5 shrink-0"
                  checked={!ignoreTls}
                  onCheckedChange={(checked) => setIgnoreTls(!checked)}
                />
              </div>
              {ignoreTls && (
                <p className="text-git-deleted">
                  Certificate verification is off. Your connection may be insecure.
                </p>
              )}
            </div>
          </details>
        </fieldset>
      </div>
      <footer className="shrink-0 border-t bg-background px-6 py-4">
        {error && (
          <p role="alert" className="mb-3 wrap-anywhere text-git-deleted">
            {error}
          </p>
        )}
        <div className="flex items-center justify-end gap-2">
          {config?.configured && (
            <Button
              variant="ghost"
              className="mr-auto"
              disabled={!!busy || loading}
              onClick={() => {
                setBusy('disconnect')
                setError('')
                void window.desktop
                  .gitlab({ kind: 'disconnect' })
                  .then(({ config }) => {
                    setConfig(config)
                    if (token.current) token.current.value = ''
                    setShowToken(false)
                    window.dispatchEvent(new Event('gitlab-configured'))
                  })
                  .catch((error: Error) => setError(error.message))
                  .finally(() => setBusy(null))
              }}
            >
              {busy === 'disconnect' && <LoaderCircle className="animate-spin" />}Disconnect
            </Button>
          )}
          <Button type="submit" disabled={!!busy || loading}>
            {busy === 'connect' && <LoaderCircle className="animate-spin" />}
            {busy === 'connect'
              ? 'Connecting…'
              : config?.configured
                ? 'Update connection'
                : 'Connect'}
          </Button>
        </div>
      </footer>
    </form>
  )
}

export function GitLabProvider({
  iid,
  localThreads = [],
  snapshot,
  children,
  onCompare,
  onReviewChange,
  onNavigateThread,
}: {
  iid?: number
  snapshot?: Snapshot
  localThreads?: LocalThread[]
  children: ReactNode
  onNavigateThread: (path: string, discussion: string) => void
  onReviewChange: (review: GitLabReview | undefined) => void
  onCompare: (comparison: Comparison) => void
}) {
  const queryClient = useQueryClient()
  const localMutation = useMutation({
    mutationFn: ({ snapshot: id, action }: { snapshot: string; action: ReviewAction }) =>
      window.desktop.updateReviewRecord(id, action),
    scope: { id: `record-${snapshot?.id}` },
    onSuccess: (record, variables) =>
      queryClient.setQueryData(['review-record', variables.snapshot], record),
  })
  const mutateLocal = localMutation.mutateAsync
  const uploadedDiscussions = useRef(new Map<string, string>())
  const uploadedLocal = useRef(new Set<string>())
  const publishingLocal = useRef(false)
  const [publishing, setPublishing] = useState(false)
  const [matches, setMatches] = useState<MR[]>([])
  const [loadedReview, setReview] = useState<GitLabReview>()
  const latestReview = useRef<GitLabReview>(undefined)
  const [boundSnapshot, setBoundSnapshot] = useState(snapshot?.id)
  const review = boundSnapshot === snapshot?.id ? loadedReview : undefined
  useEffect(() => {
    latestReview.current = review
  }, [review])
  const [looking, setLooking] = useState(false)
  const [busy, setBusy] = useState(false)
  const actionPending = useRef(false)
  const actionVersion = useRef(0)
  const [open, setOpen] = useState(false)
  const [missing, setMissing] = useState(false)
  const [copiedLink, setCopiedLink] = useState<string>()
  useEffect(() => {
    if (!copiedLink) return
    const timeout = setTimeout(() => setCopiedLink(undefined), 2000)
    return () => clearTimeout(timeout)
  }, [copiedLink])
  const [error, setError] = useState('')
  const [notification, setNotification] = useState('')
  const notifiedErrors = useRef(new Set<string>())
  useEffect(() => {
    if (!error) return
    const message = error.replace(/Error invoking remote method '[^']+': (?:Error: )?/g, '')
    if (notifiedErrors.current.has(message)) return
    notifiedErrors.current.add(message)
    setNotification(message)
  }, [error])
  useEffect(() => {
    if (!notification) return
    const timeout = setTimeout(() => setNotification(''), 10000)
    return () => clearTimeout(timeout)
  }, [notification])
  const generation = useRef(Symbol())
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const lookup = async (show: boolean) => {
    if (!snapshot) return
    const current = Symbol()
    generation.current = current
    setLooking(true)
    setError('')
    setMissing(false)
    clearTimeout(timer.current)
    try {
      const result = await window.desktop.gitlab({ kind: 'lookup', snapshot: snapshot.id, iid })
      if (generation.current !== current) return
      setMatches(result.matches ?? [])
      setReview(undefined)
      if (result.matches?.length === 1) {
        const selected = await window.desktop.gitlab({
          kind: 'select',
          snapshot: snapshot.id,
          iid: result.matches[0].iid,
        })
        if (generation.current !== current) return
        setReview(selected.review)
      }
      if (result.matches?.length) {
        if (show) setOpen(true)
      } else {
        setMissing(true)
        timer.current = setTimeout(() => setMissing(false), 1000)
        if (show && result.config && !result.config.configured)
          setError('Configure GitLab in Settings to find merge requests.')
      }
    } catch (error) {
      if (generation.current === current) {
        setError((error as Error).message)
        if (show) setOpen(true)
      }
    } finally {
      if (generation.current === current) setLooking(false)
    }
  }
  useEffect(() => {
    setBoundSnapshot(snapshot?.id)
    setReview(undefined)
    setMatches([])
    setOpen(false)
    setBusy(false)
    setLooking(false)
    setMissing(false)
    setError('')
    void lookup(false)
    const configure = () => {
      setReview(undefined)
      setMatches([])
      void lookup(false)
    }
    window.addEventListener('gitlab-configured', configure)
    return () => {
      generation.current = Symbol()
      clearTimeout(timer.current)
      window.removeEventListener('gitlab-configured', configure)
    }
    // Snapshot and configuration changes restart lookup without remounting the review UI.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot?.id, iid])
  useEffect(() => {
    onReviewChange(review)
  }, [review, onReviewChange])
  const [discussionFilter, setDiscussionFilter] = useState<
    'all' | 'unresolved' | 'resolved' | 'activity'
  >('all')
  const session = review?.session
  useEffect(() => setDiscussionFilter('all'), [session])
  useEffect(() => {
    if (!session) return
    let active = true
    let pending = false
    const refresh = async () => {
      if (pending || actionPending.current || !document.hasFocus()) return
      pending = true
      const version = actionVersion.current
      try {
        const result = await window.desktop.gitlab({ kind: 'refresh', session })
        if (active && version === actionVersion.current) {
          setReview(result.review)
          setError('')
        }
      } catch (error) {
        if (active && version === actionVersion.current) setError((error as Error).message)
      } finally {
        pending = false
      }
    }
    const interval = setInterval(() => void refresh(), 60000)
    window.addEventListener('focus', refresh)
    return () => {
      active = false
      clearInterval(interval)
      window.removeEventListener('focus', refresh)
    }
  }, [session])
  const act = useCallback(
    async (
      request: GitLabRequest,
      options?: { requirePosted: boolean; onPosted?: (discussion: string) => void },
    ) => {
      if (actionPending.current) return false
      actionPending.current = true
      actionVersion.current++
      setBusy(true)
      setError('')
      const current = generation.current
      const previous =
        latestReview.current?.session === review?.session ? latestReview.current : review
      const optimistic = previous ? optimisticGitLabReview(previous, request) : undefined
      const changed = optimistic !== previous
      if (changed) setReview(optimistic)
      try {
        const result = await window.desktop.gitlab(request)
        if (generation.current !== current) return false
        if (result.review && !changed) setReview(result.review)
        if (
          ![
            'refresh',
            'open-url',
            'copy-url',
            'open-app',
            'copy-app-link',
            'open-pipeline',
            'copy-pipeline-link',
          ].includes(request.kind)
        ) {
          if (session) {
            try {
              const refreshed = await window.desktop.gitlab({ kind: 'refresh', session })
              if (generation.current === current) {
                latestReview.current = refreshed.review
                setReview(refreshed.review)
              }
            } catch (error) {
              if (generation.current === current)
                setError(`The action completed, but refresh failed: ${(error as Error).message}`)
            }
          }
        }
        if (result.posted && result.discussion) options?.onPosted?.(result.discussion)
        return options?.requirePosted ? result.posted === true : true
      } catch (error) {
        if (generation.current === current) {
          if (changed) setReview(previous)
          setError((error as Error).message)
        }
        return false
      } finally {
        actionPending.current = false
        actionVersion.current++
        if (generation.current === current) setBusy(false)
      }
    },
    [review, session],
  )
  const uploadLocal = useCallback(
    async (thread: LocalThread, id: string) => {
      if (!snapshot || !review?.aligned) return false
      const threadKey = `${review.mr.project_id}:${review.mr.iid}:${snapshot.repository}:${thread.id}`
      const key = `${threadKey}:${id}`
      if (!uploadedLocal.current.has(key)) {
        const file = await window.desktop.loadReviewFile(snapshot.id, thread.path, false)
        if (file.fingerprint !== thread.fingerprint)
          throw new Error(
            `The local comment on ${thread.path} is outdated. Review it before publishing.`,
          )
        const message = thread.messages.find((message) => message.id === id)
        if (!message) return false
        const posted = await act(
          {
            kind: 'comment',
            session: review.session,
            body: message.body,
            ...(uploadedDiscussions.current.has(threadKey)
              ? { discussion: uploadedDiscussions.current.get(threadKey)! }
              : {
                  anchor: {
                    path: thread.path,
                    side: thread.side,
                    line: thread.end,
                    startLine: thread.start,
                  },
                }),
          },
          {
            requirePosted: true,
            onPosted: (discussion) => uploadedDiscussions.current.set(threadKey, discussion),
          },
        )
        if (!posted) return false
        uploadedLocal.current.add(key)
      }
      try {
        await mutateLocal({
          snapshot: snapshot.id,
          action: { kind: 'delete-comment', thread: thread.id, message: id },
        })
      } catch (error) {
        throw new Error(
          `Posted to GitLab, but the local comment could not be removed. Retry to remove it: ${(error as Error).message}`,
        )
      }
      return true
    },
    [snapshot, review, act, mutateLocal],
  )
  const context = useMemo(
    () => ({ review, snapshot, busy: busy || publishing, act, uploadLocal }),
    [review, snapshot, busy, publishing, act, uploadLocal],
  )
  const publishAllLocal = async () => {
    if (publishingLocal.current || busy || !review?.aligned) return
    publishingLocal.current = true
    setPublishing(true)
    const current = generation.current
    try {
      for (const thread of localThreads) {
        for (const message of thread.messages) {
          if (generation.current !== current || !(await uploadLocal(thread, message.id))) return
        }
      }
    } catch (error) {
      if (generation.current === current) setError((error as Error).message)
    } finally {
      publishingLocal.current = false
      setPublishing(false)
    }
  }
  const pipelineStatus = review?.mr.head_pipeline?.status
  const pipeline =
    pipelineStatus && Object.hasOwn(pipelineStates, pipelineStatus)
      ? pipelineStates[pipelineStatus as keyof typeof pipelineStates]
      : {
          label: pipelineStatus?.replaceAll('_', ' ') || 'No pipeline',
          icon: CircleDashed,
          color: 'border-border bg-muted/50 text-muted-foreground',
        }
  const PipelineIcon = pipeline.icon
  const newRevision =
    !!review &&
    (review.mr.sha !== review.pinned.head_sha ||
      review.mr.diff_refs?.base_sha !== review.pinned.base_sha)
  const needsRevision = !!review && !review.aligned
  const approvedByMe =
    review?.approvals?.approved_by.some(({ user }) => user.id === review.userId) ?? false
  const approvalDisabledReason = busy
    ? 'Wait for the current action to finish.'
    : publishing
      ? 'Wait for comments to finish publishing.'
      : !approvedByMe && review?.approvalBlockedReason
        ? review.approvalBlockedReason
        : !review?.approvals
          ? review?.approvalError || 'Approval information is unavailable. Refresh the MR to retry.'
          : needsRevision && !approvedByMe
            ? 'Open and review the current MR revision before approving.'
            : ''
  const discussions =
    review?.discussions.filter((discussion) => {
      const first = discussion.notes[0]
      if (discussionFilter === 'activity') return first?.system
      if (first?.system) return false
      if (discussionFilter === 'unresolved') return first?.resolvable && !first.resolved
      if (discussionFilter === 'resolved') return first?.resolvable && first.resolved
      return true
    }) ?? []
  const visibleLocalThreads = localThreads.filter((thread) =>
    discussionFilter === 'activity'
      ? false
      : discussionFilter === 'resolved'
        ? thread.resolved
        : discussionFilter === 'unresolved'
          ? !thread.resolved
          : true,
  )
  const errorNotification = notification && (
    <div
      data-testid="gitlab-error-notification"
      className="pointer-events-auto fixed right-5 bottom-5 z-[100] flex max-w-sm items-start gap-3 rounded-lg border bg-background p-4 shadow-lg"
    >
      <CircleX aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-git-deleted" />
      <div role="alert" className="min-w-0 flex-1">
        <p className="font-semibold">GitLab</p>
        <p className="mt-1 break-words text-sm text-muted-foreground">{notification}</p>
      </div>
      <Button
        variant="ghost"
        size="icon"
        className="size-6 shrink-0"
        aria-label="Dismiss GitLab notification"
        onClick={() => setNotification('')}
      >
        <X className="size-4" />
      </Button>
    </div>
  )
  return (
    <GitLabContext.Provider value={context}>
      {!(boundSnapshot === snapshot?.id && open) && errorNotification}
      <GitLabButtonContext.Provider
        value={
          <>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Merge request"
              aria-busy={looking}
              title={missing ? 'No matching merge request' : 'Merge request'}
              disabled={!snapshot || looking}
              className={missing ? 'text-git-deleted hover:text-git-deleted' : ''}
              onClick={() => {
                if (review || matches.length) setOpen(true)
                else void lookup(true)
              }}
            >
              {looking ? <LoaderCircle className="animate-spin" /> : <GitPullRequest />}
            </Button>
            <span role="status" className="sr-only">
              {looking ? 'Searching merge requests' : missing ? 'No matching merge request' : ''}
            </span>
            <Dialog open={boundSnapshot === snapshot?.id && open} onOpenChange={setOpen}>
              <DialogContent
                closeLabel="Close merge request"
                animation="slide-right"
                aria-describedby={undefined}
                className="inset-y-0 right-0 left-auto flex h-dvh w-[min(43.75rem,calc(100vw-3rem))] max-w-none translate-x-0 translate-y-0 flex-col rounded-none border-y-0 border-r-0 p-0 shadow-2xl"
              >
                {errorNotification}
                <header className="shrink-0 space-y-4 border-b bg-surface px-6 py-5">
                  <div className="flex flex-wrap items-center gap-2 pr-10 text-muted-foreground">
                    <span
                      aria-hidden="true"
                      className="size-4 shrink-0 bg-current"
                      style={{ mask: `url("${gitlabLogo}") center / contain no-repeat` }}
                    />
                    <span>Merge request{review ? ` !${review.mr.iid}` : ''}</span>
                    {review && (
                      <span className="rounded border px-2 text-foreground">
                        {review.mr.draft
                          ? 'Draft'
                          : ({ opened: 'Open', merged: 'Merged', closed: 'Closed' }[
                              review.mr.state
                            ] ?? review.mr.state)}
                      </span>
                    )}
                    {review && (
                      <div className="flex shrink-0 items-center gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label="Refresh"
                          title="Refresh merge request"
                          disabled={busy || publishing}
                          onClick={() => void act({ kind: 'refresh', session: review.session })}
                        >
                          <RefreshCw className={busy ? 'animate-spin' : ''} />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label="Open in GitLab"
                          title="Open in GitLab"
                          disabled={busy || publishing}
                          onClick={() => void act({ kind: 'open-url', session: review.session })}
                        >
                          <ExternalLink />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label="Copy MR link"
                          title={copiedLink === review.mr.web_url ? 'Copied!' : 'Copy MR link'}
                          disabled={busy || publishing}
                          onClick={() =>
                            void act({ kind: 'copy-url', session: review.session }).then(
                              (success) => {
                                if (success) setCopiedLink(review.mr.web_url)
                              },
                            )
                          }
                        >
                          {copiedLink === review.mr.web_url ? <Check /> : <Copy />}
                        </Button>
                        <Tooltip
                          label={
                            approvalDisabledReason ||
                            (approvedByMe ? 'Remove your approval' : 'Approve this merge request')
                          }
                        >
                          <span
                            className="inline-flex shrink-0"
                            tabIndex={approvalDisabledReason ? 0 : undefined}
                          >
                            <Button
                              variant="ghost"
                              className="shrink-0"
                              disabled={!!approvalDisabledReason}
                              onClick={() =>
                                void act({
                                  kind: 'approve',
                                  session: review.session,
                                  approved: !approvedByMe,
                                })
                              }
                            >
                              <Check />
                              {approvedByMe ? 'Unapprove' : 'Approve'}
                            </Button>
                          </span>
                        </Tooltip>
                      </div>
                    )}
                  </div>
                  {review?.approvalBlockedReason && !approvedByMe && (
                    <p className="mb-3 text-muted-foreground">{review.approvalBlockedReason}</p>
                  )}
                  <DialogTitle className="pr-8 font-semibold wrap-anywhere">
                    {review ? (
                      <>
                        <span className="sr-only">!{review.mr.iid} </span>
                        {review.mr.title}
                      </>
                    ) : (
                      'Merge request'
                    )}
                  </DialogTitle>
                  {review && (
                    <div
                      className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground"
                      aria-label="Merge direction"
                    >
                      <span
                        className="min-w-0 truncate font-mono"
                        title={`Source: ${review.mr.source_branch}`}
                      >
                        {review.mr.source_branch}
                      </span>
                      <ArrowRight className="size-3.5 shrink-0" aria-hidden="true" />
                      <span
                        className="min-w-0 truncate font-mono"
                        title={`Target: ${review.mr.target_branch}`}
                      >
                        {review.mr.target_branch}
                      </span>
                    </div>
                  )}
                </header>
                <div className="min-h-0 flex-1 space-y-6 overflow-auto p-6">
                  {!review && (
                    <div className="space-y-3">
                      <p className="text-muted-foreground">
                        {matches.length
                          ? 'Choose the merge request you want to review.'
                          : 'Look for a merge request from the New branch into the Old branch.'}
                      </p>
                      <Button
                        variant="outline"
                        disabled={looking || busy}
                        onClick={() => void lookup(true)}
                      >
                        {looking ? <LoaderCircle className="animate-spin" /> : <RefreshCw />}Retry
                        lookup
                      </Button>
                      {matches.map((mr) => (
                        <Button
                          key={mr.iid}
                          variant="outline"
                          className="flex h-auto w-full flex-col items-start gap-1 p-3 text-left whitespace-normal"
                          disabled={busy || publishing}
                          onClick={() => {
                            if (snapshot)
                              void act({ kind: 'select', snapshot: snapshot.id, iid: mr.iid })
                          }}
                        >
                          <span className="font-semibold">
                            !{mr.iid} {mr.title}
                          </span>
                          <span className="text-muted-foreground">
                            {mr.source_branch} → {mr.target_branch}
                          </span>
                        </Button>
                      ))}
                    </div>
                  )}
                  {review && (
                    <>
                      {needsRevision && (
                        <section className="space-y-3 rounded-md border bg-muted/30 p-3">
                          <div>
                            <p role="status" className="font-semibold">
                              {newRevision
                                ? 'A new revision is available'
                                : 'Your comparison differs from this MR'}
                            </p>
                            <p className="mt-1 text-muted-foreground">
                              {newRevision
                                ? 'Your diff still refers to the revision you opened.'
                                : 'Load the MR’s source and target revisions to comment inline and approve.'}
                            </p>
                          </div>
                          <Button
                            variant="outline"
                            disabled={busy || !review.mr.diff_refs}
                            onClick={() => {
                              if (!review.mr.diff_refs) return
                              setOpen(false)
                              onCompare({
                                base: { kind: 'commit', ref: `origin/${review.mr.target_branch}` },
                                target: {
                                  kind: 'commit',
                                  ref: `origin/${review.mr.source_branch}`,
                                },
                                mode: 'merge-base',
                              })
                            }}
                          >
                            <RefreshCw />
                            Fetch and open MR revision
                          </Button>
                        </section>
                      )}
                      <dl className="grid grid-cols-[5.5rem_minmax(0,1fr)] items-center gap-x-3 gap-y-3">
                        <dt className="text-muted-foreground">Opened by</dt>
                        <dd>
                          <GitLabPerson user={review.mr.author} />
                        </dd>
                        <dt className="text-muted-foreground">Assignee</dt>
                        <dd className="flex flex-wrap gap-x-3 gap-y-2">
                          {(review.mr.assignees ?? (review.mr.assignee ? [review.mr.assignee] : []))
                            .length ? (
                            (review.mr.assignees ?? [review.mr.assignee!]).map((user) => (
                              <GitLabPerson key={user.id} user={user} />
                            ))
                          ) : (
                            <span className="text-muted-foreground">Not assigned</span>
                          )}
                        </dd>
                        <dt className="text-muted-foreground">Reviewers</dt>
                        <dd className="flex flex-wrap gap-x-3 gap-y-2">
                          {review.mr.reviewers?.length ? (
                            review.mr.reviewers.map((user) => (
                              <GitLabPerson key={user.id} user={user} />
                            ))
                          ) : (
                            <span className="text-muted-foreground">Not assigned</span>
                          )}
                        </dd>
                        <dt className="text-muted-foreground">Approved by</dt>
                        <dd className="flex flex-wrap items-center gap-x-3 gap-y-2">
                          {review.approvals?.approved_by.length ? (
                            review.approvals.approved_by.map(({ user }) => (
                              <GitLabPerson key={user.id} user={user} />
                            ))
                          ) : (
                            <span className="text-muted-foreground">
                              {review.approvalError ? 'Unavailable' : 'No approvals yet'}
                            </span>
                          )}
                          {review.approvalError && (
                            <details className="w-full text-muted-foreground">
                              <summary className="cursor-pointer">Approval details</summary>
                              <p>{review.approvalError}</p>
                            </details>
                          )}
                        </dd>
                        <dt className="text-muted-foreground">Pipeline</dt>
                        <dd className="flex flex-wrap items-center gap-2">
                          <span
                            className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium ${'color' in pipeline ? pipeline.color : 'border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-400'}`}
                          >
                            <PipelineIcon
                              aria-hidden="true"
                              className={`size-3.5 ${pipelineStatus === 'running' || pipelineStatus === 'preparing' ? 'motion-safe:animate-spin' : ''}`}
                            />
                            {pipeline.label}
                          </span>
                          {review.mr.head_pipeline?.web_url && (
                            <>
                              <Button
                                variant="ghost"
                                className="h-6 shrink-0 gap-1 px-2 text-xs [&_svg]:size-3.5"
                                disabled={busy || publishing}
                                onClick={() =>
                                  void act({ kind: 'open-pipeline', session: review.session })
                                }
                              >
                                <ExternalLink />
                                View pipeline
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="size-6 shrink-0 [&_svg]:size-3.5"
                                aria-label="Copy pipeline link"
                                title={
                                  copiedLink === review.mr.head_pipeline.web_url
                                    ? 'Copied!'
                                    : 'Copy pipeline link'
                                }
                                disabled={busy || publishing}
                                onClick={() => {
                                  const url = review.mr.head_pipeline!.web_url
                                  void act({
                                    kind: 'copy-pipeline-link',
                                    session: review.session,
                                  }).then((copied) => {
                                    if (copied) setCopiedLink(url)
                                  })
                                }}
                              >
                                {copiedLink === review.mr.head_pipeline.web_url ? (
                                  <Check />
                                ) : (
                                  <Copy />
                                )}
                              </Button>
                            </>
                          )}
                        </dd>
                        <dt className="text-muted-foreground">Review app</dt>
                        <dd className="space-y-2">
                          {review.reviewApps?.length ? (
                            review.reviewApps.map((app) => (
                              <div key={app.id} className="flex flex-wrap items-center gap-2">
                                <span
                                  className="min-w-0 text-xs text-muted-foreground wrap-anywhere"
                                  title={app.url}
                                >
                                  {app.name}
                                </span>
                                <Button
                                  variant="ghost"
                                  className="h-6 shrink-0 gap-1 px-2 text-xs [&_svg]:size-3.5"
                                  disabled={busy || publishing}
                                  onClick={() =>
                                    void act({
                                      kind: 'open-app',
                                      session: review.session,
                                      environment: app.id,
                                    })
                                  }
                                >
                                  <ExternalLink />
                                  View app
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="size-6 shrink-0 [&_svg]:size-3.5"
                                  aria-label="Copy app link"
                                  title={copiedLink === app.url ? 'Copied!' : 'Copy app link'}
                                  onClick={() => {
                                    void act({
                                      kind: 'copy-app-link',
                                      session: review.session,
                                      environment: app.id,
                                    }).then((copied) => {
                                      if (copied) setCopiedLink(app.url)
                                    })
                                  }}
                                >
                                  {copiedLink === app.url ? <Check /> : <Copy />}
                                </Button>
                              </div>
                            ))
                          ) : (
                            <span className="text-muted-foreground">
                              {review.reviewAppsError
                                ? 'Could not load review apps. Refresh to retry.'
                                : 'No deployed review app'}
                            </span>
                          )}
                        </dd>
                        {!!review.mr.labels.length && (
                          <>
                            <dt className="text-muted-foreground">Labels</dt>
                            <dd className="flex flex-wrap gap-1.5">
                              {review.mr.labels.map((label) => (
                                <span
                                  key={label}
                                  className="rounded border bg-muted/30 px-2 wrap-anywhere"
                                >
                                  {label}
                                </span>
                              ))}
                            </dd>
                          </>
                        )}
                      </dl>
                      <details open className="group border-y py-4">
                        <summary className="flex cursor-pointer list-none items-center gap-2 font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
                          <ChevronRight className="size-4 text-muted-foreground group-open:rotate-90" />
                          Description
                        </summary>
                        <div className="markdown mt-3 wrap-anywhere">
                          {review.mr.description ? (
                            <Markdown
                              remarkPlugins={[remarkGfm]}
                              skipHtml
                              components={{ img: ({ alt }) => <span>{alt}</span> }}
                            >
                              {review.mr.description}
                            </Markdown>
                          ) : (
                            <p className="text-muted-foreground">No description provided.</p>
                          )}
                        </div>
                      </details>
                      <section className="space-y-3" aria-label="Add a comment">
                        <h3 className="flex items-center gap-2 font-semibold">
                          <MessageSquare className="size-4 text-muted-foreground" />
                          Add a comment
                        </h3>
                        <GitLabComposer />
                      </section>
                      <section className="space-y-3" aria-label="Merge request discussions">
                        <h3 className="flex items-center justify-between font-semibold">
                          Discussions
                          {localThreads.length > 0 && (
                            <Button
                              variant="ghost"
                              className="h-6 px-2 text-xs font-normal"
                              disabled={
                                busy || publishing || localMutation.isPending || !review.aligned
                              }
                              onClick={() => void publishAllLocal()}
                            >
                              <Upload className="size-3.5" />
                              {publishing ? 'Publishing…' : 'Publish all local comments'}
                            </Button>
                          )}
                        </h3>
                        <div
                          className="flex flex-wrap gap-1 rounded-md border bg-muted/30 p-1"
                          role="group"
                          aria-label="Filter discussions"
                        >
                          {(['all', 'unresolved', 'resolved', 'activity'] as const).map(
                            (filter) => (
                              <Button
                                key={filter}
                                variant={discussionFilter === filter ? 'secondary' : 'ghost'}
                                className="h-7 flex-1 px-2"
                                aria-pressed={discussionFilter === filter}
                                onClick={() => setDiscussionFilter(filter)}
                              >
                                {
                                  {
                                    all: 'All',
                                    unresolved: 'Unresolved',
                                    resolved: 'Resolved',
                                    activity: 'Activity',
                                  }[filter]
                                }
                              </Button>
                            ),
                          )}
                        </div>
                        {visibleLocalThreads.map((thread) => (
                          <LocalMRThread
                            key={thread.id}
                            thread={thread}
                            snapshot={snapshot!}
                            mutate={(action) => mutateLocal({ snapshot: snapshot!.id, action })}
                            pending={localMutation.isPending || publishing}
                            onNavigate={
                              snapshot?.paths.includes(thread.path)
                                ? () => {
                                    setOpen(false)
                                    onNavigateThread(thread.path, thread.id)
                                  }
                                : undefined
                            }
                          />
                        ))}
                        {discussions.length ? (
                          discussions.map((discussion) => {
                            const position = discussion.notes[0]?.position
                            const file =
                              position &&
                              snapshot?.files.find(
                                (file) =>
                                  file.path === position.new_path ||
                                  file.oldPath === position.old_path,
                              )
                            const path =
                              file?.path ??
                              (position &&
                                snapshot?.paths.find(
                                  (path) =>
                                    path === position.new_path || path === position.old_path,
                                ))
                            return (
                              <GitLabDiscussion
                                key={discussion.id}
                                discussion={discussion}
                                inOverlay
                                onNavigate={
                                  path
                                    ? () => {
                                        setOpen(false)
                                        onNavigateThread(path, discussion.id)
                                      }
                                    : undefined
                                }
                              />
                            )
                          })
                        ) : visibleLocalThreads.length ? null : (
                          <p className="rounded-md border border-dashed px-3 py-6 text-center text-muted-foreground">
                            {discussionFilter === 'unresolved'
                              ? 'No unresolved discussions.'
                              : discussionFilter === 'resolved'
                                ? 'No resolved discussions.'
                                : discussionFilter === 'activity'
                                  ? 'No activity yet.'
                                  : 'No discussions yet. Start one with a comment above.'}
                          </p>
                        )}
                      </section>
                    </>
                  )}
                </div>
              </DialogContent>
            </Dialog>
          </>
        }
      >
        {children}
      </GitLabButtonContext.Provider>
    </GitLabContext.Provider>
  )
}
const GitLabButtonContext = createContext<ReactNode>(null)
export function GitLabButton() {
  return useContext(GitLabButtonContext)
}

export function GitLabComposer({
  anchor,
  discussion,
  initialBody = '',
  value,
  onChange,
  onSaved,
  onCancel,
  range,
  headerActions,
  onRangeChange,
  suggestion,
}: {
  value?: string
  onChange?: (body: string) => void
  headerActions?: ReactNode
  range?: CommentRange
  onRangeChange?: (range: CommentRange) => void
  suggestion?: string
  onCancel?: () => void
  anchor?: Anchor
  discussion?: string
  initialBody?: string
  onSaved?: () => void
}) {
  const context = useGitLab()
  const [localBody, setLocalBody] = useState(initialBody)
  const body = value ?? localBody
  const setBody = onChange ?? setLocalBody
  const [saving, setSaving] = useState(false)
  if (!context?.review) return null
  const { review, act, busy } = context
  const post = async () => {
    setSaving(true)
    try {
      if (await act({ kind: 'comment', session: review.session, body, anchor, discussion })) {
        setBody('')
        onSaved?.()
      }
    } finally {
      setSaving(false)
    }
  }
  return (
    <div className="space-y-2" data-review-editor>
      <CommentComposer
        body={body}
        onChange={setBody}
        label={discussion ? 'GitLab reply' : 'GitLab comment'}
        busy={saving || busy}
        headerActions={headerActions}
        range={range}
        onRangeChange={onRangeChange}
        suggestion={suggestion}
        onPost={() => void post()}
        onCancel={
          onCancel || onSaved
            ? () => {
                setBody('')
                ;(onCancel ?? onSaved)?.()
              }
            : undefined
        }
      />
    </div>
  )
}

export function GitLabDiscussion({
  discussion,
  inOverlay = false,
  onNavigate,
}: {
  discussion: Discussion
  inOverlay?: boolean
  onNavigate?: () => void
}) {
  const context = useGitLab()
  if (!context?.review) return null
  const { review, busy, act } = context
  const first = discussion.notes[0]
  const position = first?.position
  const outdated =
    position &&
    ((position.position_type !== 'text' && position.position_type !== 'file') ||
      (position.position_type === 'text' &&
        !Number.isInteger(position.new_line ?? position.old_line)) ||
      position.head_sha !== review.pinned.head_sha ||
      position.base_sha !== review.pinned.base_sha ||
      position.start_sha !== review.pinned.start_sha ||
      !review.aligned)
  return (
    <ThreadView
      source="GitLab"
      linkBase={review.mr.web_url}
      label="GitLab discussion"
      discussionId={discussion.id}
      messages={discussion.notes.map((note) => ({
        id: String(note.id),
        author: (
          <>
            <GitLabPerson user={note.author} />
            {note.id < 0 && (
              <span className="text-xs text-muted-foreground">
                {busy ? 'Posting…' : 'Awaiting refresh'}
              </span>
            )}
          </>
        ),
        date: note.created_at ?? note.updated_at,
        body: note.body,
        suggestions: note.suggestions,
        editable: !note.system && note.author.id === review.userId,
      }))}
      loadSuggestion={
        position &&
        !outdated &&
        context.snapshot &&
        (position.new_line || position.position_type === 'file')
          ? async () => {
              const file = await window.desktop.loadReviewFile(
                context.snapshot!.id,
                position.new_path,
                false,
              )
              if (!file.newFile || file.large || file.summary)
                throw new Error('The source text is unavailable for this suggestion.')
              const lines = file.newFile.contents.split('\n')
              if (lines.at(-1) === '') lines.pop()
              if (position.position_type === 'file') return { contents: lines.join('\n') }
              const end = position.line_range?.end.new_line ?? position.new_line!
              const start = position.line_range?.start.new_line ?? end
              if (start < 1 || end < start || end > lines.length)
                throw new Error('The comment range is outside the source file.')
              return { contents: lines.slice(start - 1, end).join('\n'), before: end - start }
            }
          : undefined
      }
      pending={busy || discussion.notes.some((note) => note.id < 0)}
      resolved={!!first?.resolved}
      onEdit={(id, body) =>
        act({
          kind: 'edit',
          session: review.session,
          discussion: discussion.id,
          note: Number(id),
          body,
        })
      }
      onDelete={(id) =>
        act({
          kind: 'delete-note',
          session: review.session,
          discussion: discussion.id,
          note: Number(id),
        })
      }
      onResolve={
        first?.resolvable
          ? () =>
              act({
                kind: 'resolve',
                session: review.session,
                discussion: discussion.id,
                resolved: !first.resolved,
              })
          : undefined
      }
      details={
        <>
          {!inOverlay && outdated && (
            <p className="text-xs text-muted-foreground">Outdated / unplaced</p>
          )}
          {inOverlay && position && (
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span className="break-all font-mono">
                {position.new_line || position.position_type === 'file'
                  ? position.new_path
                  : position.old_path}
                {position.position_type === 'text'
                  ? `:${position.new_line ?? position.old_line ?? 'unplaced'}`
                  : ''}
                {outdated ? ' · Outdated / unplaced' : ''}
              </span>
              {onNavigate && (
                <Button
                  type="button"
                  variant="ghost"
                  className="h-6 gap-1 px-2 text-xs"
                  onClick={onNavigate}
                >
                  <ArrowRight className="size-3" />
                  View in diff
                </Button>
              )}
            </div>
          )}
        </>
      }
      reply={
        !first?.system
          ? (close) => (
              <GitLabComposer discussion={discussion.id} onSaved={close} onCancel={close} />
            )
          : undefined
      }
    />
  )
}

function LocalMRThread({
  thread,
  snapshot,
  mutate,
  pending,
  onNavigate,
}: {
  thread: LocalThread
  snapshot: Snapshot
  mutate: React.ComponentProps<typeof Thread>['mutate']
  pending: boolean
  onNavigate?: () => void
}) {
  const content = useQuery({
    queryKey: ['review-file', snapshot.id, thread.path, false],
    queryFn: () => window.desktop.loadReviewFile(snapshot.id, thread.path, false),
    retry: false,
    staleTime: Infinity,
  })
  const current = content.data?.fingerprint === thread.fingerprint
  const source = thread.side === 'additions' ? content.data?.newFile : content.data?.oldFile
  return (
    <Thread
      thread={thread}
      mutate={mutate}
      pending={pending}
      current={current}
      sourceContents={current ? source?.contents : undefined}
      inOverlay
      onNavigate={onNavigate}
    />
  )
}
