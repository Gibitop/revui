import { ideChoices, type IDE, type WorkspaceListing } from '../shared/workspace'
import {
  clipboard,
  dialog,
  ipcMain,
  shell,
  type BrowserWindow,
  type IpcMainInvokeEvent,
} from 'electron'
import { z } from 'zod'
import { channels } from '../shared/desktop'
import {
  WorkspaceService,
  IgnoredWorkspaceFiles,
  openWorkspaceIDE,
  runWorkspaceScript,
  workspaceGit,
  workspaceMatches,
} from './workspace'
import type { ReviewService } from './review'
import type { SettingsStore } from './settings'

export async function registerWorkspaceIPC(
  directory: string,
  reviews: ReviewService,
  settings: SettingsStore,
  sender: (event: IpcMainInvokeEvent) => void,
  window: () => BrowserWindow | null,
) {
  const workspaces = new WorkspaceService(directory)
  await workspaces.load()
  let script: AbortController | null = null
  const repository = (value: unknown) => {
    const path = z.string().parse(value)
    if (!settings.get().recentRepositories.includes(path))
      throw new Error('Open this repository first.')
    return path
  }
  const workspace = (value: unknown) => workspaces.get(z.string().uuid().parse(value))
  const commands = (path: string) =>
    settings.get().repositoryCommands[path] ?? settings.get().workspaceCommands
  const leave = async (path: string) => {
    if (script) throw new Error('Wait for the setup script or cancel it before leaving.')
    for (const record of workspaces
      .list(path)
      .filter((r) => r.kind === 'in-place' && r.phase !== 'restored')) {
      const result = await dialog.showMessageBox(window()!, {
        type: 'question',
        message: 'Restore the original workspace?',
        detail: `The in-place review at ${record.path} has a saved original checkout${record.stash ? ' and stash' : ''}. Leaving it as-is keeps the recovery record.`,
        buttons: ['Restore', 'Leave as-is', 'Cancel'],
        cancelId: 2,
        defaultId: 0,
      })
      if (result.response === 2) return false
      if (result.response === 0) {
        await workspaces.restore(record.id)
      }
    }
    return true
  }
  ipcMain.handle(channels.findWorkspace, async (event, id) => {
    sender(event)
    return workspaces.findMatching(await reviews.workspaceSnapshot(z.string().uuid().parse(id)))
  })
  ipcMain.handle(channels.workspaceMatches, async (event, id, workspaceId) => {
    sender(event)
    const snapshot = await reviews.workspaceSnapshot(z.string().uuid().parse(id))
    let path = snapshot.repository
    if (workspaceId !== null) {
      const record = workspace(workspaceId)
      if (record.repository !== snapshot.repository || record.phase !== 'ready') return false
      path = record.path
    }
    return workspaceMatches(snapshot, path)
  })
  ipcMain.handle(channels.initializeWorkspace, async (event, id, workspaceId) => {
    sender(event)
    if (script) throw new Error('A setup script is already running')
    const snapshot = await reviews.workspaceSnapshot(z.string().uuid().parse(id))
    let path = snapshot.repository
    if (workspaceId === null) {
      const existing = await workspaces.findMatching(snapshot)
      if (existing) workspaceId = existing.id
    }
    if (workspaceId !== null) {
      const record = workspace(workspaceId)
      if (record.repository !== snapshot.repository || record.phase !== 'ready')
        throw new Error('Workspace is not ready.')
      path = record.path
    }
    if (!(await workspaceMatches(snapshot, path))) return null
    script = new AbortController()
    try {
      if (workspaceId !== null) await workspaces.markInitialized(workspaceId, false)
      await runWorkspaceScript(
        path,
        commands(snapshot.repository),
        (data) => window()?.webContents.send(channels.scriptOutput, data),
        script.signal,
      )
      if (workspaceId !== null) await workspaces.markInitialized(workspaceId, true)
      return { workspace: workspaceId as string | null }
    } finally {
      script = null
    }
  })
  ipcMain.handle(channels.workspaceAction, async (event, id, action) => {
    sender(event)
    const record = workspace(id)
    if (z.enum(['copy-path', 'copy-revision', 'open']).parse(action) !== 'open') {
      clipboard.writeText(action === 'copy-revision' ? record.target : record.path)
    } else {
      const error = await shell.openPath(record.path)
      if (error) throw new Error(error)
    }
  })
  ipcMain.handle(channels.listWorkspaces, async (event, path) => {
    sender(event)
    const filter = path === undefined ? undefined : repository(path)
    await workspaces.pruneMissing()
    return Promise.all(
      workspaces.list(filter).map(async (record): Promise<WorkspaceListing> => {
        const refs = await workspaceGit(record.repository, [
          'for-each-ref',
          `--points-at=${record.target}`,
          '--format=%(refname)',
          'refs/heads',
          'refs/remotes',
          'refs/tags',
        ]).catch(() => '')
        return {
          ...record,
          refs: refs
            .split('\n')
            .filter(Boolean)
            .map((ref) => ({
              name: ref.replace(/^refs\/(heads|remotes|tags)\//, ''),
              kind: ref.startsWith('refs/tags/') ? 'tag' : 'branch',
            })),
        }
      }),
    )
  })
  ipcMain.handle(channels.leaveWorkspace, (event, path) => {
    sender(event)
    return leave(repository(path))
  })
  ipcMain.handle(channels.prepareWorkspace, async (event, id, kind) => {
    sender(event)
    if (script) throw new Error('Wait for the setup script or cancel it first.')
    const snapshot = await reviews.workspaceSnapshot(z.string().uuid().parse(id))
    const mode = z.enum(['worktree', 'in-place']).parse(kind)
    let allowStash = false
    if (mode === 'in-place') {
      const dirty = await workspaceGit(snapshot.repository, [
        'status',
        '--porcelain',
        '--untracked-files=all',
        '--ignore-submodules=none',
      ])
      if (dirty) {
        const result = await dialog.showMessageBox(window()!, {
          type: 'warning',
          message: 'Stash local changes and check out this revision?',
          detail:
            'Tracked and untracked changes will be stashed before checkout. RevUI records the exact stash and original checkout for restoration.',
          buttons: ['Stash and check out', 'Cancel'],
          defaultId: 1,
          cancelId: 1,
        })
        if (result.response !== 0) return null
        allowStash = true
      }
    }
    return workspaces.prepare(snapshot, mode, allowStash)
  })
  ipcMain.handle(channels.restoreWorkspace, async (event, id) => {
    sender(event)
    if (script) throw new Error('Wait for the setup script or cancel it first.')
    const record = workspace(id)
    await workspaces.restore(record.id)
  })
  ipcMain.handle(channels.removeWorkspace, async (event, id) => {
    sender(event)
    if (script) throw new Error('Wait for the setup script or cancel it first.')
    const record = workspace(id)
    try {
      await workspaces.remove(record.id)
    } catch (error) {
      if (!(error instanceof IgnoredWorkspaceFiles)) throw error
      const result = await dialog.showMessageBox(window()!, {
        type: 'warning',
        message: 'Remove worktree and its ignored files?',
        detail: `This permanently deletes ${record.path}, including these ignored files and directories:\n\n${error.files.slice(0, 4000)}\n\nIgnored files can include dependencies, build output, and local configuration.`,
        buttons: ['Remove worktree', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
      })
      if (result.response !== 0) return
      if (script) throw new Error('Wait for the setup script or cancel it first.')
      // Recheck edits and HEAD after the confirmation before allowing ignored-file cleanup.
      await workspaces.remove(record.id, true)
    }
  })
  ipcMain.handle(channels.runWorkspaceScript, async (event, id) => {
    sender(event)
    const record = workspace(id)
    if (record.phase !== 'ready') throw new Error('Workspace is not ready')
    if (script) throw new Error('A setup script is already running')
    script = new AbortController()
    try {
      await workspaces.markInitialized(record.id, false)
      await runWorkspaceScript(
        record.path,
        commands(record.repository),
        (data) => window()?.webContents.send(channels.scriptOutput, data),
        script.signal,
      )
      await workspaces.markInitialized(record.id, true)
    } finally {
      script = null
    }
  })
  ipcMain.handle(
    channels.openWorkspaceIDE,
    async (event, repositoryPath, workspaceId, path, line, value) => {
      sender(event)
      const repo = repository(repositoryPath)
      let root = repo
      if (workspaceId !== null) {
        const record = workspace(workspaceId)
        if (record.repository !== repo || record.phase !== 'ready')
          throw new Error('Workspace is not ready.')
        root = record.path
      }
      const ide = z.enum(Object.keys(ideChoices) as [IDE, ...IDE[]]).parse(value)
      await openWorkspaceIDE(
        root,
        z.string().min(1).max(32768).nullable().parse(path),
        z.number().int().min(1).max(10000000).parse(line),
        ide,
      )
    },
  )
  ipcMain.handle(channels.cancelWorkspaceScript, (event) => {
    sender(event)
    script?.abort()
  })
  ipcMain.handle(channels.acknowledgeRestoration, async (event, id) => {
    sender(event)
    if (script) throw new Error('Wait for the setup script or cancel it first.')
    const record = workspace(id)
    const result = await dialog.showMessageBox(window()!, {
      type: 'warning',
      message: 'Mark manual restoration complete?',
      detail:
        'Confirm that you have recovered your changes and returned to the original checkout. RevUI keeps the recorded stash as a recovery copy.',
      buttons: ['Mark restored', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
    })
    if (result.response === 0) await workspaces.acknowledgeRestoration(record.id)
  })
  return { leave, workspaces, stopScripts: () => script?.abort() }
}
