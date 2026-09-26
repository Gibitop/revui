import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { registerAIIPC } from './ai-ipc'
import { ReviewService } from './review'
import { WorkspaceService } from './workspace'
import { defaultAITasks, type AIProvider } from '../shared/ai'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))
vi.mock('./codex', async (importOriginal) => {
  const original = await importOriginal<typeof import('./codex')>()
  return {
    ...original,
    CodexHarness: class extends original.CodexHarness {
      constructor(...[event, failed]: ConstructorParameters<typeof original.CodexHarness>) {
        super(event, failed, process.execPath, [resolve('tests/fixtures/codex-server.cjs')])
      }
    },
  }
})
vi.mock('./opencode', async (importOriginal) => {
  const original = await importOriginal<typeof import('./opencode')>()
  return {
    ...original,
    OpenCodeHarness: class extends original.OpenCodeHarness {
      constructor(...[event, failed]: ConstructorParameters<typeof original.OpenCodeHarness>) {
        super(event, failed, process.execPath, [resolve('tests/fixtures/opencode-server.cjs')])
      }
    },
  }
})
const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  vi.unstubAllEnvs()
})

async function fixture(provider: AIProvider, target: 'commit' | 'index' | 'working') {
  const root = await mkdtemp(join(tmpdir(), 'revui-chat-workspace-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
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
      .toString()
      .trim()
  git('init', '-b', 'main')
  await writeFile(join(repository, 'file.ts'), 'base\n')
  git('add', '.')
  git('commit', '-m', 'base')
  const base = git('rev-parse', 'HEAD')
  await writeFile(join(repository, 'file.ts'), 'reviewed\n')
  git('commit', '-am', 'reviewed')
  const reviewed = git('rev-parse', 'HEAD')
  git('checkout', '--quiet', '--detach', base)
  await writeFile(join(repository, 'file.ts'), 'staged\n')
  git('add', 'file.ts')
  await writeFile(join(repository, 'file.ts'), 'unstaged\n')
  await writeFile(join(repository, 'untracked.txt'), 'keep\n')
  const before = git('status', '--porcelain')
  const index = git('write-tree')
  const reviews = new ReviewService(join(root, 'reviews'))
  const snapshot = await reviews.open(repository, {
    base: { kind: 'commit', ref: base },
    target: target === 'commit' ? { kind: 'commit', ref: reviewed } : { kind: target },
    mode: 'direct',
  })
  const workspaces = new WorkspaceService(join(root, 'workspaces'))
  await workspaces.load()
  const prepare = vi.spyOn(workspaces, 'prepare')
  const tasks = structuredClone(defaultAITasks)
  tasks.chat.provider = provider
  const log = join(root, 'requests.jsonl')
  vi.stubEnv(provider === 'codex' ? 'REVUI_CODEX_LOG' : 'REVUI_OPENCODE_LOG', log)
  const ai = registerAIIPC(
    join(root, 'ai'),
    reviews,
    workspaces,
    () => {},
    () => null,
    () => tasks,
  )
  cleanups.push(() => ai.close())
  const send = () =>
    ai.handle({
      kind: 'send',
      snapshot: snapshot.id,
      workspace: null,
      mode: 'chat',
      text: 'Explain this comparison',
      attachments: [],
    })
  return {
    ai,
    snapshot,
    send,
    repository,
    git,
    base,
    reviewed,
    before,
    index,
    prepare,
    workspaces,
    log,
  }
}

for (const provider of ['codex', 'opencode'] as const) {
  for (const target of ['commit', 'index', 'working'] as const) {
    it(`${provider} read-only chat reads ${target} comparisons without preparing or changing a checkout`, async () => {
      const f = await fixture(provider, target)
      await f.send()
      await expect
        .poll(async () => (await f.ai.handle({ kind: 'get', snapshot: f.snapshot.id })).running)
        .toBe(false)
      const state = await f.ai.handle({ kind: 'get', snapshot: f.snapshot.id })
      expect(state.error).toBeNull()
      expect(state.record.messages.some((message) => message.role === 'assistant')).toBe(true)
      const requests = (await readFile(f.log, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
      const prompt =
        provider === 'codex'
          ? requests.find((request) => request.method === 'turn/start').params.input[0].text
          : requests.find((request) => request.path.endsWith('/prompt')).body.text
      expect(prompt).toContain(f.repository)
      expect(prompt).toContain(target === 'commit' ? f.reviewed : `"kind":"${target}"`)
      expect(f.prepare).not.toHaveBeenCalled()
      expect(f.workspaces.list()).toEqual([])
      expect(f.git('rev-parse', 'HEAD')).toBe(f.base)
      expect(f.git('write-tree')).toBe(f.index)
      expect(f.git('status', '--porcelain')).toBe(f.before)
      expect(await readFile(join(f.repository, 'file.ts'), 'utf8')).toBe('unstaged\n')
      expect(await readFile(join(f.repository, 'untracked.txt'), 'utf8')).toBe('keep\n')
    })
  }
  it(`${provider} still requires the reviewed checkout when edits are allowed`, async () => {
    const f = await fixture(provider, 'commit')
    const state = await f.ai.handle({ kind: 'get', snapshot: f.snapshot.id })
    await f.ai.handle({
      kind: 'permission',
      snapshot: f.snapshot.id,
      chatId: state.record.chatId,
      permission: 'ask',
    })
    await expect(f.send()).rejects.toThrow('Initialize the reviewed revision')
    expect(f.prepare).not.toHaveBeenCalled()
    expect(f.git('rev-parse', 'HEAD')).toBe(f.base)
  })
}
