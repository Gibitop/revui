import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  mkdtemp,
  chmod,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { ReviewService } from './review'
import type { Comparison } from '../shared/review'

const exec = promisify(execFile)
const directories: string[] = []
const all: Comparison = {
  base: { kind: 'commit', ref: 'HEAD' },
  target: { kind: 'working' },
  mode: 'direct',
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'revui-review-')))
  directories.push(root)
  const repository = join(root, 'repository')
  const git = (...args: string[]) =>
    exec('git', [
      '-C',
      repository,
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ])
  await mkdir(repository)
  await git('init', '-b', 'main')
  await git('config', 'core.autocrlf', 'false')
  const write = (path: string, text: string | Buffer) => writeFile(join(repository, path), text)
  await write('file.txt', 'one\ntwo\n')
  await git('add', '.')
  await git('commit', '-m', 'initial')
  return { root, repository, git, write, service: new ReviewService(join(root, 'data')) }
}

it('separates all, staged, unstaged, selected commit to index/working, and non-ignored untracked files', async () => {
  const { repository, git, write, service } = await fixture()
  const oddPath = process.platform === 'win32' ? 'new Ω file.txt' : 'new Ω\tfile.txt'
  await write('file.txt', 'one\nstaged\n')
  await git('add', '.')
  await write('file.txt', 'one\nworking\n')
  await write(oddPath, 'untracked\r\n')
  await write('.gitignore', '*.ignored\n')
  await write('secret.ignored', 'ignored')
  let snapshot = await service.open(repository, all)
  expect(snapshot.files.map((f) => f.path)).toContain(oddPath)
  expect(snapshot.paths).not.toContain('secret.ignored')
  expect(snapshot.files.find((file) => file.path === 'file.txt')).toMatchObject({
    additions: 1,
    deletions: 1,
  })
  expect(snapshot.files.find((file) => file.path === oddPath)).toMatchObject({
    additions: 1,
    deletions: 0,
  })
  expect(await service.content(snapshot.id, 'file.txt')).toMatchObject({
    oldFile: { contents: 'one\ntwo\n' },
    newFile: { contents: 'one\nworking\n' },
  })
  snapshot = await service.open(repository, { ...all, target: { kind: 'index' } })
  expect(snapshot.files).toHaveLength(1)
  expect(await service.content(snapshot.id, 'file.txt')).toMatchObject({
    oldFile: { contents: 'one\ntwo\n' },
    newFile: { contents: 'one\nstaged\n' },
  })
  snapshot = await service.open(repository, { ...all, base: { kind: 'index' } })
  expect(await service.content(snapshot.id, 'file.txt')).toMatchObject({
    oldFile: { contents: 'one\nstaged\n' },
    newFile: { contents: 'one\nworking\n' },
  })
  const head = (await git('rev-parse', 'HEAD')).stdout.trim()
  snapshot = await service.open(repository, {
    ...all,
    base: { kind: 'commit', ref: head.slice(0, 8) },
  })
  expect(snapshot.comparison.base).toEqual({ kind: 'commit', ref: head })
  expect((await service.content(snapshot.id, oddPath)).newFile?.contents).toBe('untracked\r\n')
})

it.each([
  { contents: 'one\nreplacement\n', additions: 1, deletions: 1 },
  { contents: '', additions: 0, deletions: 2 },
  { contents: 'binary\0content', additions: null, deletions: null },
])(
  'preserves the baseline for a recreated staged deletion: $contents',
  async ({ contents, additions, deletions }) => {
    const { repository, git, write, service } = await fixture()
    await git('rm', 'file.txt')
    await write('file.txt', contents)
    const snapshot = await service.open(repository, all)
    expect(snapshot.files).toHaveLength(1)
    expect(snapshot.files[0]).toMatchObject({ status: 'M', additions, deletions })
    const content = await service.content(snapshot.id, 'file.txt')
    if (additions === null) expect(content.summary).toContain('Binary')
    else
      expect(content).toMatchObject({
        oldFile: { contents: 'one\ntwo\n' },
        newFile: { contents },
      })
    const staged = await service.open(repository, { ...all, target: { kind: 'index' } })
    expect(staged.files[0].status).toBe('D')
    const unstaged = await service.open(repository, { ...all, base: { kind: 'index' } })
    expect(unstaged.files[0]).toMatchObject({ status: '?', oldMode: '000000' })
  },
)

