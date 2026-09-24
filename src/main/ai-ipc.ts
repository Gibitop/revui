import { ipcMain, type IpcMainInvokeEvent, type BrowserWindow } from 'electron'
import { createHash } from 'node:crypto'
import { readFile, lstat, readlink } from 'node:fs/promises'
import { join } from 'node:path'
import { CodexHarness } from './codex'
import { defaultAITasks, type AITaskSettings, type AIModel } from '../shared/ai'
import { channels } from '../shared/desktop'
import { AIService, aiRequestSchema } from './ai'
import type { ReviewService } from './review'
import { workspaceGit, workspaceMatches, type WorkspaceService } from './workspace'

export async function workspaceStamp(path: string) {
  const hash = createHash('sha256')
  hash.update(await workspaceGit(path, ['rev-parse', '--verify', 'HEAD']).catch(() => 'unborn'))
  for (const args of [
    ['diff', '--no-ext-diff', '--no-textconv', '--binary'],
    ['diff', '--no-ext-diff', '--no-textconv', '--binary', '--cached'],
    ['status', '--porcelain', '--untracked-files=all'],
  ])
    hash.update(await workspaceGit(path, args))
  const untracked = await workspaceGit(path, ['ls-files', '--others', '--exclude-standard', '-z'])
  for (const file of untracked.split('\0').filter(Boolean)) {
    const absolute = join(path, file)
    hash.update(file)
    hash.update(
      (await lstat(absolute)).isSymbolicLink()
        ? await readlink(absolute)
        : await readFile(absolute),
    )
  }
  return hash.digest('hex')
}

export function registerAIIPC(
  directory: string,
  reviews: ReviewService,
  workspaces: WorkspaceService,
  assertSender: (event: IpcMainInvokeEvent) => void,
  window: () => BrowserWindow | null,
  taskSettings: () => AITaskSettings = () => defaultAITasks,
  language: () => string = () => '',
  mrContext: (snapshot: string) => string = () =>
    'No merge request is associated with this comparison.',
) {
  ipcMain.handle(channels.aiModels, async (event) => {
    assertSender(event)
    const harness = new CodexHarness(
      () => {},
      () => {},
    )
    try {
      await harness.connect()
      const models: AIModel[] = []
      let cursor: string | null = null
      do {
        const result = await harness.request('model/list', { cursor, limit: 100 })
        models.push(
          ...result.data.map((model: AIModel) => ({
            model: model.model,
            displayName: model.displayName,
            supportedReasoningEfforts: model.supportedReasoningEfforts,
          })),
        )
        cursor = result.nextCursor
      } while (cursor)
      return models
    } finally {
      harness.close()
    }
  })
  const ai = new AIService(
    directory,
    reviews,
    async (id, workspace, permission = 'read-only', background = false) => {
      const snapshot = await reviews.workspaceSnapshot(id)
      let record = workspace ? workspaces.get(workspace) : await workspaces.findMatching(snapshot)
      if (background) {
        if (
          record?.phase === 'ready' &&
          (await workspaceMatches(snapshot, record.path)) &&
          !(await workspaceGit(record.path, ['status', '--porcelain', '--untracked-files=all']))
        )
          return record.path
        return snapshot.repository
      }
      if (snapshot.comparison.target.kind === 'index' && !record)
        record = await workspaces.prepare(snapshot, 'worktree', false)
      const path = record?.path ?? snapshot.repository
      if (record && (record.repository !== snapshot.repository || record.phase !== 'ready'))
        throw new Error('Initialize a matching review workspace first.')
      if (snapshot.comparison.target.kind === 'index' && path === snapshot.repository)
        throw new Error(
          'Staged AI reviews need an isolated index worktree. Initialize one with the lightning button.',
        )
      if (!(await workspaceMatches(snapshot, path)))
        throw new Error(
          'Initialize the reviewed revision with the lightning button before using Codex.',
        )
      if (
        permission === 'read-only' &&
        snapshot.comparison.target.kind !== 'working' &&
        (await workspaceGit(path, ['status', '--porcelain', '--untracked-files=all']))
      )
        throw new Error(
          'The review workspace has local changes. Restore its reviewed contents before using Codex.',
        )
      return path
    },
    workspaceStamp,
    (state) => {
      const current = window()
      if (current && !current.isDestroyed()) current.webContents.send(channels.aiChanged, state)
    },
    undefined,
    taskSettings,
    language,
    mrContext,
  )
  ipcMain.handle(channels.ai, (event, request: unknown) => {
    assertSender(event)
    return ai.handle(aiRequestSchema.parse(request))
  })
  return ai
}
