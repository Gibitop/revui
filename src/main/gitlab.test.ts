import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GitLabService, projectFromOrigin } from './gitlab'
import type { MR } from '../shared/gitlab'
import type { Snapshot } from '../shared/review'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})
const refs = { base_sha: 'a'.repeat(40), head_sha: 'b'.repeat(40), start_sha: 'c'.repeat(40) }
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'revui-gitlab-'))
  dirs.push(directory)
  await promisify(execFile)('git', ['init', directory])
  await promisify(execFile)('git', [
    '-C',
    directory,
    'remote',
    'add',
    'origin',
    'git@gitlab.example.com:group/nested/repo.git',
  ])
  const snapshot: Snapshot = {
    id: 'snapshot',
    key: 'key',
    repository: directory,
    branches: { source: 'feature/a', target: 'main' },
    comparison: {
      base: { kind: 'commit', ref: refs.base_sha },
      target: { kind: 'commit', ref: refs.head_sha },
      mode: 'merge-base',
    },
    files: [],
    paths: [],
    createdAt: '',
  }
  const mr: MR = {
    iid: 7,
    project_id: 12,
    source_project_id: 12,
    title: 'Review this',
    description: 'Description',
    web_url: 'https://gitlab.example.com/group/nested/repo/-/merge_requests/7',
    source_branch: 'feature/a',
    target_branch: 'main',
    state: 'opened',
    draft: false,
    labels: ['test'],
    author: { id: 4, name: 'Author' },
    reviewers: [],
    sha: refs.head_sha,
    diff_refs: { ...refs },
    head_pipeline: null,
  }
  const user = {
    id: 4,
    email: 'reviewer@example.com',
    public_email: '',
    commit_email: 'private@example.com',
  }
  const emails = [{ email: 'alias@example.com', confirmed_at: '2026-01-01' }]
  const commits = [{ author_email: 'someone@example.com', committer_email: 'someone@example.com' }]
  const environments: {
    id: number
    name: string
    external_url: string
    state: string
    last_deployment: { ref: string; sha: string; status: string }
  }[] = []
  const opened: string[] = []
  const copied: string[] = []
  let posts = 0
  let failAt = 0
  let offline = false
  let denied = ''
  const requests: { url: URL; method: string; body: Record<string, unknown> }[] = []
  const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input)),
      method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : {}
    requests.push({ url, method, body })
    if (offline) throw new Error('offline secret-token must never leak')
    expect(init?.redirect).toBe('error')
    if (url.pathname.startsWith('/avatars/')) {
      expect((init?.headers as Record<string, string>)['PRIVATE-TOKEN']).toBe(
        url.origin === 'https://gitlab.example.com' ? 'secret-token' : undefined,
      )
      return new Response(url.pathname.endsWith('huge') ? Buffer.alloc(1024 * 1024 + 1) : 'image', {
        headers: { 'Content-Type': url.pathname.endsWith('html') ? 'text/html' : 'image/png' },
      })
    }
    expect((init?.headers as Record<string, string>)['PRIVATE-TOKEN']).toBe('secret-token')
    const path = decodeURIComponent(url.pathname).replace('/api/v4/', '')
    if (denied && path.endsWith(denied)) return new Response('{}', { status: 403 })
    let value: unknown
    const headers: Record<string, string> = {}
    if (method === 'POST' && path.endsWith('/discussions')) {
      posts++
      if (posts === failAt) throw new Error('lost response')
      value = { id: `discussion-${posts}` }
    } else if (method !== 'GET') value = {}
    else if (path === 'user') value = user
    else if (path === 'user/emails') value = emails
    else if (path.endsWith('/commits')) value = commits
    else if (path.endsWith('/environments')) value = environments
    else if (/\/environments\/\d+$/.test(path))
      value = environments.find((environment) => environment.id === Number(path.split('/').at(-1)))
    else if (path === 'version') value = { version: '18.0.0' }
    else if (path === 'projects/group/nested/repo') value = { id: 12 }
    else if (path.endsWith('/merge_requests')) {
      if (url.searchParams.has('source_branch')) {
        expect(url.searchParams.get('source_branch')).toBe('feature/a')
        expect(url.searchParams.get('target_branch')).toBe('main')
      }
      if (url.searchParams.get('page') === '1') {
        value = [{ ...mr, iid: 8, source_project_id: 99 }]
        headers['x-next-page'] = '2'
      } else value = [mr]
    } else if (path.endsWith('/versions'))
      value = [
        {
          id: 10,
          head_commit_sha: mr.diff_refs!.head_sha,
          base_commit_sha: mr.diff_refs!.base_sha,
          start_commit_sha: mr.diff_refs!.start_sha,
        },
      ]
    else if (path.endsWith('/versions/10'))
      value = {
        diffs: [
          {
            old_path: 'old.ts',
            new_path: 'new.ts',
            diff: '@@ -1,2 +1,2 @@\n context\n-before\n+after',
          },
        ],
      }
    else if (path.endsWith('/discussions'))
      value = [
        {
          id: 'thread',
          individual_note: false,
          notes: [
            {
              id: 21,
              author: { id: 4, name: 'Author' },
              body: 'note',
              system: false,
              resolvable: true,
              resolved: false,
              updated_at: '',
              position: {
                ...refs,
                head_sha: 'old',
                position_type: 'text',
                old_path: 'old.ts',
                new_path: 'new.ts',
                new_line: 2,
              },
            },
          ],
        },
      ]
    else if (path.endsWith('/approvals')) value = { approved: false, approved_by: [] }
    else value = mr
    return new Response(JSON.stringify(value), { headers })
  }) as typeof fetch
  const secrets = {
    encrypt: (text: string) => Buffer.from(text).toString('base64'),
    decrypt: (text: string) => Buffer.from(text, 'base64').toString(),
  }
  const create = () =>
    new GitLabService(
      directory,
      (id) => {
        if (id !== snapshot.id) throw new Error('Stale snapshot')
        return structuredClone(snapshot)
      },
      secrets,
      async (url) => {
        opened.push(url)
      },
      fetcher,
      (text) => {
        copied.push(text)
      },
    )
  const service = create()
  await service.load()
  await service.handle({
    kind: 'configure',
    url: 'https://gitlab.example.com',
    token: 'secret-token',
  })
  const select = async (target = service) => {
    await target.handle({ kind: 'lookup', snapshot: snapshot.id })
    return (await target.handle({ kind: 'select', snapshot: snapshot.id, iid: 7 })).review!
  }
  return {
    commits,
    emails,
    user,
    service,
    environments,
    opened,
    copied,
    deny: (path: string) => {
      denied = path
    },
    create,
    select,
    snapshot,
    mr,
    requests,
    directory,
    failure: (at: number) => {
      failAt = at
    },
    offline: (value: boolean) => {
      offline = value
    },
    posts: () => posts,
  }
}

