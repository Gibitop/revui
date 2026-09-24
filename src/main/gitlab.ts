import { request as httpsRequest } from 'node:https'
import { rootCertificates } from 'node:tls'
import { execFile } from 'node:child_process'
import { isDeepStrictEqual, promisify } from 'node:util'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import type { Snapshot } from '../shared/review'
import type {
  Anchor,
  Discussion,
  GitLabConfig,
  GitLabRequest,
  GitLabResult,
  GitLabReview,
  MR,
  Position,
} from '../shared/gitlab'

const exec = promisify(execFile)
const id = z.string().min(1).max(200)
const body = z.string().trim().min(1).max(100000)
const anchor = z.object({
  path: z.string().min(1).max(32768),
  side: z.enum(['additions', 'deletions']),
  line: z.number().int().positive(),
  startLine: z.number().int().positive().optional(),
})
export const gitlabRequestSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('open-mr'),
    repository: z.string().min(1).max(32768),
    input: z.string().trim().min(1).max(2000),
  }),
  z.object({ kind: z.literal('config') }),
  z.object({
    kind: z.literal('configure'),
    url: z.string().url().max(2000),
    token: z.string().min(1).max(10000),
    caCertificate: z.string().max(100000).optional(),
    ignoreTls: z.boolean().optional(),
  }),
  z.object({ kind: z.literal('disconnect') }),
  z.object({
    kind: z.literal('lookup'),
    snapshot: id,
    iid: z.number().int().positive().optional(),
  }),
  z.object({ kind: z.literal('select'), snapshot: id, iid: z.number().int().positive() }),
  z.object({ kind: z.literal('refresh'), session: id }),
  z.object({ kind: z.literal('avatar'), session: id, user: z.number().int().positive() }),
  z.object({ kind: z.literal('approve'), session: id, approved: z.boolean() }),
  z.object({
    kind: z.literal('comment'),
    session: id,
    body,
    discussion: id.optional(),
    anchor: anchor.optional(),
  }),
  z.object({
    kind: z.literal('edit'),
    session: id,
    discussion: id,
    note: z.number().int().positive(),
    body,
  }),
  z.object({
    kind: z.literal('delete-note'),
    session: id,
    discussion: id,
    note: z.number().int().positive(),
  }),
  z.object({ kind: z.literal('resolve'), session: id, discussion: id, resolved: z.boolean() }),
  z.object({ kind: z.literal('open-url'), session: id }),
  z.object({ kind: z.literal('copy-url'), session: id }),
  z.object({ kind: z.literal('open-pipeline'), session: id }),
  z.object({ kind: z.literal('copy-pipeline-link'), session: id }),
  z.object({ kind: z.literal('open-app'), session: id, environment: z.number().int().positive() }),
  z.object({
    kind: z.literal('copy-app-link'),
    session: id,
    environment: z.number().int().positive(),
  }),
])
type Diff = {
  old_path: string
  new_path: string
  diff: string
  too_large?: boolean
  collapsed?: boolean
}
type Session = { snapshot: Snapshot; review: GitLabReview; diffs: Diff[] }
type Credentials = {
  version: 1
  url: string
  encrypted: string
  serverVersion?: string
  caCertificate?: string
  ignoreTls?: boolean
}

export function projectFromOrigin(origin: string, instance: string): string {
  const base = new URL(instance)
  let remote: URL
  const scp = /^(?:[^@/:]+@)?([^/:]+):(.+)$/.exec(origin)
  if (!origin.includes('://') && scp) remote = new URL(`ssh://${scp[1]}/${scp[2]}`)
  else {
    try {
      remote = new URL(origin)
    } catch {
      throw new Error('Origin is not a supported GitLab URL.')
    }
  }
  if (!['ssh:', 'http:', 'https:'].includes(remote.protocol) || remote.hostname !== base.hostname)
    throw new Error(
      'Origin does not match the configured GitLab host. Use a canonical host instead of an SSH alias.',
    )
  // Git transport and API endpoints may use different schemes or ports.
  // Only infer the project here; API requests always use the configured instance URL.
  let path = decodeURIComponent(remote.pathname)
    .replace(/^\/+|\/+$/g, '')
    .replace(/\.git$/, '')
  const prefix = base.pathname.replace(/^\/+|\/+$/g, '')
  if (prefix && remote.protocol !== 'ssh:') {
    if (!path.startsWith(`${prefix}/`))
      throw new Error('Origin does not match the GitLab instance path.')
    path = path.slice(prefix.length + 1)
  }
  if (!path.includes('/') || path.split('/').some((part) => !part || part === '..' || part === '.'))
    throw new Error('Origin must identify a GitLab namespace and project.')
  return path
}