it('omits a recreated staged deletion when its content matches the baseline', async () => {
  const { repository, git, write, service } = await fixture()
  await git('rm', 'file.txt')
  await write('file.txt', 'one\ntwo\n')
  const snapshot = await service.open(repository, all)
  expect(snapshot.files).toEqual([])
  expect(snapshot.paths).toContain('file.txt')
  expect((await service.content(snapshot.id, 'file.txt')).newFile?.contents).toBe('one\ntwo\n')
})

it.skipIf(process.platform === 'win32')(
  'preserves executable modes and symlink targets for recreated deletions',
  async () => {
    const { repository, git, write, service } = await fixture()
    await chmod(join(repository, 'file.txt'), 0o755)
    await git('add', '.')
    await git('commit', '-m', 'executable')
    await git('rm', 'file.txt')
    await write('file.txt', 'one\ntwo\n')
    await chmod(join(repository, 'file.txt'), 0o755)
    expect((await service.open(repository, all)).files).toEqual([])
    await chmod(join(repository, 'file.txt'), 0o644)
    const modeChange = await service.open(repository, all)
    expect(modeChange.files[0]).toMatchObject({
      status: 'M',
      oldMode: '100755',
      newMode: '100644',
      additions: 0,
      deletions: 0,
    })
    await rm(join(repository, 'file.txt'))
    await symlink('missing-target', join(repository, 'file.txt'))
    const link = await service.open(repository, all)
    expect(link.files[0]).toMatchObject({ status: 'T', oldMode: '100755', newMode: '120000' })
    expect(await service.content(link.id, 'file.txt')).toMatchObject({
      oldFile: { contents: 'one\ntwo\n' },
      newFile: { contents: 'missing-target' },
    })
  },
)

it('supports direct and merge-base refs, remote refs, renames, deletions, mode changes and target-side all files', async () => {
  const { repository, git, write, service } = await fixture()
  await write('unchanged.txt', 'keep\n')
  await git('add', '.')
  await git('commit', '-m', 'common')
  await git('branch', 'feature')
  await write('main-only.txt', 'main\n')
  await git('add', '.')
  await git('commit', '-m', 'main')
  await git('checkout', 'feature')
  await git('mv', 'file.txt', 'renamed.txt')
  await git('update-index', '--chmod=+x', 'renamed.txt')
  await git('commit', '-m', 'rename')
  await git('update-ref', 'refs/remotes/origin/feature', 'HEAD')
  const comparison: Comparison = {
    base: { kind: 'commit', ref: 'main' },
    target: { kind: 'commit', ref: 'origin/feature' },
    mode: 'direct',
  }
  let snapshot = await service.open(repository, comparison)
  expect(snapshot.files.find((f) => f.path === 'main-only.txt')?.status).toBe('D')
  expect(snapshot.files.find((f) => f.path === 'renamed.txt')).toMatchObject({
    status: 'R',
    oldPath: 'file.txt',
    newMode: '100755',
    additions: 0,
    deletions: 0,
  })
  expect((await service.content(snapshot.id, 'unchanged.txt')).newFile?.contents).toBe('keep\n')
  snapshot = await service.open(repository, { ...comparison, mode: 'merge-base' })
  expect(snapshot.files).toHaveLength(1)
  expect(snapshot.paths).not.toContain('main-only.txt')
  expect((await service.content(snapshot.id, 'renamed.txt')).oldFile?.name).toBe('file.txt')
  await expect(service.content(snapshot.id, '../outside')).rejects.toThrow('not part')
})

