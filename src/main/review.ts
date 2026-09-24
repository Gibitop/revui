import { createReadStream } from 'node:fs'
import { execFile, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  lstat,
  readFile,
  readlink,
  realpath,
  mkdir,
  mkdtemp,
  chmod,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { z } from 'zod'
import type {
  RevisionSuggestion,
  Comparison,
  ContentSearch,
  ContentSearchOptions,
  FileContent,
  ReviewAction,
  ReviewFile,
  ReviewRecord,
  Snapshot,
} from '../shared/review'

const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const endpoint = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('commit'),
      ref: z
        .string()
        .min(1)
        .max(1024)
        .refine((ref) => !ref.startsWith('-') && !ref.includes('\0')),
    })
    .strict(),
  z.object({ kind: z.literal('index') }).strict(),
  z.object({ kind: z.literal('working') }).strict(),
])
export const comparisonSchema = z
  .object({ base: endpoint, target: endpoint, mode: z.enum(['direct', 'merge-base']) })
  .strict()
const pathSchema = z.string().min(1).max(32768)
const bodySchema = z.string().trim().min(1).max(100000)
export const actionSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('thread'),
      path: pathSchema,
      side: z.enum(['deletions', 'additions']),
      start: z.number().int().positive(),
      end: z.number().int().positive(),
      body: bodySchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('delete-comment'),
      thread: z.string().uuid(),
      message: z.string().uuid(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('edit-comment'),
      thread: z.string().uuid(),
      message: z.string().uuid(),
      body: bodySchema,
    })
    .strict(),
  z.object({ kind: z.literal('reply'), thread: z.string().uuid(), body: bodySchema }).strict(),
  z
    .object({ kind: z.literal('resolve'), thread: z.string().uuid(), resolved: z.boolean() })
    .strict(),
  z.object({ kind: z.literal('reviewed'), path: pathSchema, reviewed: z.boolean() }).strict(),
])
const timestampSchema = z.iso
  .datetime({ offset: true })
  .refine((value) => Number.isFinite(Date.parse(value)), 'Invalid timestamp')
const recordSchema = z.object({
  version: z.literal(1),
  reviewed: z.record(z.string(), z.string()),
  threads: z.array(
    z
      .object({
        id: z.string().uuid(),
        snapshot: z.string(),
        fingerprint: z.string(),
        path: z.string(),
        side: z.enum(['deletions', 'additions']),
        start: z.number().int().positive(),
        end: z.number().int().positive(),
        resolved: z.boolean(),
        createdAt: timestampSchema.optional(),
        updatedAt: timestampSchema.optional(),
        messages: z.array(
          z
            .object({
              id: z.string().uuid(),
              body: z.string(),
              createdAt: timestampSchema,
              updatedAt: timestampSchema.optional(),
            })
            .transform((message) => ({
              ...message,
              updatedAt: message.updatedAt ?? message.createdAt,
            })),
        ),
      })
      .transform((thread) => ({
        ...thread,
        createdAt: thread.createdAt ?? thread.messages[0]?.createdAt ?? new Date(0).toISOString(),
        updatedAt:
          thread.updatedAt ?? thread.messages.at(-1)?.createdAt ?? new Date(0).toISOString(),
      })),
  ),
})
type Entry = { mode: string; oid: string }
type Active = {
  requestId: string
  files: Map<string, ReviewFile>
  snapshot: Snapshot
  tree: Map<string, Entry>
  stamps: Map<string, string>
  fingerprints: Map<string, FileContent>
  controller: AbortController
  started: number
  indexDigest: string
}

export class ReviewService {
  private active?: Active
  private pending?: { requestId: string; controller: AbortController }
  private searchController?: AbortController
  private queue: Promise<unknown> = Promise.resolve()
  constructor(private readonly directory: string) {}