describe('GitLab review', () => {
  it('loads and caches avatars, sending credentials only to the GitLab origin', async () => {
    const f = await fixture()
    for (const origin of ['https://gitlab.example.com', 'https://avatars.example.com']) {
      f.mr.author.avatar_url = `${origin}/avatars/author`
      const review = await f.select()
      const request = { kind: 'avatar' as const, session: review.session, user: 4 }
      expect(await f.service.handle(request)).toEqual({ avatar: 'data:image/png;base64,aW1hZ2U=' })
      await f.service.handle(request)
      expect(f.requests.filter(({ url }) => url.href === f.mr.author.avatar_url)).toHaveLength(1)
      expect(await f.service.handle({ ...request, user: 999 })).toEqual({ avatar: null })
      await f.service.handle({ kind: 'lookup', snapshot: f.snapshot.id })
      expect(await f.service.handle(request)).toEqual({ avatar: null })
    }
  })

  it('falls back for absent, unsafe, non-image, oversized, and unavailable avatars', async () => {
    const f = await fixture()
    for (const address of [
      null,
      'file:///avatars/author',
      'https://gitlab.example.com/avatars/html',
      'https://gitlab.example.com/avatars/huge',
    ]) {
      f.mr.author.avatar_url = address
      const review = await f.select()
      expect(await f.service.handle({ kind: 'avatar', session: review.session, user: 4 })).toEqual({
        avatar: null,
      })
    }
    f.mr.author.avatar_url = 'https://gitlab.example.com/avatars/offline'
    const review = await f.select()
    f.offline(true)
    expect(await f.service.handle({ kind: 'avatar', session: review.session, user: 4 })).toEqual({
      avatar: null,
    })
  })

  it('allows equivalent comparisons across different commits and blocks actual changes', async () => {
    const f = await fixture()
    const git = async (...args: string[]) =>
      (
        await promisify(execFile)('git', [
          '-C',
          f.directory,
          '-c',
          'user.name=Test',
          '-c',
          'user.email=test@example.com',
          '-c',
          'commit.gpgsign=false',
          ...args,
        ])
      ).stdout.trim()
    await writeFile(join(f.directory, 'file.txt'), 'before\n')
    await git('add', 'file.txt')
    await git('commit', '-m', 'base')
    const base = await git('rev-parse', 'HEAD')
    await writeFile(join(f.directory, 'file.txt'), 'after\n')
    await git('commit', '-am', 'change')
    const head = await git('rev-parse', 'HEAD')
    f.snapshot.comparison = {
      base: { kind: 'commit', ref: base },
      target: { kind: 'commit', ref: head },
      mode: 'direct',
    }
    f.mr.diff_refs = { base_sha: base, head_sha: head, start_sha: base }
    f.mr.sha = head
    expect((await f.select()).aligned).toBe(true)

    await git('commit', '--allow-empty', '-m', 'metadata only')
    const emptyHead = await git('rev-parse', 'HEAD')
    f.mr.diff_refs.head_sha = emptyHead
    f.mr.sha = emptyHead
    const review = await f.select()
    expect(review.aligned).toBe(true)
    await f.service.handle({ kind: 'approve', session: review.session, approved: true })
    expect(f.requests.at(-1)?.body).toEqual({ sha: emptyHead })

    // A rebase changes both commits and an unrelated file, but preserves the comparison.
    await git('checkout', '--detach', base)
    await writeFile(join(f.directory, 'unrelated.txt'), 'target advanced\n')
    await git('add', 'unrelated.txt')
    await git('commit', '-m', 'unrelated target change')
    const remoteBase = await git('rev-parse', 'HEAD')
    await writeFile(join(f.directory, 'file.txt'), 'after\n')
    await git('commit', '-am', 'same change rebased')
    const remoteHead = await git('rev-parse', 'HEAD')
    f.mr.diff_refs = { base_sha: remoteBase, head_sha: remoteHead, start_sha: remoteBase }
    f.mr.sha = remoteHead
    const refreshed = (await f.service.handle({ kind: 'refresh', session: review.session })).review!
    expect(refreshed.aligned).toBe(true)
    expect(refreshed.pinned.head_sha).toBe(remoteHead)
    await f.service.handle({ kind: 'approve', session: review.session, approved: true })
    expect(f.requests.at(-1)?.body).toEqual({ sha: remoteHead })

    await writeFile(join(f.directory, 'file.txt'), 'different change\n')
    await git('commit', '-am', 'actual difference')
    f.mr.sha = await git('rev-parse', 'HEAD')
    f.mr.diff_refs.head_sha = f.mr.sha
    const approvals = f.requests.filter(({ url }) => url.pathname.endsWith('/approve')).length
    await expect(
      f.service.handle({ kind: 'approve', session: review.session, approved: true }),
    ).rejects.toThrow('Open and review')
    expect(f.requests.filter(({ url }) => url.pathname.endsWith('/approve'))).toHaveLength(
      approvals,
    )
    expect(
      (await f.service.handle({ kind: 'refresh', session: review.session })).review?.aligned,
    ).toBe(false)

    f.mr.sha = 'f'.repeat(40)
    f.mr.diff_refs.head_sha = f.mr.sha
    expect((await f.select()).aligned).toBe(false)
  })

  it('posts multiline positions directly and rejects invalid ranges', async () => {
    const f = await fixture(),
      review = await f.select()
    const result = await f.service.handle({
      kind: 'comment',
      session: review.session,
      body: 'suggestion',
      anchor: { path: 'new.ts', side: 'additions', startLine: 1, line: 2 },
    })
    expect(result.posted).toBe(true)
    expect(f.requests.at(-1)?.body.position).toMatchObject({
      line_range: { start: { type: 'new', new_line: 1 }, end: { type: 'new', new_line: 2 } },
    })
    await expect(
      f.service.handle({
        kind: 'comment',
        session: review.session,
        body: 'invalid',
        anchor: { path: 'new.ts', side: 'additions', startLine: 3, line: 2 },
      }),
    ).rejects.toThrow('start line')
  })

  it('discovers nested projects and rejects aliases and mismatched origins', () => {
    for (const origin of [
      'git@gitlab.example.com:group/nested/repo.git',
      'ssh://git@gitlab.example.com:2222/group/nested/repo.git',
      'https://gitlab.example.com/group/nested/repo.git',
      'http://gitlab.example.com/group/nested/repo.git',
      'http://gitlab.example.com:8080/group/nested/repo.git',
      'https://gitlab.example.com:8443/group/nested/repo.git',
    ])
      expect(projectFromOrigin(origin, 'https://gitlab.example.com')).toBe('group/nested/repo')
    expect(
      projectFromOrigin(
        'https://gitlab.example.com/gitlab/group/repo.git',
        'https://gitlab.example.com/gitlab',
      ),
    ).toBe('group/repo')
    expect(() =>
      projectFromOrigin('git@alias:group/repo.git', 'https://gitlab.example.com'),
    ).toThrow('alias')
    expect(
      projectFromOrigin(
        'https://gitlab.example.com/group/repo.git',
        'http://gitlab.example.com:8080',
      ),
    ).toBe('group/repo')
    expect(
      projectFromOrigin(
        'http://gitlab.example.com:8080/gitlab/group/repo.git',
        'https://gitlab.example.com:8443/gitlab',
      ),
    ).toBe('group/repo')
    expect(() =>
      projectFromOrigin('https://other.example.com/group/repo.git', 'https://gitlab.example.com'),
    ).toThrow('host')
    expect(() =>
      projectFromOrigin(
        'https://gitlab.example.com/group/repo.git',
        'https://gitlab.example.com/gitlab',
      ),
    ).toThrow('instance path')
  })
  it('uses the configured API endpoint when the HTTP clone URL has a different scheme and port', async () => {
    const f = await fixture()
    await promisify(execFile)('git', [
      '-C',
      f.directory,
      'remote',
      'set-url',
      'origin',
      'http://gitlab.example.com:8080/group/nested/repo.git',
    ])
    await f.service.handle({
      kind: 'configure',
      url: 'https://gitlab.example.com:8443',
      token: 'secret-token',
    })
    f.requests.length = 0
    const result = await f.service.handle({ kind: 'lookup', snapshot: f.snapshot.id })
    expect(result.matches?.map((mr) => mr.iid)).toEqual([7])
    expect(f.requests.length).toBeGreaterThan(0)
    expect(f.requests.every(({ url }) => url.origin === 'https://gitlab.example.com:8443')).toBe(
      true,
    )
  })
  it('paginates exact branch-pair matches, filters forks, and never returns tokens', async () => {
    const f = await fixture()
    const result = await f.service.handle({ kind: 'lookup', snapshot: f.snapshot.id })
    expect(result.matches?.map((mr) => mr.iid)).toEqual([7])
    expect(await readFile(join(f.directory, 'gitlab.json'), 'utf8')).not.toContain('secret-token')
    expect(JSON.stringify(await f.service.handle({ kind: 'config' }))).not.toContain('secret-token')
    f.snapshot.branches = undefined
    expect((await f.service.handle({ kind: 'lookup', snapshot: f.snapshot.id })).matches).toEqual(
      [],
    )
  })
  it('uses version refs and renamed paths for inline positions; rejects unanchored lines', async () => {
    const f = await fixture(),
      review = await f.select()
    expect(review.discussions[0].notes[0].position?.head_sha).toBe('old')
    const result = await f.service.handle({
      kind: 'comment',
      session: review.session,
      body: 'inline',
      anchor: { path: 'new.ts', side: 'additions', line: 2 },
    })
    expect(result.posted).toBe(true)
    expect(f.requests.at(-1)?.body.position).toEqual({
      ...refs,
      position_type: 'text',
      old_path: 'old.ts',
      new_path: 'new.ts',
      new_line: 2,
    })
    await expect(
      f.service.handle({
        kind: 'comment',
        session: review.session,
        body: 'invalid',
        anchor: { path: 'new.ts', side: 'additions', line: 300 },
      }),
    ).rejects.toThrow('outside')
    expect(f.posts()).toBe(1)
  })

  it('opens and copies the current pipeline URL, rejecting foreign origins and missing pipelines', async () => {
    const f = await fixture()
    f.mr.head_pipeline = {
      status: 'running',
      web_url: 'https://gitlab.example.com/group/repo/-/pipelines/42',
    }
    let review = await f.select()
    await f.service.handle({ kind: 'open-pipeline', session: review.session })
    await f.service.handle({ kind: 'copy-pipeline-link', session: review.session })
    expect(f.opened).toEqual([f.mr.head_pipeline.web_url])
    expect(f.copied).toEqual([f.mr.head_pipeline.web_url])
    f.mr.head_pipeline.web_url = 'https://other.example.com/pipeline'
    review = await f.select()
    await expect(
      f.service.handle({ kind: 'open-pipeline', session: review.session }),
    ).rejects.toThrow('configured instance')
    await expect(
      f.service.handle({ kind: 'copy-pipeline-link', session: review.session }),
    ).rejects.toThrow('configured instance')
    f.mr.head_pipeline = null
    review = await f.select()
    await expect(
      f.service.handle({ kind: 'open-pipeline', session: review.session }),
    ).rejects.toThrow('No pipeline')
  })

  it('finds deployed branch review apps and opens only validated app URLs', async () => {
    const f = await fixture()
    const app = {
      id: 1,
      name: 'review/feature-a',
      external_url: 'https://preview.example.com/app',
      state: 'available',
      last_deployment: { ref: 'feature/a', sha: refs.head_sha, status: 'success' },
    }
    f.environments.push(
      app,
      { ...app, id: 2, external_url: 'javascript:alert(1)' },
      { ...app, id: 3, state: 'stopped' },
      { ...app, id: 4, last_deployment: { ...app.last_deployment, ref: 'main' } },
      { ...app, id: 5, external_url: 'https://user:password@preview.example.com' },
      { ...app, id: 6, last_deployment: { ...app.last_deployment, status: 'failed' } },
      {
        ...app,
        id: 7,
        name: 'second app',
        last_deployment: { ...app.last_deployment, ref: 'refs/merge-requests/7/head' },
      },
    )
    const review = await f.select()
    expect(review.reviewApps?.map((app) => app.id)).toEqual([1, 7])
    await f.service.handle({ kind: 'open-app', session: review.session, environment: 1 })
    expect(f.opened).toEqual(['https://preview.example.com/app'])
    await f.service.handle({ kind: 'copy-app-link', session: review.session, environment: 1 })
    expect(f.copied).toEqual(['https://preview.example.com/app'])
    await expect(
      f.service.handle({ kind: 'open-app', session: review.session, environment: 2 }),
    ).rejects.toThrow('no longer available')
    f.deny('/environments')
    const refreshed = (await f.service.handle({ kind: 'refresh', session: review.session })).review!
    expect(refreshed.reviewApps).toEqual([])
    expect(refreshed.reviewAppsError).toContain('permission denied')
    expect(refreshed.mr.iid).toBe(7)
  })

  it('confirms successful posting and surfaces failures without retrying or storing drafts', async () => {
    const f = await fixture(),
      review = await f.select()
    const request = { kind: 'comment' as const, session: review.session, body: 'upload' }
    f.failure(1)
    await expect(f.service.handle(request)).rejects.toThrow('may have succeeded')
    expect(f.posts()).toBe(1)
    expect((await f.service.handle({ ...request, body: 'another comment' })).posted).toBe(true)
    f.mr.sha = 'd'.repeat(40)
    await expect(f.service.handle(request)).rejects.toThrow('revision changed')
    expect(f.posts()).toBe(2)
  })

  it('deletes only owned comments and removes them from the returned discussion state', async () => {
    const f = await fixture()
    const review = await f.select()
    await expect(
      f.service.handle({
        kind: 'delete-note',
        session: review.session,
        discussion: 'thread',
        note: 999,
      }),
    ).rejects.toThrow('Only your own')
    expect(f.requests.filter(({ method }) => method === 'DELETE')).toHaveLength(0)
    const result = await f.service.handle({
      kind: 'delete-note',
      session: review.session,
      discussion: 'thread',
      note: 21,
    })
    expect(result.review?.discussions).toHaveLength(0)
    expect(f.requests.at(-1)?.method).toBe('DELETE')
    expect(f.requests.at(-1)?.url.pathname).toBe(
      '/api/v4/projects/12/merge_requests/7/discussions/thread/notes/21',
    )
  })

  it.each(['closed', 'merged'])(
    'rejects approval when an MR becomes %s after loading',
    async (state) => {
      const f = await fixture()
      const review = await f.select()
      expect(review.approvalBlockedReason).toBeUndefined()
      f.mr.state = state
      await expect(
        f.service.handle({ kind: 'approve', session: review.session, approved: true }),
      ).rejects.toThrow('Only open merge requests')
      expect(
        f.requests.filter(
          ({ url, method }) => method === 'POST' && url.pathname.endsWith('/approve'),
        ),
      ).toHaveLength(0)
      expect(
        (await f.service.handle({ kind: 'refresh', session: review.session })).review
          ?.approvalBlockedReason,
      ).toContain('Only open')
    },
  )

  it.each([
    ['author_email', ' REVIEWER@EXAMPLE.COM '],
    ['author_email', 'alias@example.com'],
    ['committer_email', 'private@example.com'],
  ] as const)('blocks own commits matched by %s and account email %s', async (field, email) => {
    const f = await fixture()
    const review = await f.select()
    f.commits[0][field] = email
    await expect(
      f.service.handle({ kind: 'approve', session: review.session, approved: true }),
    ).rejects.toThrow('your own commits')
    expect(
      f.requests.filter(
        ({ url, method }) => method === 'POST' && url.pathname.endsWith('/approve'),
      ),
    ).toHaveLength(0)
    const refreshed = await f.service.handle({ kind: 'refresh', session: review.session })
    expect(refreshed.review?.approvalBlockedReason).toContain('your own commits')
    await f.service.handle({ kind: 'approve', session: review.session, approved: false })
    expect(
      f.requests.some(
        ({ url, method }) => method === 'POST' && url.pathname.endsWith('/unapprove'),
      ),
    ).toBe(true)
    f.commits[0][field] = 'someone@example.com'
    expect(
      (await f.service.handle({ kind: 'refresh', session: review.session })).review
        ?.approvalBlockedReason,
    ).toBeUndefined()
  })

  it.each(['/commits', 'user/emails'])(
    'blocks approval if authorship cannot be checked using %s',
    async (endpoint) => {
      const f = await fixture()
      const review = await f.select()
      f.deny(endpoint)
      await expect(
        f.service.handle({ kind: 'approve', session: review.session, approved: true }),
      ).rejects.toThrow('Could not verify commit authorship')
      expect(
        f.requests.filter(
          ({ url, method }) => method === 'POST' && url.pathname.endsWith('/approve'),
        ),
      ).toHaveLength(0)
    },
  )

  it('guards approval SHA, editing ownership, stale sessions and permissions', async () => {
    const f = await fixture(),
      review = await f.select()
    await f.service.handle({ kind: 'approve', session: review.session, approved: true })
    expect(f.requests.find((request) => request.url.pathname.endsWith('/approve'))?.body).toEqual({
      sha: refs.head_sha,
    })
    await expect(
      f.service.handle({
        kind: 'edit',
        session: review.session,
        discussion: 'thread',
        note: 22,
        body: 'other author',
      }),
    ).rejects.toThrow('own comments')
    await f.service.handle({
      kind: 'edit',
      session: review.session,
      discussion: 'thread',
      note: 21,
      body: 'edited',
    })
    await f.service.handle({
      kind: 'resolve',
      session: review.session,
      discussion: 'thread',
      resolved: true,
    })
    f.snapshot.id = 'new'
    await expect(
      f.service.handle({ kind: 'approve', session: review.session, approved: true }),
    ).rejects.toThrow('Stale snapshot')
  })
})