it('persists threads, replies and markers; rejects stale mutable content and preserves outdated notes', async () => {
  const { root, repository, write, service } = await fixture()
  await write('file.txt', 'one\nchanged\n')
  let snapshot = await service.open(repository, all)
  const content = await service.content(snapshot.id, 'file.txt')
  await expect(
    service.update(snapshot.id, {
      kind: 'thread',
      path: 'file.txt',
      side: 'additions',
      start: 1,
      end: 500,
      body: 'invalid',
    }),
  ).rejects.toThrow('existing line')
  let record = await service.update(snapshot.id, {
    kind: 'thread',
    path: 'file.txt',
    side: 'additions',
    start: 2,
    end: 2,
    body: 'Check this',
  })
  const thread = record.threads[0].id
  await Promise.all([
    service.update(snapshot.id, { kind: 'reply', thread, body: 'Reply' }),
    service.update(snapshot.id, { kind: 'reviewed', path: 'file.txt', reviewed: true }),
  ])
  record = await service.update(snapshot.id, { kind: 'resolve', thread, resolved: true })
  expect(record.threads[0].messages).toHaveLength(2)
  expect(record.reviewed['file.txt']).toBe(content.fingerprint)
  const restarted = new ReviewService(join(root, 'data'))
  snapshot = await restarted.open(repository, all)
  expect(await restarted.records(snapshot.id)).toEqual(record)
  expect((await restarted.content(snapshot.id, 'file.txt')).fingerprint).toBe(content.fingerprint)
  await write('file.txt', 'different\n')
  await expect(restarted.content(snapshot.id, 'file.txt')).rejects.toThrow('changed')
  await expect(
    restarted.update(snapshot.id, { kind: 'reviewed', path: 'file.txt', reviewed: true }),
  ).rejects.toThrow('changed')
  const previous = snapshot.id
  snapshot = await restarted.open(repository, all)
  expect(snapshot.id).not.toBe(previous)
  expect((await restarted.records(snapshot.id)).threads).toHaveLength(1)
  expect((await restarted.content(snapshot.id, 'file.txt')).fingerprint).not.toBe(
    content.fingerprint,
  )
  await expect(restarted.content(previous, 'file.txt')).rejects.toThrow('no longer active')
  expect(await restarted.recent(repository)).toEqual(all)
})

it('shows binary and oversized files explicitly and loads complete large text on demand', async () => {
  const { repository, write, service } = await fixture()
  await write('binary.bin', Buffer.from([1, 0, 255]))
  await write('large.txt', 'x'.repeat(1024 * 1024 + 1))
  await write('lines.txt', 'x\n'.repeat(20001))
  const snapshot = await service.open(repository, all)
  expect((await service.content(snapshot.id, 'binary.bin')).summary).toContain('Binary')
  expect(await service.content(snapshot.id, 'large.txt')).toMatchObject({
    large: true,
    newFile: null,
  })
  expect((await service.content(snapshot.id, 'large.txt', true)).newFile?.contents.length).toBe(
    1024 * 1024 + 1,
  )
  expect((await service.content(snapshot.id, 'lines.txt')).large).toBe(true)
})

it('handles an unborn repository and cancellation without changing source files', async () => {
  const { repository, git, write, service } = await fixture()
  await git('checkout', '--orphan', 'unborn')
  await git('rm', '-rf', '.')
  await write('first.txt', 'new\n')
  await git('add', '.')
  // An orphan with another ref is not an empty repository; HEAD must still work.
  const snapshot = await service.open(repository, all)
  expect(snapshot.files[0].status).toBe('A')
  service.cancel()
  await expect(service.content(snapshot.id, 'first.txt')).rejects.toThrow('no longer active')
  expect(await readFile(join(repository, 'first.txt'), 'utf8')).toBe('new\n')
})

