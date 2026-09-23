import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import {
  WorkspaceService,
  workspaceMatches,
  workspaceGit as git,
  runWorkspaceScript,
  openWorkspaceIDE,
} from './workspace'
import { ReviewService } from './review'
import { randomUUID } from 'node:crypto'

const roots: string[] = []
afterEach(async () => {
  for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true })
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'revui-workspace-'))
  roots.push(root)
  await git(root, ['init', '-b', 'main'])
  await git(root, ['config', 'user.email', 'test@example.com'])
  await git(root, ['config', 'user.name', 'Test'])
  await writeFile(join(root, 'file.txt'), 'first\n')
  await git(root, ['add', '.'])
  await git(root, ['commit', '-m', 'first'])
  const first = await git(root, ['rev-parse', 'HEAD'])
  await writeFile(join(root, 'file.txt'), 'second\n')
  await git(root, ['commit', '-am', 'second'])
  const directory = await mkdtemp(join(tmpdir(), 'revui-workspace-data-'))
  roots.push(directory)
  const service = new WorkspaceService(directory)
  await service.load()
  const reviews = new ReviewService(directory)
  const snapshot = await reviews.open(
    root,
    {
      base: { kind: 'commit', ref: 'HEAD' },
      target: { kind: 'commit', ref: first },
      mode: 'direct',
    },
    randomUUID(),
  )
  return { root, directory, service, reviews, snapshot }
}
it('protects source changes and removes ignored setup output only with confirmation', async () => {
  const { root, service, snapshot } = await fixture()
  const record = await service.prepare(snapshot, 'worktree', false)
  expect(await readFile(join(record.path, 'file.txt'), 'utf8')).toBe('first\n')
  expect(await readFile(join(root, 'file.txt'), 'utf8')).toBe('second\n')
  await writeFile(join(record.path, 'untracked'), 'keep')
  await expect(service.remove(record.id)).rejects.toThrow('changes')
  await rm(join(record.path, 'untracked'))
  await writeFile(join(root, '.git', 'info', 'exclude'), 'ignored-output\n')
  await writeFile(join(record.path, 'ignored-output'), 'keep ignored output')
  await expect(service.remove(record.id)).rejects.toThrow('ignored files')
  await writeFile(join(record.path, 'untracked'), 'keep')
  await expect(service.remove(record.id, true)).rejects.toThrow('changes')
  await rm(join(record.path, 'untracked'))
  await writeFile(join(record.path, 'file.txt'), 'keep tracked changes')
  await expect(service.remove(record.id, true)).rejects.toThrow('changes')
  await git(record.path, ['checkout', '--', 'file.txt'])
  await service.remove(record.id, true)
  await expect(readFile(join(record.path, 'ignored-output'))).rejects.toThrow()
  expect(service.list(root)).toEqual([])
})
it('restores staged, unstaged and untracked content after restart using the recorded stash', async () => {
  const { root, directory, service, snapshot } = await fixture()
  await writeFile(join(root, 'file.txt'), 'staged\n')
  await git(root, ['add', '.'])
  await writeFile(join(root, 'file.txt'), 'unstaged\n')
  await writeFile(join(root, 'new.txt'), 'untracked')
  await expect(service.prepare(snapshot, 'in-place', false)).rejects.toThrow('confirmation')
  const record = await service.prepare(snapshot, 'in-place', true)
  expect(record.stash).toMatch(/^[a-f0-9]{40}$/)
  await writeFile(join(root, 'other.txt'), 'another stash')
  await git(root, ['stash', 'push', '-u', '-m', 'user stash'])
  // Simulate a crash after stash creation but before recording its object ID.
  const journal = JSON.parse(await readFile(join(directory, 'workspaces.json'), 'utf8'))
  journal.records[0].stash = null
  await writeFile(join(directory, 'workspaces.json'), JSON.stringify(journal))
  const reopened = new WorkspaceService(directory)
  await reopened.load()
  await reopened.restore(record.id)
  expect(await readFile(join(root, 'file.txt'), 'utf8')).toBe('unstaged\n')
  expect(await git(root, ['show', ':file.txt'])).toBe('staged')
  expect(await readFile(join(root, 'new.txt'), 'utf8')).toBe('untracked')
  expect(await git(root, ['symbolic-ref', '--short', 'HEAD'])).toBe('main')
  expect(await git(root, ['stash', 'list', '--format=%H'])).toContain(record.stash)
})
it('blocks restoration over new work and retains recovery data on conflicts', async () => {
  const { root, directory, service, snapshot } = await fixture()
  await writeFile(join(root, 'new.txt'), 'original untracked')
  const record = await service.prepare(snapshot, 'in-place', true)
  await writeFile(join(root, 'new.txt'), 'new work')
  await expect(service.restore(record.id)).rejects.toThrow('New workspace changes')
  expect(await readFile(join(root, 'new.txt'), 'utf8')).toBe('new work')
  // Ignored files are invisible to normal status but must never be overwritten by stash apply.
  await writeFile(join(root, '.git', 'info', 'exclude'), 'new.txt\n')
  await expect(service.restore(record.id)).rejects.toThrow('Recovery stash')
  expect(await readFile(join(root, 'new.txt'), 'utf8')).toBe('new work')
  const reopened = new WorkspaceService(directory)
  await reopened.load()
  expect(reopened.get(record.id).phase).toBe('restoring')
  await expect(reopened.restore(record.id)).rejects.toThrow('interrupted')
  expect(await git(root, ['stash', 'list', '--format=%H'])).toContain(record.stash)
})
it('pins index-only content, excludes unstaged edits, and rejects a stale index', async () => {
  const { root, service, reviews } = await fixture()
  await writeFile(join(root, 'file.txt'), 'staged')
  await git(root, ['add', '.'])
  await writeFile(join(root, 'file.txt'), 'unstaged')
  const snapshot = await reviews.open(
    root,
    { base: { kind: 'commit', ref: 'HEAD' }, target: { kind: 'index' }, mode: 'direct' },
    randomUUID(),
  )
  const record = await service.prepare(
    await reviews.workspaceSnapshot(snapshot.id),
    'worktree',
    false,
  )
  expect(await readFile(join(record.path, 'file.txt'), 'utf8')).toBe('staged')
  expect(await readFile(join(root, 'file.txt'), 'utf8')).toBe('unstaged')
  await git(root, ['add', '.'])
  await expect(reviews.workspaceSnapshot(snapshot.id)).rejects.toThrow('index changed')
  await service.remove(record.id)
})
it('keeps checkout failures recoverable and refuses unreadable recovery files', async () => {
  const { root, directory, service, snapshot } = await fixture()
  await writeFile(join(root, 'file.txt'), 'dirty')
  const invalid = {
    ...snapshot,
    comparison: {
      ...snapshot.comparison,
      target: { kind: 'commit' as const, ref: '0'.repeat(40) },
    },
  }
  await expect(service.prepare(invalid, 'in-place', true)).rejects.toThrow()
  const record = service.list(root)[0]
  expect(record.phase).toBe('failed')
  await service.restore(record.id)
  expect(await readFile(join(root, 'file.txt'), 'utf8')).toBe('dirty')
  await writeFile(join(directory, 'workspaces.json'), '{broken')
  await expect(new WorkspaceService(directory).load()).rejects.toThrow('cannot be read')
})
it('reports script output and failures, and restricts IDE paths to the workspace', async () => {
  const { root } = await fixture()
  let output = ''
  await runWorkspaceScript(root, { script: 'echo setup-output' }, (data) => {
    output += data
  })
  expect(output).toContain('setup-output')
  await expect(runWorkspaceScript(root, { script: 'exit 7' }, () => {})).rejects.toThrow('7')
  await expect(openWorkspaceIDE(root, '../', 1, 'vscode')).rejects.toThrow('outside')
})