class GitLabHTTPError extends Error {
  constructor(readonly status: number) {
    super(
      `GitLab ${status}: ${status === 401 ? 'check your token' : status === 403 ? 'permission denied' : status === 409 ? 'MR revision changed' : 'request failed'}.`,
    )
  }
}

export class GitLabService {
  private credentials: Credentials | null = null
  private sessions = new Map<string, Session>()
  private matches = new Map<string, { project: number; mrs: MR[] }>()
  private avatars = new Map<string, Promise<string | null>>()
  private queue: Promise<unknown> = Promise.resolve()
  constructor(
    private directory: string,
    private snapshot: (id: string) => Snapshot,
    private secrets: { encrypt: (text: string) => string; decrypt: (text: string) => string },
    private openURL: (url: string) => Promise<void>,
    private request: typeof fetch = fetch,
    private copyText: (text: string) => void = () => {
      throw new Error('Clipboard is unavailable.')
    },
  ) {}

  async load() {
    try {
      this.credentials = z
        .object({
          version: z.literal(1),
          url: z.string().url(),
          encrypted: z.string(),
          caCertificate: z.string().max(100000).optional(),
          ignoreTls: z.boolean().optional(),
          serverVersion: z.string().optional(),
        })
        .parse(JSON.parse(await readFile(join(this.directory, 'gitlab.json'), 'utf8')))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw new Error(
          'GitLab credentials could not be read. Preserve gitlab.json and reconnect in Settings.',
        )
    }
  }
  private async write(path: string, value: unknown) {
    await mkdir(this.directory, { recursive: true })
    const temporary = `${path}.${randomUUID()}.tmp`
    await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' })
    await rename(temporary, path)
  }
  config(): GitLabConfig {
    return {
      url: this.credentials?.url ?? '',
      caCertificate: this.credentials?.caCertificate,
      ignoreTls: this.credentials?.ignoreTls,
      configured: !!this.credentials?.encrypted,
      version: this.credentials?.serverVersion,
    }
  }
  private async transport(url: URL, options: RequestInit, maxBytes = 50 * 1024 * 1024) {
    const credentials = this.credentials
    if (
      url.protocol === 'https:' &&
      url.origin === new URL(credentials!.url).origin &&
      (credentials?.caCertificate || credentials?.ignoreTls)
    ) {
      return new Promise<Response>((resolve, reject) => {
        const request = httpsRequest(
          url,
          {
            method: options.method,
            headers: options.headers as Record<string, string>,
            signal: options.signal!,
            rejectUnauthorized: !credentials!.ignoreTls,
            ...(credentials!.caCertificate
              ? { ca: [...rootCertificates, credentials!.caCertificate] }
              : {}),
          },
          (incoming) => {
            const chunks: Buffer[] = []
            let bytes = 0
            incoming.on('data', (chunk: Buffer) => {
              bytes += chunk.length
              if (bytes > maxBytes) request.destroy(new Error('GitLab response is too large.'))
              else chunks.push(chunk)
            })
            incoming.on('error', reject)
            incoming.on('end', () => {
              const headers = new Headers()
              for (const [name, value] of Object.entries(incoming.headers))
                if (value !== undefined)
                  headers.set(name, Array.isArray(value) ? value.join(', ') : value)
              resolve(
                new Response(incoming.statusCode === 204 ? null : Buffer.concat(chunks), {
                  status: incoming.statusCode,
                  headers,
                }),
              )
            })
          },
        )
        request.on('error', reject)
        request.end(options.body as string | undefined)
      })
    }
    return this.request(url, options)
  }
  private async api<T>(path: string, method = 'GET', data?: unknown): Promise<T> {
    if (!this.credentials?.encrypted) throw new Error('Configure GitLab in Settings first.')
    const result: unknown[] = []
    let page = '1'
    const pages = new Set<string>()
    do {
      if (pages.has(page)) throw new Error('GitLab returned a repeated pagination cursor.')
      pages.add(page)
      const url = new URL(`${this.credentials.url}/api/v4/${path}`)
      if (method === 'GET') {
        url.searchParams.set('per_page', '100')
        url.searchParams.set('page', page)
      }
      let response: Response
      try {
        const options: RequestInit = {
          method,
          redirect: 'error',
          signal: AbortSignal.timeout(30000),
          headers: {
            'PRIVATE-TOKEN': this.secrets.decrypt(this.credentials.encrypted),
            'Content-Type': 'application/json',
          },
          body: data === undefined ? undefined : JSON.stringify(data),
        }
        response = await this.transport(url, options)
      } catch {
        throw new Error(
          method === 'GET'
            ? 'GitLab could not be reached. Check your connection and TLS certificate.'
            : 'GitLab response was lost. The change may have succeeded; refresh before retrying.',
        )
      }
      if (!response.ok) throw new GitLabHTTPError(response.status)
      if (response.status === 204) return undefined as T
      const json = await response.json()
      if (!Array.isArray(json) || method !== 'GET') return json as T
      result.push(...json)
      page = response.headers.get('x-next-page') ?? ''
      if (page && !/^\d+$/.test(page)) throw new Error('Invalid GitLab pagination response.')
    } while (page)
    return result as T
  }
  private async aligned(snapshot: Snapshot, mr: MR): Promise<boolean> {
    const { base, target } = snapshot.comparison
    const refs = mr.diff_refs
    if (base.kind !== 'commit' || target.kind !== 'commit' || !refs || mr.sha !== refs.head_sha)
      return false
    if (base.ref === refs.base_sha && target.ref === refs.head_sha) return true
    // Compare changed paths, modes and complete blob identities, not commit ancestry.
    // Unchanged files outside the comparison may differ without affecting the review.
    if (
      ![base.ref, target.ref, refs.base_sha, refs.head_sha].every((ref) =>
        /^[a-f0-9]{40,64}$/.test(ref),
      )
    )
      return false
    try {
      const diffs = await Promise.all(
        [
          [base.ref, target.ref],
          [refs.base_sha, refs.head_sha],
        ].map(([oldRef, newRef]) =>
          exec(
            'git',
            [
              '-C',
              snapshot.repository,
              'diff',
              '--raw',
              '-z',
              '--no-abbrev',
              '--no-renames',
              '--ignore-submodules=none',
              '--no-ext-diff',
              '--no-textconv',
              oldRef,
              newRef,
              '--',
            ],
            { encoding: 'buffer', timeout: 10000, maxBuffer: 20 * 1024 * 1024, windowsHide: true },
          ),
        ),
      )
      return diffs[0].stdout.equals(diffs[1].stdout)
    } catch {
      // Missing remote objects cannot establish equivalence; opening the MR fetches them.
      return false
    }
  }
  private async refresh(session: Session) {
    const { review } = session
    const root = `projects/${review.mr.project_id}/merge_requests/${review.mr.iid}`
    const [mr, discussions, approvals] = await Promise.all([
      this.api<MR>(root),
      this.api<Discussion[]>(`${root}/discussions`),
      this.api<GitLabReview['approvals']>(`${root}/approvals`).then(
        (value) => ({ value, error: undefined }),
        (error: Error) => ({ value: null, error: error.message }),
      ),
    ])
    delete review.approvalBlockedReason
    if (mr.state !== 'opened') {
      review.approvalBlockedReason = 'Only open merge requests can be approved.'
    } else {
      try {
        const [user, addresses, commits] = await Promise.all([
          this.api<{ email?: string; public_email?: string; commit_email?: string }>('user'),
          this.api<{ email: string; confirmed_at: string | null }[]>('user/emails'),
          this.api<{ author_email: string; committer_email: string }[]>(`${root}/commits`),
        ])
        const emails = new Set(
          [
            user.email,
            user.public_email,
            user.commit_email,
            ...addresses.filter((address) => address.confirmed_at).map((address) => address.email),
          ]
            .filter((email): email is string => !!email && email.includes('@'))
            .map((email) => email.trim().toLowerCase()),
        )
        if (!emails.size) throw new Error('No account email addresses available.')
        if (
          commits.some((commit) =>
            [commit.author_email, commit.committer_email].some((email) =>
              emails.has(email.trim().toLowerCase()),
            ),
          )
        )
          review.approvalBlockedReason =
            'You cannot approve a merge request containing your own commits.'
      } catch {
        review.approvalBlockedReason =
          'Could not verify commit authorship. Refresh the MR before approving.'
      }
    }
    review.aligned = await this.aligned(session.snapshot, mr)
    if (review.aligned && mr.diff_refs && !isDeepStrictEqual(review.pinned, mr.diff_refs)) {
      const versions = await this.api<
        { id: number; head_commit_sha: string; base_commit_sha: string; start_commit_sha: string }[]
      >(`${root}/versions`)
      const version = versions.find(
        (version) =>
          version.head_commit_sha === mr.diff_refs!.head_sha &&
          version.base_commit_sha === mr.diff_refs!.base_sha &&
          version.start_commit_sha === mr.diff_refs!.start_sha,
      )
      if (!version) review.aligned = false
      else {
        const detail = await this.api<{ diffs: Diff[] }>(`${root}/versions/${version.id}`)
        session.diffs = detail.diffs
        review.pinned = mr.diff_refs
      }
    }
    review.reviewApps = []
    delete review.reviewAppsError
    try {
      type Environment = {
        id: number
        name: string
        external_url: string | null
        state: string
        last_deployment?: { ref: string; sha: string; status: string }
      }
      const environments = await this.api<Environment[]>(
        `projects/${mr.source_project_id}/environments?states=available`,
      )
      const details = await Promise.all(
        environments
          .filter((environment) => environment.state === 'available' && environment.external_url)
          .map((environment) =>
            this.api<Environment>(
              `projects/${mr.source_project_id}/environments/${environment.id}`,
            ),
          ),
      )
      for (const environment of details) {
        const deployment = environment.last_deployment
        if (
          environment.state !== 'available' ||
          !deployment ||
          deployment.status !== 'success' ||
          !environment.external_url
        )
          continue
        if (
          ![
            mr.source_branch,
            `refs/merge-requests/${mr.iid}/head`,
            `refs/merge-requests/${mr.iid}/merge`,
          ].includes(deployment.ref)
        )
          continue
        try {
          const url = new URL(environment.external_url)
          if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) continue
          review.reviewApps.push({ id: environment.id, name: environment.name, url: url.href })
        } catch {
          /* Environments without a usable web URL have no app actions. */
        }
      }
    } catch (error) {
      review.reviewAppsError = (error as Error).message
    }
    review.mr = mr
    review.discussions = discussions
    review.approvals = approvals.value
    review.approvalError = approvals.error
    return { review: structuredClone(review) }
  }
  private async position(session: Session, anchor: Anchor): Promise<Position> {
    const { review } = session
    if (!review.aligned) throw new Error('Open the MR revision before posting inline comments.')
    const diff = session.diffs.find(
      (file) => file.new_path === anchor.path || file.old_path === anchor.path,
    )
    if (!diff || diff.too_large || diff.collapsed)
      throw new Error('GitLab has no complete diff for this file. Post a general comment instead.')
    let oldLine = 0,
      newLine = 0
    for (const line of diff.diff.split('\n')) {
      const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
      if (hunk) {
        oldLine = Number(hunk[1])
        newLine = Number(hunk[2])
        continue
      }
      if (!oldLine && !newLine) continue
      const old = line.startsWith('-') || line.startsWith(' ')
      const added = line.startsWith('+') || line.startsWith(' ')
      if (
        (anchor.side === 'deletions' && old && oldLine === anchor.line) ||
        (anchor.side === 'additions' && added && newLine === anchor.line)
      ) {
        const position: Position = {
          position_type: 'text',
          ...review.pinned,
          old_path: diff.old_path,
          new_path: diff.new_path,
          ...(old ? { old_line: oldLine } : {}),
          ...(added ? { new_line: newLine } : {}),
        }
        if (anchor.startLine !== undefined && anchor.startLine !== anchor.line) {
          if (anchor.startLine > anchor.line)
            throw new Error('The start line must precede the end line.')
          const start = await this.position(session, {
            ...anchor,
            line: anchor.startLine,
            startLine: undefined,
          })
          const endpoints = [start, position].map((value) => ({
            line_code: `${createHash('sha1').update(diff.new_path).digest('hex')}_${value.old_line ?? 0}_${value.new_line ?? 0}`,
            type: anchor.side === 'additions' ? ('new' as const) : ('old' as const),
            ...(value.old_line ? { old_line: value.old_line } : {}),
            ...(value.new_line ? { new_line: value.new_line } : {}),
          }))
          position.line_range = { start: endpoints[0], end: endpoints[1] }
        }
        return position
      }
      if (old) oldLine++
      if (added) newLine++
    }
    throw new Error('Selected line is outside the GitLab diff. Post a general comment instead.')
  }
  private async avatar(input: Extract<GitLabRequest, { kind: 'avatar' }>): Promise<GitLabResult> {
    const session = this.sessions.get(input.session)
    if (!session || !this.credentials?.encrypted) return { avatar: null }
    this.snapshot(session.snapshot.id)
    const { review } = session
    const person = [
      review.mr.author,
      ...review.mr.reviewers,
      ...(review.mr.assignees ?? (review.mr.assignee ? [review.mr.assignee] : [])),
      ...review.discussions.flatMap((discussion) => discussion.notes.map((note) => note.author)),
      ...(review.approvals?.approved_by.map(({ user }) => user) ?? []),
    ].find((user) => user.id === input.user && user.avatar_url)
    if (!person?.avatar_url) return { avatar: null }
    const address = person.avatar_url
    let pending = this.avatars.get(address)
    if (!pending) {
      pending = (async () => {
        const url = new URL(address, this.credentials!.url + '/')
        if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null
        const headers: Record<string, string> = { Accept: 'image/*' }
        if (url.origin === new URL(this.credentials!.url).origin)
          headers['PRIVATE-TOKEN'] = this.secrets.decrypt(this.credentials!.encrypted)
        const limit = 1024 * 1024
        const response = await this.transport(
          url,
          {
            method: 'GET',
            redirect: 'error',
            signal: AbortSignal.timeout(5000),
            headers,
          },
          limit,
        )
        const mime = response.headers.get('content-type')?.split(';')[0].trim()
        if (
          !response.ok ||
          !mime ||
          !['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif'].includes(mime)
        ) {
          await response.body?.cancel()
          return null
        }
        const reader = response.body?.getReader()
        if (!reader) return null
        const chunks: Uint8Array[] = []
        let bytes = 0
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          bytes += value.length
          if (bytes > limit) {
            await reader.cancel()
            return null
          }
          chunks.push(value)
        }
        return `data:${mime};base64,${Buffer.concat(chunks).toString('base64')}`
      })().catch(() => null)
      if (this.avatars.size >= 200) this.avatars.delete(this.avatars.keys().next().value!)
      this.avatars.set(address, pending)
    }
    return { avatar: await pending }
  }
  handle(input: GitLabRequest): Promise<GitLabResult> {
    const parsed = gitlabRequestSchema.parse(input)
    if (parsed.kind === 'avatar') return this.avatar(parsed)
    const next = this.queue.then(() => this.run(parsed))
    this.queue = next.catch(() => undefined)
    return next
  }
  private async run(input: Exclude<GitLabRequest, { kind: 'avatar' }>): Promise<GitLabResult> {
    if (input.kind === 'config') return { config: this.config() }
    if (input.kind === 'configure') {
      const url = new URL(input.url)
      if (
        !['https:', 'http:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        throw new Error(
          'Use an HTTP(S) GitLab instance URL without credentials, query, or fragment.',
        )
      const previous = this.credentials
      this.credentials = {
        version: 1,
        url: url.href.replace(/\/+$/, ''),
        encrypted: this.secrets.encrypt(input.token),
        caCertificate: input.caCertificate?.trim() || undefined,
        ignoreTls: input.ignoreTls ?? false,
      }
      try {
        await this.api('user')
        const version = await this.api<{ version: string }>('version').catch(() => null)
        this.credentials.serverVersion = version?.version
        await this.write(join(this.directory, 'gitlab.json'), this.credentials)
      } catch (error) {
        this.credentials = previous
        throw error
      }
      this.sessions.clear()
      this.matches.clear()
      this.avatars.clear()
      return { config: this.config() }
    }
    if (input.kind === 'disconnect') {
      await this.write(join(this.directory, 'gitlab.json'), {
        version: 1,
        url: this.credentials?.url || 'https://gitlab.com',
        encrypted: '',
      })
      this.credentials = null
      this.sessions.clear()
      this.matches.clear()
      this.avatars.clear()
      return { config: this.config() }
    }
    if (input.kind === 'open-mr') {
      if (!this.credentials?.encrypted) throw new Error('Configure GitLab in Settings first.')
      const { stdout } = await exec(
        'git',
        ['-C', input.repository, 'config', '--get', 'remote.origin.url'],
        { timeout: 10000, windowsHide: true },
      )
      const projectPath = projectFromOrigin(stdout.trim(), this.credentials.url)
      const value = input.input.trim()
      let number = /^!?([1-9]\d*)$/.exec(value)?.[1]
      if (!number) {
        let url: URL
        try {
          url = new URL(value)
        } catch {
          throw new Error('Enter an MR ID or a GitLab merge request link.')
        }
        const match = /^(.*?)\/-\/merge_requests\/([1-9]\d*)(?:\/.*)?$/.exec(url.pathname)
        const instance = new URL(this.credentials.url)
        if (
          !match ||
          url.origin !== instance.origin ||
          url.username ||
          url.password ||
          projectFromOrigin(`${url.origin}${match[1]}`, this.credentials.url) !== projectPath
        )
          throw new Error('This MR link does not belong to the selected repository.')
        number = match[2]
      }
      const iid = Number(number)
      if (!Number.isSafeInteger(iid)) throw new Error('Enter a valid MR ID.')
      const project = await this.api<{ id: number }>(`projects/${encodeURIComponent(projectPath)}`)
      const mr = await this.api<MR>(`projects/${project.id}/merge_requests/${iid}`)
      const source =
        mr.source_project_id === project.id
          ? `refs/remotes/origin/${mr.source_branch}`
          : `refs/revui/merge-requests/${iid}/head`
      const target = `refs/remotes/origin/${mr.target_branch}`
      if (mr.state === 'opened') {
        try {
          await exec(
            'git',
            [
              '-C',
              input.repository,
              'fetch',
              'origin',
              `+refs/heads/${mr.target_branch}:${target}`,
              `+refs/merge-requests/${iid}/head:${source}`,
            ],
            { timeout: 120000, windowsHide: true },
          )
          return {
            iid,
            comparison: {
              base: { kind: 'commit', ref: `origin/${mr.target_branch}` },
              target: {
                kind: 'commit',
                ref: source.startsWith('refs/remotes/') ? source.slice(13) : source,
              },
              mode: 'merge-base',
            },
          }
        } catch {
          // GitLab may remove MR refs. The saved diff commits can still be available.
        }
      }
      // A merged MR's head may already be in today's target branch. Compare its
      // recorded diff base instead, so opening historical MRs does not yield an empty diff.
      const pinned = mr.diff_refs
      if (
        !pinned ||
        ![pinned.base_sha, pinned.head_sha].every((sha) => /^[a-f0-9]{40,64}$/i.test(sha))
      )
        throw new Error(
          `GitLab has no saved diff commits for MR !${iid}. Its branches or MR ref are no longer available.`,
        )
      for (const sha of new Set([pinned.base_sha, pinned.head_sha])) {
        const available = await exec(
          'git',
          ['-C', input.repository, 'cat-file', '-e', `${sha}^{commit}`],
          { timeout: 10000, windowsHide: true },
        ).then(
          () => true,
          () => false,
        )
        if (available) continue
        try {
          await exec('git', ['-C', input.repository, 'fetch', 'origin', sha], {
            timeout: 120000,
            windowsHide: true,
          })
          await exec('git', ['-C', input.repository, 'cat-file', '-e', `${sha}^{commit}`], {
            timeout: 10000,
            windowsHide: true,
          })
        } catch {
          throw new Error(
            `Cannot open MR !${iid}: commit ${sha} is not available locally and could not be fetched from origin. GitLab may have removed it, or access to the repository may be unavailable.`,
          )
        }
      }
      return {
        iid,
        comparison: {
          base: { kind: 'commit', ref: pinned.base_sha },
          target: { kind: 'commit', ref: pinned.head_sha },
          mode: 'merge-base',
        },
      }
    }
    if (input.kind === 'lookup') {
      const snapshot = this.snapshot(input.snapshot)
      this.matches.clear()
      this.sessions.clear()
      if ((!snapshot.branches && !input.iid) || !this.credentials?.encrypted)
        return { matches: [], config: this.config() }
      const { stdout } = await exec(
        'git',
        ['-C', snapshot.repository, 'remote', 'get-url', 'origin'],
        { timeout: 10000, windowsHide: true },
      )
      const project = await this.api<{ id: number }>(
        `projects/${encodeURIComponent(projectFromOrigin(stdout.trim(), this.credentials.url))}`,
      )
      if (input.iid) {
        const mr = await this.api<MR>(`projects/${project.id}/merge_requests/${input.iid}`)
        this.snapshot(input.snapshot)
        this.matches.set(input.snapshot, { project: project.id, mrs: [mr] })
        return { matches: [mr] }
      }
      const params = new URLSearchParams({
        state: 'opened',
        scope: 'all',
        source_branch: snapshot.branches!.source,
        target_branch: snapshot.branches!.target,
      })
      const mrs = (await this.api<MR[]>(`projects/${project.id}/merge_requests?${params}`)).filter(
        (mr) =>
          mr.source_project_id === project.id &&
          mr.source_branch === snapshot.branches!.source &&
          mr.target_branch === snapshot.branches!.target,
      )
      this.snapshot(input.snapshot)
      this.matches.set(input.snapshot, { project: project.id, mrs })
      return { matches: mrs }
    }
    if (input.kind === 'select') {
      const snapshot = this.snapshot(input.snapshot)
      const match = this.matches.get(input.snapshot)
      if (!match?.mrs.some((mr) => mr.iid === input.iid))
        throw new Error('Search for this MR again.')
      const root = `projects/${match.project}/merge_requests/${input.iid}`
      const mr = await this.api<MR>(root)
      const versions = await this.api<
        { id: number; head_commit_sha: string; base_commit_sha: string; start_commit_sha: string }[]
      >(`${root}/versions`)
      const version = versions.find(
        (version) =>
          version.head_commit_sha === mr.diff_refs?.head_sha &&
          version.base_commit_sha === mr.diff_refs?.base_sha &&
          version.start_commit_sha === mr.diff_refs?.start_sha,
      )
      if (!version || !mr.diff_refs)
        throw new Error('GitLab is still preparing this MR diff. Retry shortly.')
      const detail = await this.api<{ diffs: Diff[] }>(`${root}/versions/${version.id}`)
      const user = await this.api<{ id: number }>('user')
      const session: Session = {
        snapshot,
        diffs: detail.diffs,
        review: {
          session: randomUUID(),
          mr,
          pinned: mr.diff_refs,
          discussions: [],
          userId: user.id,
          approvals: null,
          aligned: false,
        },
      }
      this.snapshot(input.snapshot)
      this.sessions.set(session.review.session, session)
      return this.refresh(session)
    }
    const session = this.sessions.get(input.session)
    if (!session) throw new Error('This GitLab review is no longer active. Search again.')
    this.snapshot(session.snapshot.id)
    const { review } = session
    const root = `projects/${review.mr.project_id}/merge_requests/${review.mr.iid}`
    if (input.kind === 'open-app' || input.kind === 'copy-app-link') {
      const app = review.reviewApps?.find((app) => app.id === input.environment)
      if (!app) throw new Error('This review app is no longer available. Refresh the MR.')
      const url = new URL(app.url)
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
        throw new Error('Invalid review app URL.')
      if (input.kind === 'copy-app-link') this.copyText(url.href)
      else await this.openURL(url.href)
      return {}
    }
    if (input.kind === 'open-pipeline' || input.kind === 'copy-pipeline-link') {
      const address = review.mr.head_pipeline?.web_url
      if (!address) throw new Error('No pipeline is available for this MR.')
      const url = new URL(address)
      if (
        url.origin !== new URL(this.credentials!.url).origin ||
        !['http:', 'https:'].includes(url.protocol) ||
        url.username ||
        url.password
      )
        throw new Error('Pipeline URL does not match the configured instance.')
      if (input.kind === 'copy-pipeline-link') this.copyText(url.href)
      else await this.openURL(url.href)
      return {}
    }
    if (input.kind === 'open-url' || input.kind === 'copy-url') {
      const url = new URL(review.mr.web_url)
      if (url.origin !== new URL(this.credentials!.url).origin)
        throw new Error('MR URL does not match the configured instance.')
      if (input.kind === 'copy-url') this.copyText(url.href)
      else await this.openURL(url.href)
      return {}
    }
    if (input.kind === 'refresh') return this.refresh(session)
    if (input.kind === 'comment') {
      if (
        input.discussion &&
        !review.discussions.some((discussion) => discussion.id === input.discussion)
      )
        throw new Error('Discussion no longer exists.')
      if (input.discussion && input.anchor)
        throw new Error('Replies use the existing discussion anchor.')
      const latest = await this.api<MR>(root)
      if (
        latest.sha !== review.pinned.head_sha ||
        !isDeepStrictEqual(latest.diff_refs, review.pinned)
      )
        throw new Error(
          'MR revision changed. Refresh and review the current revision before posting.',
        )
      const position = input.anchor ? await this.position(session, input.anchor) : undefined
      const posted = await this.api<{ id: string | number }>(
        input.discussion
          ? `${root}/discussions/${encodeURIComponent(input.discussion)}/notes`
          : `${root}/discussions`,
        'POST',
        { body: input.body, ...(position ? { position } : {}) },
      )
      return {
        review: structuredClone(review),
        posted: true,
        discussion: input.discussion ?? (posted.id !== undefined ? String(posted.id) : undefined),
      }
    } else if (input.kind === 'approve') {
      if (input.approved) {
        await this.refresh(session)
        if (review.approvalBlockedReason) throw new Error(review.approvalBlockedReason)
        if (!review.aligned) throw new Error('Open and review the MR revision before approving.')
      }
      await this.api(
        `${root}/${input.approved ? 'approve' : 'unapprove'}`,
        'POST',
        input.approved ? { sha: review.pinned.head_sha } : {},
      )
    } else if (input.kind === 'edit' || input.kind === 'delete-note') {
      const note = review.discussions
        .find((discussion) => discussion.id === input.discussion)
        ?.notes.find((note) => note.id === input.note)
      if (!note || note.system || note.author.id !== review.userId)
        throw new Error('Only your own comments can be edited or deleted.')
      await this.api(
        `${root}/discussions/${encodeURIComponent(input.discussion)}/notes/${input.note}`,
        input.kind === 'edit' ? 'PUT' : 'DELETE',
        input.kind === 'edit' ? { body: input.body } : undefined,
      )
      if (input.kind === 'delete-note') {
        review.discussions = review.discussions
          .map((discussion) =>
            discussion.id === input.discussion
              ? { ...discussion, notes: discussion.notes.filter((note) => note.id !== input.note) }
              : discussion,
          )
          .filter((discussion) => discussion.notes.length)
      }
    } else if (input.kind === 'resolve') {
      if (
        !review.discussions
          .find((discussion) => discussion.id === input.discussion)
          ?.notes.some((note) => note.resolvable)
      )
        throw new Error('This discussion cannot be resolved.')
      await this.api(`${root}/discussions/${encodeURIComponent(input.discussion)}`, 'PUT', {
        resolved: input.resolved,
      })
    }
    // Return durable local state even when the follow-up network refresh is unavailable.
    return { review: structuredClone(review) }
  }
}
