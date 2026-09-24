import { ipcMain, safeStorage, shell, clipboard, type IpcMainInvokeEvent } from 'electron'
import { channels } from '../shared/desktop'
import { GitLabService, gitlabRequestSchema } from './gitlab'
import type { ReviewService } from './review'

export async function registerGitLabIPC(
  directory: string,
  reviews: ReviewService,
  assertSender: (event: IpcMainInvokeEvent) => void,
  recentRepositories: () => string[],
) {
  const gitlab = new GitLabService(
    directory,
    (id) => reviews.gitlabSnapshot(id),
    {
      encrypt: (text) => {
        if (!safeStorage.isEncryptionAvailable())
          throw new Error(
            'OS credential encryption is unavailable. Unlock your keychain and retry.',
          )
        return safeStorage.encryptString(text).toString('base64')
      },
      decrypt: (text) => safeStorage.decryptString(Buffer.from(text, 'base64')),
    },
    (url) => shell.openExternal(url),
    undefined,
    (text) => clipboard.writeText(text),
  )
  let loadError: Error | null = null
  try {
    await gitlab.load()
  } catch (error) {
    loadError = error as Error
  }
  ipcMain.handle(channels.gitlab, async (event, input: unknown) => {
    assertSender(event)
    const request = gitlabRequestSchema.parse(input)
    if (request.kind === 'open-mr' && !recentRepositories().includes(request.repository))
      throw new Error('Choose this repository using the folder picker first.')
    if (loadError && request.kind !== 'configure' && request.kind !== 'disconnect') throw loadError
    const result = await gitlab.handle(request)
    if (request.kind === 'configure' || request.kind === 'disconnect') loadError = null
    return result
  })
}