  private async git(repository: string, args: string[], signal?: AbortSignal): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const child = execFile(
        'git',
        ['--no-optional-locks', '-C', repository, ...args],
        {
          encoding: 'buffer',
          maxBuffer: 256 * 1024 * 1024,
          timeout: 120000,
          windowsHide: true,
          signal,
          env: { ...process.env, GIT_LITERAL_PATHSPECS: '1', GIT_TERMINAL_PROMPT: '0' },
        },
        (error, stdout) => {
          if (
            error &&
            !(error.code === 1 && (args.includes('--no-index') || args[0] === 'merge-tree'))
          )
            reject(error)
          else resolve(stdout)
        },
      )
      child.stdin?.end()
    })
  }

  cancel(requestId?: string): void {
    if (requestId && requestId !== this.pending?.requestId && requestId !== this.active?.requestId)
      return
    this.searchController?.abort()
    this.pending?.controller.abort()
    this.pending = undefined
    this.active?.controller.abort()
    this.active = undefined
  }

  async open(
    repository: string,
    input: Comparison,
    requestId: string = randomUUID(),
    refresh = false,
  ): Promise<Snapshot> {
    const comparison = comparisonSchema.parse(input)
    if (
      comparison.base.kind === 'working' ||
      (comparison.base.kind === 'index' && comparison.target.kind !== 'working')
    )
      throw new Error('Use a commit as the base, or compare the index to the working tree.')
    if (
      comparison.mode === 'merge-base' &&
      (comparison.base.kind !== 'commit' || comparison.target.kind !== 'commit')
    )
      throw new Error('Merge-base comparison requires two commits.')
    this.cancel()
    const controller = new AbortController()
    this.pending = { requestId, controller }
    const signal = controller.signal
    const started = Date.now()
    if (refresh) await this.git(repository, ['fetch'], signal)
    for (const value of [comparison.base, comparison.target]) {
      if (value.kind !== 'commit') continue
      try {
        value.ref = (
          await this.git(
            repository,
            ['rev-parse', '--verify', '--end-of-options', `${value.ref}^{commit}`],
            signal,
          )
        )
          .toString()
          .trim()
      } catch (error) {
        // A new repository has an empty HEAD; arbitrary invalid refs still fail.
        if (value.ref !== 'HEAD') throw error
        const branch = (await this.git(repository, ['symbolic-ref', '-q', 'HEAD'], signal))
          .toString()
          .trim()
        const exists = await this.git(repository, ['show-ref', '--verify', branch], signal).then(
          () => true,
          () => false,
        )
        if (exists) throw error
        value.ref = (await this.git(repository, ['hash-object', '-t', 'tree', '--stdin'], signal))
          .toString()
          .trim()
      }
    }
    const mergeConflicts = new Set<string>()
    if (
      comparison.mode === 'merge-base' &&
      comparison.base.kind === 'commit' &&
      comparison.target.kind === 'commit'
    ) {
      const result = await this.git(
        repository,
        [
          'merge-tree',
          '--write-tree',
          '--name-only',
          '--no-messages',
          '-z',
          comparison.base.ref,
          comparison.target.ref,
        ],
        signal,
      )
      // The first field is the simulated merge tree; the remaining fields are conflict paths.
      for (const path of result.toString().split('\0').slice(1)) {
        if (path) mergeConflicts.add(path)
      }
      comparison.base.ref = (
        await this.git(
          repository,
          ['merge-base', comparison.base.ref, comparison.target.ref],
          signal,
        )
      )
        .toString()
        .trim()
      if (!comparison.base.ref) throw new Error('These commits have no common ancestor.')
    }
    const args = [
      'diff',
      '--raw',
      '-z',
      '--no-abbrev',
      '--find-renames',
      '--ignore-submodules=none',
      '--no-ext-diff',
      '--no-textconv',
    ]
    if (comparison.base.kind === 'commit') {
      if (comparison.target.kind === 'index') args.push('--cached', comparison.base.ref)
      else if (comparison.target.kind === 'commit')
        args.push(comparison.base.ref, comparison.target.ref)
      else args.push(comparison.base.ref)
    }
    args.push('--')
    const target = comparison.target
    const [raw, listing, untracked, numstat] = await Promise.all([
      this.git(repository, args, signal),
      this.git(
        repository,
        target.kind === 'commit'
          ? ['ls-tree', '-r', '-z', target.ref]
          : ['ls-files', '--stage', '-z'],
        signal,
      ),
      target.kind === 'working'
        ? this.git(repository, ['ls-files', '--others', '--exclude-standard', '-z'], signal)
        : Promise.resolve(Buffer.alloc(0)),
      this.git(
        repository,
        args.map((arg) => (arg === '--raw' ? '--numstat' : arg)),
        signal,
      ),
    ])
    const tree = new Map<string, Entry>()
    const conflicts = new Set<string>()
    for (const entry of listing.toString().split('\0')) {
      if (!entry) continue
      const tab = entry.indexOf('\t')
      const [mode, a, b] = entry.slice(0, tab).split(' ')
      if (target.kind !== 'commit' && b !== '0') conflicts.add(entry.slice(tab + 1))
      tree.set(entry.slice(tab + 1), { mode, oid: target.kind === 'commit' ? b : a })
    }
    const files = new Map<string, ReviewFile>()
    const fields = raw.toString().split('\0')
    for (let i = 0; i < fields.length && fields[i];) {
      const [oldMode, newMode, oldOid, newOid, status] = fields[i++].slice(1).split(' ')
      const oldPath = fields[i++]
      const path = /^[RC]/.test(status) ? fields[i++] : oldPath
      if (files.get(path)?.status === 'U') continue
      files.set(path, {
        additions: 0,
        deletions: 0,
        path,
        oldPath,
        status: status[0],
        oldMode,
        newMode,
        oldOid,
        newOid,
      })
      if (newMode === '000000') tree.delete(path)
      else tree.set(path, { mode: newMode, oid: newOid })
    }
    const counts = numstat.toString().split('\0')
    for (let i = 0; i < counts.length && counts[i];) {
      const entry = counts[i++]
      const first = entry.indexOf('\t'),
        second = entry.indexOf('\t', first + 1)
      let path = entry.slice(second + 1)
      if (!path) {
        i++
        path = counts[i++]
      }
      const file = files.get(path)
      if (file) {
        file.additions = entry.slice(0, first) === '-' ? null : Number(entry.slice(0, first))
        file.deletions =
          entry.slice(first + 1, second) === '-' ? null : Number(entry.slice(first + 1, second))
      }
    }
    for (const path of conflicts) {
      const file = files.get(path)
      if (file) file.status = 'U'
      else {
        const entry = tree.get(path)!
        files.set(path, {
          additions: 0,
          deletions: 0,
          path,
          oldPath: path,
          status: 'U',
          oldMode: entry.mode,
          newMode: entry.mode,
          oldOid: '',
          newOid: '',
        })
      }
    }
    for (const path of untracked.toString().split('\0').filter(Boolean)) {
      const stat = await lstat(join(repository, path))
      const mode = stat.isSymbolicLink()
        ? '120000'
        : process.platform !== 'win32' && stat.mode & 0o111
          ? '100755'
          : '100644'
      const deleted = files.get(path)
      if (deleted?.status === 'D' && (stat.isFile() || stat.isSymbolicLink())) {
        // Git treats a recreated staged deletion as untracked. Compare it with
        // the original blob, without staging it or writing repository objects.
        const temporary = await mkdtemp(join(tmpdir(), 'revui-diff-'))
        try {
          const before = join(temporary, 'before')
          await writeFile(
            before,
            deleted.oldMode === '160000'
              ? deleted.oldOid
              : await this.git(repository, ['cat-file', 'blob', deleted.oldOid], signal),
          )
          if (deleted.oldMode === '100755') await chmod(before, 0o755)
          let after = join(repository, path)
          if (stat.isSymbolicLink()) {
            const link = await readlink(after)
            after = join(temporary, 'after')
            await writeFile(after, link)
          }
          const counts = (
            await this.git(
              repository,
              [
                'diff',
                '--no-index',
                '--numstat',
                '--no-ext-diff',
                '--no-textconv',
                '--',
                before,
                after,
              ],
              signal,
            )
          )
            .toString()
            .split('\t')
          deleted.additions = counts[0] === '-' ? null : Number(counts[0] || 0)
          deleted.deletions = counts[1] === '-' ? null : Number(counts[1] || 0)
          deleted.newMode = mode
          deleted.newOid = ''
          deleted.status = deleted.oldMode.slice(0, 3) === mode.slice(0, 3) ? 'M' : 'T'
          if (counts[0] === '' && deleted.oldMode === mode) files.delete(path)
        } finally {
          await rm(temporary, { recursive: true, force: true })
        }
        tree.set(path, { mode, oid: '' })
        continue
      }
      files.set(path, {
        additions: 0,
        deletions: 0,
        path,
        oldPath: path,
        status: '?',
        oldMode: '000000',
        newMode: mode,
        oldOid: '',
        newOid: '',
      })
      const file = files.get(path)!
      if (stat.isSymbolicLink()) file.additions = 1
      else if (stat.isFile()) {
        let lines = 0,
          last = -1,
          binary = false
        for await (const chunk of createReadStream(join(repository, path), { signal })) {
          const buffer = chunk as Buffer
          if (buffer.includes(0)) {
            binary = true
            break
          }
          for (const byte of buffer) if (byte === 10) lines++
          last = buffer.at(-1) ?? last
        }
        file.additions = binary ? null : lines + (last !== -1 && last !== 10 ? 1 : 0)
        file.deletions = binary ? null : 0
      }
      tree.set(path, { mode, oid: '' })
    }
    for (const file of files.values()) {
      if (mergeConflicts.has(file.path) || mergeConflicts.has(file.oldPath))
        file.mergeConflict = true
    }
    const stamps = new Map<string, string>()
    if (target.kind === 'working') {
      for (const file of files.values()) {
        if (file.newMode === '000000') continue
        const stat = await lstat(join(repository, file.path)).catch((error) => {
          if (error.code !== 'ENOENT') throw error
          return null
        })
        if (stat && Math.floor(Math.max(stat.mtimeMs, stat.ctimeMs)) > started)
          throw new Error('Files changed while opening the comparison. Refresh to try again.')
        stamps.set(
          file.path,
          stat ? `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.ino}` : 'missing',
        )
      }
    }
    // Preserve branch identity independently from the immutable comparison endpoints.
    let branches: Snapshot['branches']
    if (input.base.kind === 'commit' && input.target.kind === 'commit') {
      const names = await Promise.all(
        [input.target.ref, input.base.ref].map(async (ref) => {
          const name = (
            await this.git(
              repository,
              ['rev-parse', '--symbolic-full-name', '--verify', '--end-of-options', ref],
              signal,
            )
          )
            .toString()
            .trim()
          if (name.startsWith('refs/heads/')) return name.slice(11)
          if (name.startsWith('refs/remotes/origin/')) return name.slice(20)
          return null
        }),
      )
      if (names[0] && names[1]) branches = { source: names[0], target: names[1] }
    }
    const key = digest(JSON.stringify({ repository, comparison }))
    const snapshot: Snapshot = {
      id: randomUUID(),
      key,
      branches,
      repository,
      comparison,
      files: [...files.values()],
      paths: [...new Set([...tree.keys(), ...files.keys()])].sort(),
      createdAt: new Date().toISOString(),
    }
    signal.throwIfAborted()
    this.active = {
      requestId,
      files,
      snapshot,
      tree,
      stamps,
      fingerprints: new Map(),
      controller,
      started,
      indexDigest: digest(listing),
    }
    // Remember user-entered refs; serialize writes so a canceled open cannot
    // overwrite a newer selection, while review identity uses resolved endpoints.
    const remember = this.queue.then(async () => {
      signal.throwIfAborted()
      await mkdir(join(this.directory, 'reviews', digest(repository)), { recursive: true })
      const recentPath = join(this.directory, 'reviews', digest(repository), 'recent.json')
      const temporary = `${recentPath}.${randomUUID()}.tmp`
      try {
        await writeFile(temporary, JSON.stringify({ version: 1, comparison: input }), {
          flag: 'wx',
          mode: 0o600,
        })
        signal.throwIfAborted()
        await rename(temporary, recentPath)
      } finally {
        await rm(temporary, { force: true })
      }
    })
    this.queue = remember.catch(() => undefined)
    await remember
    signal.throwIfAborted()
    if (this.pending?.controller === controller) this.pending = undefined
    return snapshot
  }

  gitlabSnapshot(id: string): Snapshot {
    return structuredClone(this.get(id).snapshot)
  }

  async workspaceSnapshot(id: string): Promise<Snapshot & { indexTree?: string }> {
    const active = this.get(id)
    let indexTree: string | undefined
    if (active.snapshot.comparison.target.kind === 'index') {
      if (
        digest(await this.git(active.snapshot.repository, ['ls-files', '--stage', '-z'])) !==
        active.indexDigest
      )
        throw new Error('The index changed. Compare again before preparing a workspace.')
      indexTree = (await this.git(active.snapshot.repository, ['write-tree'])).toString().trim()
      if (
        digest(await this.git(active.snapshot.repository, ['ls-files', '--stage', '-z'])) !==
        active.indexDigest
      )
        throw new Error('The index changed during preparation. Compare again.')
    }
    return { ...structuredClone(active.snapshot), indexTree }
  }

  async refs(repository: string): Promise<RevisionSuggestion[]> {
    const refs = await this.git(repository, [
      'for-each-ref',
      '--format=%(refname)	%(refname:short)',
      'refs/heads',
      'refs/remotes',
      'refs/tags',
    ])
    const commits = await this.git(repository, ['log', '-20', '--format=%h']).catch(() =>
      Buffer.alloc(0),
    )
    const result: RevisionSuggestion[] = [{ value: 'HEAD', kind: 'commit' }]
    for (const line of refs.toString().trim().split('\n').filter(Boolean)) {
      const [full, value] = line.split('\t')
      result.push({
        value,
        kind: full.startsWith('refs/tags/')
          ? 'tag'
          : full.startsWith('refs/remotes/')
            ? 'remote'
            : 'branch',
      })
    }
    for (const value of commits.toString().trim().split('\n').filter(Boolean))
      if (!result.some((item) => item.value === value)) result.push({ value, kind: 'commit' })
    return result
  }

  async search(
    id: string,
    query: string,
    paths?: string[],
    options: ContentSearchOptions = {},
  ): Promise<ContentSearch> {
    const active = this.get(id)
    this.searchController?.abort()
    const controller = new AbortController()
    this.searchController = controller
    const { snapshot } = active
    const included = paths === undefined ? undefined : new Set(paths)
    if (included?.size === 0) return { matches: [], truncated: false }
    const target = snapshot.comparison.target
    const args = [
      // Ask Git for match boundaries so highlighting uses exactly its regex/word semantics.
      '-c',
      'color.grep.match=bold',
      ...['filename', 'linenumber', 'column', 'separator', 'selected', 'context'].flatMap(
        (field) => ['-c', `color.grep.${field}=`],
      ),
      'grep',
      '-I',
      '-n',
      '-z',
      options.regex ? '-P' : '-F',
      '--no-textconv',
      '--column',
      '--no-heading',
      '--no-break',
      '--color=always',
    ]
    if (!options.matchCase) args.push('-i')
    if (options.wholeWord) args.push('-w')
    if (target.kind === 'index') args.push('--cached')
    if (target.kind === 'working') args.push('--untracked', '--exclude-standard')
    args.push('-e', query)
    if (target.kind === 'commit') args.push(target.ref)
    args.push('--')
    if (
      target.kind === 'index' &&
      digest(
        await this.git(snapshot.repository, ['ls-files', '--stage', '-z'], controller.signal),
      ) !== active.indexDigest
    )
      throw new Error('The index changed. Compare again before searching.')
    const child = spawn('git', ['--no-optional-locks', '-C', snapshot.repository, ...args], {
      windowsHide: true,
      signal: controller.signal,
      timeout: 120000,
      env: { ...process.env, GIT_LITERAL_PATHSPECS: '1', GIT_TERMINAL_PROMPT: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-8192)
    })
    let processError: Error | undefined
    child.on('error', (error) => {
      processError = error
    })
    const finished = new Promise<number | null>((resolve) => child.on('close', resolve))
    const matches: ContentSearch['matches'] = []
    const checked = new Set<string>()
    let truncated = false
    let buffered = ''
    child.stdout.setEncoding('utf8')
    try {
      search: for await (const chunk of child.stdout) {
        buffered += chunk
        while (true) {
          const pathEnd = buffered.indexOf('\0')
          const lineEnd = pathEnd < 0 ? -1 : buffered.indexOf('\0', pathEnd + 1)
          const columnEnd = lineEnd < 0 ? -1 : buffered.indexOf('\0', lineEnd + 1)
          const textEnd = columnEnd < 0 ? -1 : buffered.indexOf('\n', columnEnd + 1)
          if (textEnd < 0) break
          const name = buffered.slice(0, pathEnd)
          const path = target.kind === 'commit' ? name.slice(target.ref.length + 1) : name
          const line = Number(buffered.slice(pathEnd + 1, lineEnd))
          const column = Number(buffered.slice(lineEnd + 1, columnEnd))
          const coloredBody = buffered.slice(columnEnd + 1, textEnd)
          buffered = buffered.slice(textEnd + 1)
          if (!active.tree.has(path) || (included && !included.has(path))) continue
          if (target.kind === 'working' && !checked.has(path)) {
            const stat = await lstat(join(snapshot.repository, path))
            const stamp = `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.ino}`
            if (
              (active.stamps.has(path) && active.stamps.get(path) !== stamp) ||
              (!active.stamps.has(path) &&
                Math.floor(Math.max(stat.mtimeMs, stat.ctimeMs)) > active.started)
            )
              throw new Error('Files changed. Compare again before searching.')
            checked.add(path)
          }
          if (matches.length === 500) {
            truncated = true
            child.kill()
            break search
          }
          const ranges: { start: number; end: number }[] = []
          let body = ''
          let cursor = 0
          const startMarker = '\u001b[1m'
          const endMarker = '\u001b[m'
          while (true) {
            const start = coloredBody.indexOf(startMarker, cursor)
            const end = start < 0 ? -1 : coloredBody.indexOf(endMarker, start + startMarker.length)
            if (end < 0) break
            body += coloredBody.slice(cursor, start)
            const matchText = coloredBody.slice(start + startMarker.length, end)
            ranges.push({ start: body.length, end: body.length + matchText.length })
            body += matchText
            cursor = end + endMarker.length
          }
          body += coloredBody.slice(cursor)
          const matchOffset = Buffer.from(body)
            .subarray(0, column - 1)
            .toString().length
          const matchStart = Math.max(0, matchOffset - 80)
          const matchEnd = matchStart + query.length + 240
          matches.push({
            path,
            line,
            text: `${matchStart ? '…' : ''}${body.slice(matchStart, matchEnd)}${body.length > matchEnd ? '…' : ''}`,
            ranges: ranges
              .filter((range) => range.end > matchStart && range.start < matchEnd)
              .map((range) => ({
                start: Math.max(range.start, matchStart) - matchStart + (matchStart ? 1 : 0),
                end: Math.min(range.end, matchEnd) - matchStart + (matchStart ? 1 : 0),
              })),
          })
        }
      }
      const code = await finished
      controller.signal.throwIfAborted()
      if (processError) throw processError
      if (!truncated && code !== 0 && code !== 1)
        throw new Error(stderr.trim() || `Git search exited with code ${code}`)
      if (!truncated && buffered) throw new Error('Git returned an unreadable search result.')
    } finally {
      child.kill()
      await finished
    }
    if (
      target.kind === 'index' &&
      digest(
        await this.git(snapshot.repository, ['ls-files', '--stage', '-z'], controller.signal),
      ) !== active.indexDigest
    )
      throw new Error('The index changed while searching. Compare again.')
    controller.signal.throwIfAborted()
    this.get(id)
    return { matches, truncated }
  }

  async recent(repository: string): Promise<Comparison | null> {
    try {
      return z
        .object({ version: z.literal(1), comparison: comparisonSchema })
        .parse(
          JSON.parse(
            await readFile(
              join(this.directory, 'reviews', digest(repository), 'recent.json'),
              'utf8',
            ),
          ),
        ).comparison
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw new Error('The saved comparison could not be read. Select a new comparison.')
    }
  }

  private get(id: string): Active {
    if (!this.active || this.active.snapshot.id !== id || this.active.controller.signal.aborted)
      throw new Error('This comparison is no longer active. Refresh the review.')
    return this.active
  }

  async content(id: string, path: string, force = false): Promise<FileContent> {
    const active = this.get(id)
    const { snapshot, controller } = active
    const file = active.files.get(path)
    const entry = active.tree.get(path)
    if (!file && !entry) throw new Error('File is not part of this comparison.')
    const sides = file
      ? [
          { mode: file.oldMode, oid: file.oldOid },
          { mode: file.newMode, oid: file.newOid },
        ]
      : [null, entry!]
    let bytes = 0
    const buffers: (Buffer | null)[] = []
    let special: string | null =
      file?.status === 'U'
        ? 'Conflicted file. The index contains unmerged stages; resolve it with Git. Working-tree conflict markers are shown when available.'
        : null
    let large = false
    for (let side = 0; side < 2; side++) {
      const value = sides[side]
      if (
        !value ||
        value.mode === '000000' ||
        (file?.status === 'U' && (side === 0 || snapshot.comparison.target.kind === 'index'))
      ) {
        buffers.push(null)
        continue
      }
      if (value.mode === '160000') {
        special =
          'Submodule reference. Working-tree submodule changes may include uncommitted content.'
        buffers.push(
          Buffer.from(
            /^0*$/.test(value.oid) ? 'Working-tree submodule (modified content)' : value.oid,
          ),
        )
        continue
      }
      if (value.mode === '120000')
        special = 'Symbolic link: showing the link target without following it.'
      let buffer: Buffer
      if (side === 1 && snapshot.comparison.target.kind === 'working') {
        const absolute = join(snapshot.repository, path)
        const parent = await realpath(dirname(absolute))
        const relativeParent = relative(snapshot.repository, parent)
        if (
          relativeParent === '..' ||
          relativeParent.startsWith(`..${sep}`) ||
          isAbsolute(relativeParent)
        )
          throw new Error('File parent resolves outside the repository.')
        const stat = await lstat(absolute)
        const stamp = `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.ino}`
        if (
          (active.stamps.has(path) && active.stamps.get(path) !== stamp) ||
          (!active.stamps.has(path) &&
            Math.floor(Math.max(stat.mtimeMs, stat.ctimeMs)) > active.started)
        )
          throw new Error(
            'File changed since this comparison was opened. Refresh to review its current content.',
          )
        if (!stat.isFile() && !stat.isSymbolicLink()) {
          special = 'Directory or special filesystem entry; no regular file content.'
          buffers.push(null)
          continue
        }
        bytes += stat.size
        if (stat.size > 1024 * 1024 && !force) {
          large = true
          buffers.push(null)
          continue
        }
        buffer = stat.isSymbolicLink()
          ? Buffer.from(await readlink(absolute))
          : await readFile(absolute)
        const after = await lstat(absolute)
        if (`${after.size}:${after.mtimeMs}:${after.ctimeMs}:${after.ino}` !== stamp)
          throw new Error('File changed while loading. Refresh the comparison.')
      } else {
        if (!value.oid || /^0+$/.test(value.oid)) {
          buffers.push(null)
          continue
        }
        const size = Number(
          (
            await this.git(snapshot.repository, ['cat-file', '-s', value.oid], controller.signal)
          ).toString(),
        )
        bytes += size
        if (size > 1024 * 1024 && !force) {
          large = true
          buffers.push(null)
          continue
        }
        buffer = await this.git(
          snapshot.repository,
          ['cat-file', 'blob', value.oid],
          controller.signal,
        )
      }
      buffers.push(buffer)
    }
    let binary = buffers.some((buffer) => buffer?.includes(0))
    const texts = buffers.map((buffer) => {
      if (!buffer) return null
      try {
        return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer)
      } catch {
        binary = true
        return null
      }
    })
    const lines = texts.map((value) =>
      value === null || value === ''
        ? 0
        : value.split('\n').length - (value.endsWith('\n') ? 1 : 0),
    )
    if (!force && lines.some((count) => count > 20000)) large = true
    const fingerprint = digest(
      JSON.stringify({ sides, hashes: buffers.map((buffer) => (buffer ? digest(buffer) : null)) }),
    )
    const result: FileContent = {
      oldFile:
        binary || large || texts[0] === null
          ? null
          : { name: file?.oldPath ?? path, contents: texts[0], cacheKey: `${fingerprint}:old` },
      newFile:
        binary || large || texts[1] === null
          ? null
          : { name: path, contents: texts[1], cacheKey: `${fingerprint}:new` },
      fingerprint,
      summary: binary
        ? 'Binary or non-UTF-8 file. Text diff is unavailable.'
        : large
          ? 'Large file. Load explicitly to see the complete content.'
          : special,
      large,
      bytes,
      oldLines: lines[0],
      newLines: lines[1],
    }
    this.get(id)
    if (!large) active.fingerprints.set(path, result)
    return result
  }

  async records(id: string): Promise<ReviewRecord> {
    const { snapshot } = this.get(id)
    const path = join(
      this.directory,
      'reviews',
      digest(snapshot.repository),
      `${snapshot.key}.json`,
    )
    try {
      return recordSchema.parse(JSON.parse(await readFile(path, 'utf8')))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return { version: 1, threads: [], reviewed: {} }
      throw new Error(
        'Review records are unreadable or from an unsupported version. The original file has been preserved; no records were overwritten.',
      )
    }
  }

  update(id: string, input: ReviewAction): Promise<ReviewRecord> {
    const action = actionSchema.parse(input)
    const operation = this.queue.then(async () => {
      const active = this.get(id)
      const record = await this.records(id)
      const now = new Date().toISOString()
      if (action.kind === 'thread' || action.kind === 'reviewed') {
        const loaded = active.fingerprints.get(action.path)
        if (!loaded) throw new Error('Load this file before adding a review record.')
        const current = await this.content(id, action.path, true)
        if (current.fingerprint !== loaded.fingerprint)
          throw new Error('File content changed. Refresh the comparison before reviewing.')
        if (action.kind === 'reviewed') {
          if (action.reviewed) record.reviewed[action.path] = current.fingerprint
          else delete record.reviewed[action.path]
        } else {
          const lines = action.side === 'deletions' ? current.oldLines : current.newLines
          if (
            action.end < action.start ||
            action.end > lines ||
            current.summary?.startsWith('Binary')
          )
            throw new Error('Select an existing line range on this side of the file.')
          record.threads.push({
            id: randomUUID(),
            snapshot: id,
            fingerprint: current.fingerprint,
            path: action.path,
            side: action.side,
            start: action.start,
            end: action.end,
            resolved: false,
            createdAt: now,
            updatedAt: now,
            messages: [{ id: randomUUID(), body: action.body, createdAt: now, updatedAt: now }],
          })
        }
      } else {
        const thread = record.threads.find((thread) => thread.id === action.thread)
        if (!thread) throw new Error('Thread does not exist in this review.')
        thread.updatedAt = now
        if (action.kind === 'delete-comment') {
          if (!thread.messages.some((message) => message.id === action.message))
            throw new Error('Comment does not exist in this thread.')
          thread.messages = thread.messages.filter((message) => message.id !== action.message)
          if (!thread.messages.length)
            record.threads = record.threads.filter((item) => item.id !== thread.id)
        } else if (action.kind === 'edit-comment') {
          const message = thread.messages.find((message) => message.id === action.message)
          if (!message) throw new Error('Comment does not exist in this thread.')
          message.body = action.body
          message.updatedAt = now
        } else if (action.kind === 'resolve') thread.resolved = action.resolved
        else
          thread.messages.push({
            id: randomUUID(),
            body: action.body,
            createdAt: now,
            updatedAt: now,
          })
      }
      const path = join(
        this.directory,
        'reviews',
        digest(active.snapshot.repository),
        `${active.snapshot.key}.json`,
      )
      const temporary = `${path}.${randomUUID()}.tmp`
      try {
        await writeFile(temporary, JSON.stringify(record), { flag: 'wx', mode: 0o600 })
        await rename(temporary, path)
      } finally {
        await rm(temporary, { force: true })
      }
      return record
    })
    this.queue = operation.catch(() => undefined)
    return operation
  }
}