it('surfaces permission failures separately from missing MRs and degrades unavailable approvals', async () => {
  const f = await fixture()
  f.deny('/merge_requests')
  await expect(f.service.handle({ kind: 'lookup', snapshot: f.snapshot.id })).rejects.toThrow(
    'permission denied',
  )
  f.deny('/approvals')
  const review = await f.select()
  expect(review.approvals).toBeNull()
  expect(review.approvalError).toContain('permission denied')
  expect(review.discussions).toHaveLength(1)
  f.deny('/discussions')
  await expect(
    f.service.handle({ kind: 'comment', session: review.session, body: 'keep on failure' }),
  ).rejects.toThrow('permission denied')
})

describe('list open MRs for a repository', () => {
  it('includes fork MRs and all pages without branch filters or clearing the active review', async () => {
    const f = await fixture()
    const review = await f.select()
    const result = await f.service.handle({ kind: 'list-mrs', repository: f.directory })
    expect(result.matches?.map((mr) => mr.iid)).toEqual([8, 7])
    const request = f.requests.at(-1)!.url
    expect(request.pathname).toBe('/api/v4/projects/12/merge_requests')
    expect(Object.fromEntries(request.searchParams)).toMatchObject({
      state: 'opened',
      scope: 'all',
      order_by: 'updated_at',
      sort: 'desc',
      page: '2',
    })
    expect(request.searchParams.has('source_branch')).toBe(false)
    expect(request.searchParams.has('target_branch')).toBe(false)
    expect(
      (await f.service.handle({ kind: 'refresh', session: review.session })).review?.mr.iid,
    ).toBe(7)
  })

  it('requires configuration and reports API failures', async () => {
    const f = await fixture()
    f.deny('/merge_requests')
    await expect(f.service.handle({ kind: 'list-mrs', repository: f.directory })).rejects.toThrow(
      'permission denied',
    )
    await f.service.handle({ kind: 'disconnect' })
    await expect(f.service.handle({ kind: 'list-mrs', repository: f.directory })).rejects.toThrow(
      'Configure GitLab',
    )
  })
})