it('surfaces conflicts, including index-only views', async () => {
  const { repository, git, write, service } = await fixture()
  await git('checkout', '-b', 'other')
  await write('file.txt', 'other\n')
  await git('commit', '-am', 'other')
  await git('checkout', 'main')
  await write('file.txt', 'main\n')
  await git('commit', '-am', 'main')
  await git('merge', 'other').catch(() => undefined)
  for (const target of [{ kind: 'working' } as const, { kind: 'index' } as const]) {
    const snapshot = await service.open(repository, { ...all, target })
    expect(snapshot.files.find((f) => f.path === 'file.txt')?.status).toBe('U')
    expect((await service.content(snapshot.id, 'file.txt')).summary).toContain('Conflicted')
  }
})

it.skipIf(process.platform === 'win32')(
  'reads symlink targets without following them and recognizes submodules',
  async () => {
    const { repository, git, service } = await fixture()
    await symlink('/etc/passwd', join(repository, 'link'))
    const head = (await git('rev-parse', 'HEAD')).stdout.trim()
    await git('update-index', '--add', '--cacheinfo', `160000,${head},submodule`)
    let snapshot = await service.open(repository, all)
    expect((await service.content(snapshot.id, 'link')).newFile?.contents).toBe('/etc/passwd')
    snapshot = await service.open(repository, { ...all, target: { kind: 'index' } })
    expect((await service.content(snapshot.id, 'submodule')).summary).toContain('Submodule')
  },
)

it('does not overwrite corrupt or unsupported review records', async () => {
  const { root, repository, write, service } = await fixture()
  await write('file.txt', 'change\n')
  const snapshot = await service.open(repository, all)
  await service.content(snapshot.id, 'file.txt')
  await service.update(snapshot.id, { kind: 'reviewed', path: 'file.txt', reviewed: true })
  const folder = join(root, 'data', 'reviews', (await readdir(join(root, 'data', 'reviews')))[0])
  const path = join(folder, `${snapshot.key}.json`)
  await writeFile(path, '{"version":2}')
  await expect(
    service.update(snapshot.id, { kind: 'reviewed', path: 'file.txt', reviewed: false }),
  ).rejects.toThrow('preserved')
  expect(await readFile(path, 'utf8')).toBe('{"version":2}')
})

it('pins index blobs even if the user stages new content after opening, and supports linked worktrees', async () => {
  const { root, repository, git, write, service } = await fixture()
  await write('file.txt', 'staged snapshot\n')
  await git('add', '.')
  let snapshot = await service.open(repository, { ...all, target: { kind: 'index' } })
  await write('file.txt', 'later snapshot\n')
  await git('add', '.')
  expect((await service.content(snapshot.id, 'file.txt')).newFile?.contents).toBe(
    'staged snapshot\n',
  )
  const worktree = join(root, 'linked')
  await git('worktree', 'add', '--detach', worktree, 'HEAD')
  await writeFile(join(worktree, 'file.txt'), 'linked changes\n')
  snapshot = await service.open(worktree, all)
  expect((await service.content(snapshot.id, 'file.txt')).newFile?.contents).toBe(
    'linked changes\n',
  )
  expect(await readFile(join(repository, 'file.txt'), 'utf8')).toBe('later snapshot\n')
})

it('rejects invalid comparisons and cancels pending Git requests when another comparison opens', async () => {
  const { repository, service } = await fixture()
  await expect(service.open(repository, { ...all, mode: 'merge-base' })).rejects.toThrow(
    'two commits',
  )
  await expect(
    service.open(repository, { ...all, base: { kind: 'commit', ref: '--help' } }),
  ).rejects.toThrow()
  await expect(
    service.open(repository, { ...all, base: { kind: 'commit', ref: 'missing-ref' } }),
  ).rejects.toThrow()
  const first = service.open(repository, all)
  const firstResult = first.catch((error: Error) => error)
  const second = await service.open(repository, { ...all, target: { kind: 'index' } })
  expect(await firstResult).toBeInstanceOf(Error)
  expect(await service.records(second.id)).toMatchObject({ threads: [] })
})