it('allows explicit completion after manual conflict recovery and keeps the stash', async () => {
  const { root, service, snapshot } = await fixture()
  await writeFile(join(root, 'file.txt'), 'saved changes')
  const record = await service.prepare(snapshot, 'in-place', true)
  await expect(service.acknowledgeRestoration(record.id)).rejects.toThrow('original checkout')
  await git(root, ['checkout', 'main'])
  await git(root, ['stash', 'apply', '--index', record.stash!])
  await service.acknowledgeRestoration(record.id)
  expect(service.get(record.id).phase).toBe('restored')
  expect(await git(root, ['stash', 'list', '--format=%H'])).toContain(record.stash)
})

it('never records a pre-existing stash when Git cannot stash submodule changes', async () => {
  const { root, service, snapshot } = await fixture()
  await git(root, ['-c', 'protocol.file.allow=always', 'submodule', 'add', root, 'module'])
  await git(root, ['commit', '-am', 'submodule'])
  await writeFile(join(root, 'user-file'), 'user stash')
  await git(root, ['stash', 'push', '-u', '-m', 'unrelated user stash'])
  const userStash = await git(root, ['rev-parse', 'refs/stash'])
  await writeFile(join(root, 'module', 'file.txt'), 'submodule edits')
  await expect(service.prepare(snapshot, 'in-place', true)).rejects.toThrow('expected stash')
  expect(service.list(root)[0].stash).toBeNull()
  expect(await git(root, ['rev-parse', 'refs/stash'])).toBe(userStash)
  expect(await readFile(join(root, 'module', 'file.txt'), 'utf8')).toBe('submodule edits')
})

