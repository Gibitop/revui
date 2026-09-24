import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { registerAIIPC, workspaceStamp } from './ai-ipc'
import { ReviewService } from './review'
import { WorkspaceService } from './workspace'
import type { AIService } from './ai'

const fixtureHarness = vi.hoisted(() => ({ cwd: '', processCwd: '', instructions: '' }))
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))
vi.mock('./codex', () => ({
  CodexHarness: class {
    version = 'fixture'
    async connect(cwd: string) {
      fixtureHarness.processCwd = cwd
    }
    async start(cwd: string, _session: string | null, instructions: string) {
      fixtureHarness.instructions = instructions
      fixtureHarness.cwd = cwd
      return 'fixture-session'
    }
    async send() {
      return 'fixture-turn'
    }
    async cancel() {}
    approve() {}
    close() {}
  },
}))
const roots: string[] = []
const services: AIService[] = []
afterEach(async () => {
  for (const service of services.splice(0)) {
    await service.close()
    await service.flush()
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'revui-ai-workspace-')))
  roots.push(root)
  const repository = join(root, 'repo')
  await mkdir(repository)
  const git = (...args: string[]) =>
    execFileSync('git', [
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
  git('init', '-b', 'main')
  const reviews = new ReviewService(join(root, 'data')),
    workspaces = new WorkspaceService(join(root, 'data'))
  await workspaces.load()
  const ai = registerAIIPC(
    join(root, 'data'),
    reviews,
    workspaces,
    () => undefined,
    () => null,
  )
  services.push(ai)
  return { root, repository, git, reviews, workspaces, ai }
}

it('isolates staged AI tool context from unstaged and untracked checkout files', async () => {
  const f = await fixture()
  await writeFile(join(f.repository, 'file.ts'), 'base\n')
  f.git('add', '.')
  f.git('commit', '-m', 'base')
  await writeFile(join(f.repository, 'file.ts'), 'staged\n')
  f.git('add', '.')
  await writeFile(join(f.repository, 'file.ts'), 'unstaged\n')
  await writeFile(join(f.repository, 'private.txt'), 'untracked\n')
  const snapshot = await f.reviews.open(f.repository, {
    base: { kind: 'commit', ref: 'HEAD' },
    target: { kind: 'index' },
    mode: 'direct',
  })
  await f.ai.handle({
    kind: 'send',
    snapshot: snapshot.id,
    workspace: null,
    mode: 'chat',
    text: '',
    attachments: [],
  })
  expect(fixtureHarness.cwd).not.toBe(f.repository)
  expect(await readFile(join(fixtureHarness.cwd, 'file.ts'), 'utf8')).toBe('staged\n')
  await expect(readFile(join(fixtureHarness.cwd, 'private.txt'), 'utf8')).rejects.toThrow()
  expect(await readFile(join(f.repository, 'file.ts'), 'utf8')).toBe('unstaged\n')
  expect(f.workspaces.list(f.repository)).toHaveLength(1)
  await f.ai.handle({ kind: 'cancel', snapshot: snapshot.id })
  await f.ai.handle({
    kind: 'send',
    snapshot: snapshot.id,
    workspace: null,
    mode: 'chat',
    text: 'Resume',
    attachments: [],
  })
  expect(f.workspaces.list(f.repository)).toHaveLength(1)
})

it('blocks dirty historical tool contexts even when HEAD matches the reviewed target', async () => {
  const f = await fixture()
  await writeFile(join(f.repository, 'file.ts'), 'base\n')
  f.git('add', '.')
  f.git('commit', '-m', 'base')
  await writeFile(join(f.repository, 'file.ts'), 'new\n')
  f.git('commit', '-am', 'new')
  const snapshot = await f.reviews.open(f.repository, {
    base: { kind: 'commit', ref: 'HEAD~1' },
    target: { kind: 'commit', ref: 'HEAD' },
    mode: 'direct',
  })
  await writeFile(join(f.repository, 'file.ts'), 'dirty\n')
  await expect(
    f.ai.handle({
      kind: 'send',
      snapshot: snapshot.id,
      workspace: null,
      mode: 'chat',
      text: '',
      attachments: [],
    }),
  ).rejects.toThrow('local changes')
  expect(await readFile(join(f.repository, 'file.ts'), 'utf8')).toBe('dirty\n')
})

it('fingerprints unborn working trees and notices edits to existing untracked files', async () => {
  const f = await fixture()
  await writeFile(join(f.repository, 'new.ts'), 'one\n')
  const first = await workspaceStamp(f.repository)
  await writeFile(join(f.repository, 'new.ts'), 'two\n')
  expect(await workspaceStamp(f.repository)).not.toBe(first)
  const snapshot = await f.reviews.open(f.repository, {
    base: { kind: 'commit', ref: 'HEAD' },
    target: { kind: 'working' },
    mode: 'direct',
  })
  await f.ai.handle({
    kind: 'send',
    snapshot: snapshot.id,
    workspace: null,
    mode: 'chat',
    text: '',
    attachments: [],
  })
  expect(fixtureHarness.cwd).toBe(f.repository)
})

it('starts background agents in a matching workspace and falls back to revision-based Git inspection', async () => {
  const f = await fixture()
  await writeFile(join(f.repository, 'file.ts'), 'base\n')
  f.git('add', '.')
  f.git('commit', '-m', 'base')
  await writeFile(join(f.repository, 'file.ts'), 'target\n')
  f.git('commit', '-am', 'target')
  const snapshot = await f.reviews.open(f.repository, {
    base: { kind: 'commit', ref: 'HEAD~1' },
    target: { kind: 'commit', ref: 'HEAD' },
    mode: 'direct',
  })
  const workspace = await f.workspaces.prepare(snapshot, 'worktree', false)
  for (const kind of ['review', 'order'] as const) {
    await f.ai.handle({ kind, snapshot: snapshot.id })
    expect(fixtureHarness.cwd).toBe(workspace.path)
    expect(fixtureHarness.processCwd).toBe(workspace.path)
    expect(fixtureHarness.instructions).toContain('git ls-tree -r <ref>')
    expect(fixtureHarness.instructions).toContain('Do not use filesystem commands')
    await f.ai.close()
  }
  await writeFile(join(workspace.path, 'file.ts'), 'local edits\n')
  await f.ai.handle({ kind: 'review', snapshot: snapshot.id })
  expect(fixtureHarness.cwd).toBe(f.repository)
  expect(fixtureHarness.processCwd).toBe(f.repository)
})