it('suggests refs and searches commit, index and working-tree contents without changing snapshots', async () => {
  const { repository, git, write, service } = await fixture()
  await git('tag', 'v1')
  await write('file.txt', 'staged needle\n')
  await git('add', '.')
  await write('file.txt', 'working needle\n')
  const oddPath = process.platform === 'win32' ? 'new Ω file.txt' : 'new Ω\nfile.txt'
  await write(oddPath, 'untracked NEEDLE\n')
  expect(await service.refs(repository)).toEqual(
    expect.arrayContaining([
      { value: 'HEAD', kind: 'commit' },
      { value: 'main', kind: 'branch' },
      { value: 'v1', kind: 'tag' },
    ]),
  )
  let snapshot = await service.open(repository, all)
  expect((await service.search(snapshot.id, 'needle')).matches).toEqual(
    expect.arrayContaining([
      { path: 'file.txt', line: 1, text: 'working needle', ranges: [{ start: 8, end: 14 }] },
      { path: oddPath, line: 1, text: 'untracked NEEDLE', ranges: [{ start: 10, end: 16 }] },
    ]),
  )
  expect((await service.search(snapshot.id, 'does not exist')).matches).toEqual([])
  snapshot = await service.open(repository, { ...all, target: { kind: 'index' } })
  expect((await service.search(snapshot.id, 'needle')).matches).toEqual([
    { path: 'file.txt', line: 1, text: 'staged needle', ranges: [{ start: 7, end: 13 }] },
  ])
  await git('add', 'file.txt')
  await expect(service.search(snapshot.id, 'needle')).rejects.toThrow('index changed')
  snapshot = await service.open(repository, {
    base: { kind: 'commit', ref: 'HEAD' },
    target: { kind: 'commit', ref: 'v1' },
    mode: 'direct',
  })
  expect((await service.search(snapshot.id, 'two')).matches).toEqual([
    { path: 'file.txt', line: 2, text: 'two', ranges: [{ start: 0, end: 3 }] },
  ])
})

it('migrates thread dates and persists comment deletion, removing empty threads', async () => {
  const { root, repository, write, service } = await fixture()
  await write('file.txt', 'changed\n')
  const snapshot = await service.open(repository, all)
  await service.content(snapshot.id, 'file.txt')
  let record = await service.update(snapshot.id, {
    kind: 'thread',
    path: 'file.txt',
    side: 'additions',
    start: 1,
    end: 1,
    body: '**Markdown**',
  })
  const thread = record.threads[0]
  expect(thread.createdAt).toBe(thread.updatedAt)
  record = await service.update(snapshot.id, { kind: 'reply', thread: thread.id, body: 'reply' })
  expect(record.threads[0].createdAt).toBe(thread.createdAt)
  expect(record.threads[0].updatedAt >= thread.updatedAt).toBe(true)
  const reviews = join(root, 'data', 'reviews')
  const recordPath = join(reviews, (await readdir(reviews))[0], `${snapshot.key}.json`)
  const legacy = JSON.parse(await readFile(recordPath, 'utf8'))
  delete legacy.threads[0].createdAt
  delete legacy.threads[0].updatedAt
  for (const message of legacy.threads[0].messages) delete message.updatedAt
  await writeFile(recordPath, JSON.stringify(legacy))
  const migrated = (await service.records(snapshot.id)).threads[0]
  expect(migrated.createdAt).toBe(thread.createdAt)
  expect(migrated.messages[0].updatedAt).toBe(migrated.messages[0].createdAt)
  expect(migrated.messages[1].updatedAt).toBe(migrated.messages[1].createdAt)
  const reply = record.threads[0].messages[1].id
  const original = record.threads[0].messages[0]
  record = await service.update(snapshot.id, {
    kind: 'edit-comment',
    thread: thread.id,
    message: original.id,
    body: 'Edited comment',
  })
  expect(record.threads[0].messages[0]).toMatchObject({
    id: original.id,
    createdAt: original.createdAt,
    body: 'Edited comment',
  })
  expect((await service.records(snapshot.id)).threads[0].messages[0].body).toBe('Edited comment')
  record = await service.update(snapshot.id, {
    kind: 'delete-comment',
    thread: thread.id,
    message: reply,
  })
  expect(record.threads[0].messages).toHaveLength(1)
  await expect(
    service.update(snapshot.id, { kind: 'delete-comment', thread: thread.id, message: reply }),
  ).rejects.toThrow('Comment does not exist')
  record = await service.update(snapshot.id, {
    kind: 'delete-comment',
    thread: thread.id,
    message: thread.messages[0].id,
  })
  expect(record.threads).toEqual([])
  const restarted = new ReviewService(join(root, 'data'))
  const reopened = await restarted.open(repository, all)
  expect((await restarted.records(reopened.id)).threads).toEqual([])
})