it('cancels a setup process and reports the incomplete setup', async () => {
  const { root } = await fixture()
  const controller = new AbortController()
  const command = `"${process.execPath}" -e "console.log('started');setInterval(()=>{},1000)"`
  await expect(
    runWorkspaceScript(
      root,
      { script: command },
      (data) => {
        if (data.includes('started')) controller.abort()
      },
      controller.signal,
    ),
  ).rejects.toThrow('canceled')
})

it('matches tags and branches by commit identity without touching local changes', async () => {
  const { root, snapshot } = await fixture()
  await git(root, ['tag', '-a', 'release', '-m', 'release'])
  snapshot.comparison.target = { kind: 'commit', ref: 'release' }
  expect(await workspaceMatches(snapshot, root)).toBe(true)
  await writeFile(join(root, 'file.txt'), 'local edit')
  expect(await workspaceMatches(snapshot, root)).toBe(true)
  expect(await readFile(join(root, 'file.txt'), 'utf8')).toBe('local edit')
  snapshot.comparison.target = { kind: 'commit', ref: 'HEAD~1' }
  expect(await workspaceMatches(snapshot, root)).toBe(false)
})

it('matches staged content only when the checkout has the same tracked files', async () => {
  const { root, snapshot } = await fixture()
  await writeFile(join(root, 'file.txt'), 'staged')
  await git(root, ['add', '.'])
  const staged = {
    ...snapshot,
    comparison: { ...snapshot.comparison, target: { kind: 'index' as const } },
    indexTree: await git(root, ['write-tree']),
  }
  expect(await workspaceMatches(staged, root)).toBe(true)
  await writeFile(join(root, 'file.txt'), 'unstaged')
  expect(await workspaceMatches(staged, root)).toBe(false)
})

it('reuses worktrees by commit identity and persists successful initialization', async () => {
  const { root, directory, service, snapshot } = await fixture()
  const record = await service.prepare(snapshot, 'worktree', false)
  await service.markInitialized(record.id, true)
  await git(root, [
    'tag',
    '-a',
    'review-tag',
    snapshot.comparison.target.kind === 'commit' ? snapshot.comparison.target.ref : '',
    '-m',
    'review',
  ])
  const reopened = new WorkspaceService(directory)
  await reopened.load()
  const anotherReview = {
    ...snapshot,
    id: randomUUID(),
    comparison: { ...snapshot.comparison, target: { kind: 'commit' as const, ref: 'review-tag' } },
  }
  await writeFile(join(record.path, 'file.txt'), 'local edits stay intact')
  expect(await reopened.findMatching(anotherReview)).toMatchObject({
    id: record.id,
    initialized: true,
  })
  expect(await readFile(join(record.path, 'file.txt'), 'utf8')).toBe('local edits stay intact')
  await reopened.markInitialized(record.id, false)
  expect(await reopened.findMatching(anotherReview)).toMatchObject({
    id: record.id,
    initialized: false,
  })
  await git(record.path, ['checkout', '--', 'file.txt'])
  await git(record.path, ['checkout', '--detach', 'main'])
  expect(await reopened.findMatching(anotherReview)).toBeNull()
  await rm(record.path, { recursive: true, force: true })
  expect(await reopened.findMatching(anotherReview)).toBeNull()
})

it('reuses staged worktrees by their immutable tree, preserving setup and user edits', async () => {
  const { root, service, snapshot } = await fixture()
  const staged = {
    ...snapshot,
    comparison: { ...snapshot.comparison, target: { kind: 'index' as const } },
    indexTree: await git(root, ['write-tree']),
  }
  const record = await service.prepare(staged, 'worktree', false)
  await service.markInitialized(record.id, true)
  await writeFile(join(record.path, 'file.txt'), 'edited after setup')
  expect(await service.findMatching({ ...staged, id: randomUUID() })).toMatchObject({
    id: record.id,
  })
  expect(await workspaceMatches(staged, record.path)).toBe(true)
  expect(await service.findMatching({ ...staged, indexTree: 'different-tree' })).toBeNull()
})

it('forgets manually deleted worktrees persistently without removing checkout recovery records', async () => {
  const { root, directory, service, snapshot } = await fixture()
  const missing = await service.prepare(snapshot, 'worktree', false)
  const retained = await service.prepare(snapshot, 'worktree', false)
  const checkout = await service.prepare(snapshot, 'in-place', true)
  await rm(missing.path, { recursive: true, force: true })
  await rm(root, { recursive: true, force: true })
  await service.pruneMissing()
  expect(service.list().map((record) => record.id)).toEqual([retained.id, checkout.id])
  const reopened = new WorkspaceService(directory)
  await reopened.load()
  expect(reopened.list().map((record) => record.id)).toEqual([retained.id, checkout.id])
  expect(await readFile(join(retained.path, 'file.txt'), 'utf8')).toBe('first\n')
})