describe('open MR from a recent repository', () => {
  it('fetches MR refs and returns target/source fields in merge-base mode for IDs and links', async () => {
    const { service, snapshot, mr } = await fixture()
    const git = (...args: string[]) =>
      promisify(execFile)('git', ['-C', snapshot.repository, ...args])
    await git(
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      'commit',
      '--allow-empty',
      '-m',
      'initial',
    )
    await git('branch', '-f', 'main', 'HEAD')
    await git('update-ref', 'refs/merge-requests/7/head', 'HEAD')
    await git(
      'config',
      `url.${snapshot.repository}.insteadOf`,
      'git@gitlab.example.com:group/nested/repo.git',
    )
    for (const input of [
      '7',
      '!7',
      'https://gitlab.example.com/group/nested/repo/-/merge_requests/7#note_1',
      'https://gitlab.example.com/group/nested/repo/-/merge_requests/7/diffs',
      'https://gitlab.example.com/group/nested/repo/-/merge_requests/7/diffs?diff_id=123#note_1',
      'https://gitlab.example.com/group/nested/repo/-/merge_requests/7/commits',
      'https://gitlab.example.com/group/nested/repo/-/merge_requests/7/pipelines',
    ]) {
      const result = await service.handle({
        kind: 'open-mr',
        repository: snapshot.repository,
        input,
      })
      expect(result.comparison).toEqual({
        base: { kind: 'commit', ref: 'origin/main' },
        target: { kind: 'commit', ref: 'origin/feature/a' },
        mode: 'merge-base',
      })
      expect((await git('rev-parse', 'origin/feature/a')).stdout).toBe(
        (await git('rev-parse', 'HEAD')).stdout,
      )
    }
    mr.source_project_id = 99
    const fork = await service.handle({
      kind: 'open-mr',
      repository: snapshot.repository,
      input: '7',
    })
    expect(fork.comparison?.target).toEqual({
      kind: 'commit',
      ref: 'refs/revui/merge-requests/7/head',
    })
    expect((await git('rev-parse', 'refs/revui/merge-requests/7/head')).stdout).toBe(
      (await git('rev-parse', 'HEAD')).stdout,
    )
  })

  it.each(['merged', 'closed', 'opened'])(
    'opens a %s MR without its remote head ref using saved diff commits',
    async (state) => {
      const { service, snapshot, mr } = await fixture()
      const git = (...args: string[]) =>
        promisify(execFile)('git', [
          '-C',
          snapshot.repository,
          '-c',
          'user.name=Test',
          '-c',
          'user.email=test@example.com',
          '-c',
          'commit.gpgsign=false',
          ...args,
        ])
      await git('checkout', '-b', 'main')
      await writeFile(join(snapshot.repository, 'change.txt'), 'before\n')
      await git('add', '.')
      await git('commit', '-m', 'base')
      const base = (await git('rev-parse', 'HEAD')).stdout.trim()
      const local = await mkdtemp(join(tmpdir(), 'revui-old-mr-'))
      dirs.push(local)
      await promisify(execFile)('git', ['clone', '--single-branch', snapshot.repository, local])
      await writeFile(join(snapshot.repository, 'change.txt'), 'after\n')
      await git('commit', '-am', 'merged change')
      const head = (await git('rev-parse', 'HEAD')).stdout.trim()
      const localGit = (...args: string[]) => promisify(execFile)('git', ['-C', local, ...args])
      await localGit('remote', 'set-url', 'origin', 'git@gitlab.example.com:group/nested/repo.git')
      await localGit(
        'config',
        `url.${snapshot.repository}.insteadOf`,
        'git@gitlab.example.com:group/nested/repo.git',
      )
      mr.state = state
      mr.diff_refs = { base_sha: base, start_sha: base, head_sha: head }
      await expect(localGit('cat-file', '-e', `${head}^{commit}`)).rejects.toThrow()
      const result = await service.handle({ kind: 'open-mr', repository: local, input: '7' })
      expect(result.comparison).toEqual({
        base: { kind: 'commit', ref: base },
        target: { kind: 'commit', ref: head },
        mode: 'merge-base',
      })
      expect((await localGit('diff', `${base}...${head}`)).stdout).toContain('+after')
      // Locally retained commits also work if the remote is no longer reachable.
      mr.state = 'merged'
      await localGit('config', `url.${snapshot.repository}.insteadOf`, 'unused')
      await expect(
        service.handle({ kind: 'open-mr', repository: local, input: '7' }),
      ).resolves.toEqual(result)
    },
  )

  it('explains when historical commits cannot be recovered', async () => {
    const { service, snapshot, mr } = await fixture()
    mr.state = 'merged'
    await promisify(execFile)('git', [
      '-C',
      snapshot.repository,
      'config',
      `url.${snapshot.repository}.insteadOf`,
      'git@gitlab.example.com:group/nested/repo.git',
    ])
    await expect(
      service.handle({ kind: 'open-mr', repository: snapshot.repository, input: '7' }),
    ).rejects.toThrow('not available locally and could not be fetched')
    mr.diff_refs = null
    await expect(
      service.handle({ kind: 'open-mr', repository: snapshot.repository, input: '7' }),
    ).rejects.toThrow('no saved diff commits')
  })

  it.each(['closed', 'merged'])(
    'loads metadata for an explicitly opened %s MR without branch names',
    async (state) => {
      const { service, snapshot, mr, requests } = await fixture()
      mr.state = state
      delete snapshot.branches
      const result = await service.handle({ kind: 'lookup', snapshot: snapshot.id, iid: mr.iid })
      expect(result.matches).toEqual([mr])
      const selected = await service.handle({ kind: 'select', snapshot: snapshot.id, iid: mr.iid })
      expect(selected.review?.mr.iid).toBe(mr.iid)
      expect(selected.review?.mr.state).toBe(state)
      expect(selected.review?.discussions).not.toHaveLength(0)
      expect(requests.some(({ url }) => url.pathname.endsWith('/merge_requests'))).toBe(false)
      // Returning to a manual comparison resumes ordinary branch matching.
      expect((await service.handle({ kind: 'lookup', snapshot: snapshot.id })).matches).toEqual([])
    },
  )

  it('rejects malformed IDs, foreign hosts, and links to another project', async () => {
    const { service, snapshot } = await fixture()
    for (const input of [
      '0',
      '-2',
      'oops',
      'https://other.example.com/group/nested/repo/-/merge_requests/7',
      'https://gitlab.example.com/other/repo/-/merge_requests/7',
      'https://gitlab.example.com/other/repo/-/merge_requests/7/diffs',
      'https://gitlab.example.com/group/nested/repo/-/merge_requests/7invalid/diffs',
    ]) {
      await expect(
        service.handle({ kind: 'open-mr', repository: snapshot.repository, input }),
      ).rejects.toThrow()
    }
    await service.handle({ kind: 'disconnect' })
    await expect(
      service.handle({ kind: 'open-mr', repository: snapshot.repository, input: '7' }),
    ).rejects.toThrow('Configure GitLab')
  })
})

it('provides MR metadata and discussions to AI without exposing fetched diffs', async () => {
  const f = await fixture()
  expect(f.service.aiContext(f.snapshot.id)).toContain('No merge request')
  const review = await f.select()
  const context = JSON.parse(f.service.aiContext(f.snapshot.id))
  expect(Object.keys(context).sort()).toEqual(['approvals', 'discussions', 'mr'])
  expect(context.mr.title).toBe(review.mr.title)
  expect(context.mr.description).toBe(review.mr.description)
  expect(context.discussions).toEqual(review.discussions)
  expect(f.service.aiContext('another-snapshot')).toContain('No merge request')
})