it('rejects invalid persisted timestamps and preserves the original record', async () => {
  const { root, repository, write, service } = await fixture()
  await write('file.txt', 'changed\n')
  const snapshot = await service.open(repository, all)
  await service.content(snapshot.id, 'file.txt')
  const record = await service.update(snapshot.id, {
    kind: 'thread',
    path: 'file.txt',
    side: 'additions',
    start: 1,
    end: 1,
    body: 'note',
  })
  const reviews = join(root, 'data', 'reviews')
  const recordPath = join(reviews, (await readdir(reviews))[0], `${snapshot.key}.json`)
  for (const value of ['not-a-date', '2026-02-30T12:00:00Z', '2026-01-01']) {
    const invalid = structuredClone(record)
    invalid.threads[0].messages[0].createdAt = value
    const original = JSON.stringify(invalid)
    await writeFile(recordPath, original)
    await expect(service.records(snapshot.id)).rejects.toThrow('preserved')
    await expect(
      service.update(snapshot.id, { kind: 'reply', thread: record.threads[0].id, body: 'reply' }),
    ).rejects.toThrow('preserved')
    expect(await readFile(recordPath, 'utf8')).toBe(original)
  }
})

it('ignores stale cancellation for both pending and established replacement sessions', async () => {
  const { repository, service } = await fixture()
  const first = service.open(repository, all, 'first').catch((error: Error) => error)
  const replacement = service.open(repository, all, 'second')
  service.cancel('first')
  const snapshot = await replacement
  expect(await first).toBeInstanceOf(Error)
  service.cancel('first')
  expect((await service.content(snapshot.id, 'file.txt')).newFile?.contents).toBe('one\ntwo\n')
  service.cancel('second')
  await expect(service.records(snapshot.id)).rejects.toThrow('no longer active')
})

it('streams and truncates searches only when there are more than 500 eligible matches', async () => {
  const { repository, git, write, service } = await fixture()
  for (const count of [500, 501, 20000]) {
    await write('file.txt', Array.from({ length: count }, (_, i) => `needle Ω ${i}`).join('\n'))
    await git('add', '.')
    const snapshot = await service.open(repository, { ...all, target: { kind: 'index' } })
    const result = await service.search(snapshot.id, 'NEEDLE')
    expect(result.matches).toHaveLength(500)
    expect(result.matches[499]).toEqual({
      path: 'file.txt',
      line: 500,
      text: 'needle Ω 499',
      ranges: [{ start: 0, end: 6 }],
    })
    expect(result.truncated).toBe(count > 500)
    expect(await service.search(snapshot.id, 'absent')).toEqual({ matches: [], truncated: false })
  }
})

it('filters search paths before truncation and supports empty file-tree filters', async () => {
  const { repository, git, write, service } = await fixture()
  await write('file.txt', 'needle\n'.repeat(600))
  await write('selected.txt', 'selected needle\n')
  await git('add', '.')
  const snapshot = await service.open(repository, { ...all, target: { kind: 'index' } })
  expect(await service.search(snapshot.id, 'needle', ['selected.txt'])).toEqual({
    matches: [
      { path: 'selected.txt', line: 1, text: 'selected needle', ranges: [{ start: 9, end: 15 }] },
    ],
    truncated: false,
  })
  expect(await service.search(snapshot.id, 'needle', [])).toEqual({
    matches: [],
    truncated: false,
  })
  expect((await service.search(snapshot.id, 'needle', snapshot.paths)).truncated).toBe(true)
})

it('combines case, whole-word and regex search modifiers and reports invalid patterns', async () => {
  const { repository, write, service } = await fixture()
  await write('file.txt', 'Needle\nneedle\nneedles\nneedle_thing\nneedle.42\nneedleX42\n')
  await write('other.txt', 'Needle\n')
  const snapshot = await service.open(repository, all)
  const paths = ['file.txt']
  expect((await service.search(snapshot.id, 'needle', paths)).matches).toHaveLength(6)
  expect(
    (await service.search(snapshot.id, 'needle', paths, { matchCase: true })).matches,
  ).toHaveLength(5)
  expect(
    (await service.search(snapshot.id, 'needle', paths, { wholeWord: true })).matches.map(
      (m) => m.line,
    ),
  ).toEqual([1, 2, 5])
  expect(
    (
      await service.search(snapshot.id, 'Need(le|less)', paths, {
        regex: true,
        matchCase: true,
        wholeWord: true,
      })
    ).matches.map((m) => m.line),
  ).toEqual([1])
  expect(
    (await service.search(snapshot.id, 'needle.42', paths)).matches.map((m) => m.line),
  ).toEqual([5])
  expect(
    (await service.search(snapshot.id, 'needle.42', paths, { regex: true })).matches.map(
      (m) => m.line,
    ),
  ).toEqual([5, 6])
  await expect(service.search(snapshot.id, '[', paths, { regex: true })).rejects.toThrow()
})

it('supports regex shorthand classes and highlights whitespace instead of literal letters', async () => {
  const { repository, write, service } = await fixture()
  await write('file.txt', 'sss\ns s\n\tss  42\nword_word\n\\s\n')
  const snapshot = await service.open(repository, all)
  const spaces = await service.search(snapshot.id, String.raw`\s+`, ['file.txt'], { regex: true })
  expect(spaces.matches.map((match) => ({ line: match.line, ranges: match.ranges }))).toEqual([
    { line: 2, ranges: [{ start: 1, end: 2 }] },
    {
      line: 3,
      ranges: [
        { start: 0, end: 1 },
        { start: 3, end: 5 },
      ],
    },
  ])
  const digits = await service.search(snapshot.id, String.raw`\d+`, ['file.txt'], { regex: true })
  expect(digits.matches[0].ranges).toEqual([{ start: 5, end: 7 }])
  const words = await service.search(snapshot.id, String.raw`\b\w+_\w+\b`, ['file.txt'], {
    regex: true,
  })
  expect(words.matches.map((match) => match.line)).toEqual([4])
  const literal = await service.search(snapshot.id, String.raw`\s`, ['file.txt'])
  expect(literal.matches.map((match) => match.line)).toEqual([5])
})

it('keeps regex matches visible in previews after long Unicode prefixes', async () => {
  const { repository, write, service } = await fixture()
  await write('file.txt', 'Ω'.repeat(400) + 'needle42\n')
  const snapshot = await service.open(repository, all)
  const result = await service.search(snapshot.id, 'needle[0-9]+', ['file.txt'], { regex: true })
  expect(result.matches[0].text).toBe('…' + 'Ω'.repeat(80) + 'needle42')
  expect(result.matches[0].ranges).toEqual([{ start: 81, end: 89 }])
})

it('returns all match ranges with Git regex, word and case semantics', async () => {
  const { repository, write, service } = await fixture()
  await write('file.txt', 'Ω cat cats CAT cat42 cat\n')
  const snapshot = await service.open(repository, all)
  const literal = await service.search(snapshot.id, 'cat', undefined, { wholeWord: true })
  expect(literal.matches[0].ranges).toEqual([
    { start: 2, end: 5 },
    { start: 11, end: 14 },
    { start: 21, end: 24 },
  ])
  const sensitive = await service.search(snapshot.id, 'cat', undefined, {
    wholeWord: true,
    matchCase: true,
  })
  expect(sensitive.matches[0].ranges).toEqual([
    { start: 2, end: 5 },
    { start: 21, end: 24 },
  ])
  const regex = await service.search(snapshot.id, 'cat[[:digit:]]+', undefined, { regex: true })
  expect(regex.matches[0].ranges).toEqual([{ start: 15, end: 20 }])
  expect(regex.matches[0].text).toBe('Ω cat cats CAT cat42 cat')
})

it('does not turn canceled searches or Git failures into empty successful results', async () => {
  const { repository, service } = await fixture()
  const snapshot = await service.open(repository, all, 'search-session')
  const search = service.search(snapshot.id, 'one')
  const result = search.catch((error: Error) => error)
  service.cancel('search-session')
  expect(await result).toBeInstanceOf(Error)
  const replacement = await service.open(repository, all)
  await rm(join(repository, '.git'), { recursive: true, force: true })
  await expect(service.search(replacement.id, 'one')).rejects.toThrow()
})

it('fetches remote updates before resolving a refreshed comparison', async () => {
  const { root, repository, git, write, service } = await fixture()
  const remote = join(root, 'remote')
  await exec('git', ['clone', '--bare', repository, remote])
  await git('remote', 'add', 'origin', remote)
  await git('fetch')
  await write('file.txt', 'new remote content\n')
  await git('commit', '-am', 'remote update')
  await git('push', 'origin', 'main')
  await git('reset', '--hard', 'HEAD~1')
  // Reset the tracking ref to simulate an update made by another checkout.
  await git('update-ref', 'refs/remotes/origin/main', 'HEAD')
  const comparison: Comparison = {
    base: { kind: 'commit', ref: 'HEAD' },
    target: { kind: 'commit', ref: 'origin/main' },
    mode: 'direct',
  }
  expect((await service.open(repository, comparison)).files).toHaveLength(0)
  const refreshed = await service.open(repository, comparison, undefined, true)
  expect(refreshed.files.map((file) => file.path)).toEqual(['file.txt'])
  expect((await service.content(refreshed.id, 'file.txt')).newFile?.contents).toBe(
    'new remote content\n',
  )
  await git('remote', 'set-url', 'origin', join(root, 'missing-remote'))
  await expect(service.open(repository, comparison, undefined, true)).rejects.toThrow()
})

it('preserves branch pairs separately from resolved SHAs for GitLab lookup', async () => {
  const { repository, git, write, service } = await fixture()
  await git('checkout', '-b', 'feature/nested')
  await write('file.txt', 'changed\n')
  await git('commit', '-am', 'feature')
  await git('update-ref', 'refs/remotes/origin/feature/nested', 'HEAD')
  await git('update-ref', 'refs/remotes/origin/main', 'main')
  const snapshot = await service.open(repository, {
    base: { kind: 'commit', ref: 'origin/main' },
    target: { kind: 'commit', ref: 'origin/feature/nested' },
    mode: 'merge-base',
  })
  expect(snapshot.branches).toEqual({ source: 'feature/nested', target: 'main' })
  expect(snapshot.comparison.target).toMatchObject({
    ref: (await git('rev-parse', 'HEAD')).stdout.trim(),
  })
  await git('tag', 'release')
  const tag = await service.open(repository, {
    base: { kind: 'commit', ref: 'main' },
    target: { kind: 'commit', ref: 'release' },
    mode: 'direct',
  })
  expect(tag.branches).toBeUndefined()
})
