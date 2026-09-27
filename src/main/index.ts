import { IntelligenceService } from './intelligence'
import { registerAIIPC } from './ai-ipc'
import { registerGitLabIPC } from './gitlab-ipc'
import { registerWorkspaceIPC } from './workspace-ipc'
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  nativeTheme,
  session,
  shell,
  type IpcMainInvokeEvent,
} from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import { channels, type Bootstrap, type Settings } from '../shared/desktop'
import { preferencesPatchSchema, SettingsStore } from './settings'
import { inspectRepository } from './repository'
import { ReviewService, comparisonSchema, actionSchema } from './review'

app.setName('RevUI')
if (!app.isPackaged && process.env.REVUI_USER_DATA)
  app.setPath('userData', process.env.REVUI_USER_DATA)

const rendererFile = join(import.meta.dirname, '../renderer/index.html')
const rendererURL =
  !app.isPackaged && process.env.ELECTRON_RENDERER_URL
    ? new URL(process.env.ELECTRON_RENDERER_URL).href
    : pathToFileURL(rendererFile).href
let window: BrowserWindow | null = null
let quitting = false
app.on('before-quit', () => {
  quitting = true
})
let settings: SettingsStore

if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
  // The dev launcher can exit without terminating Electron on macOS.
  // Release the instance lock when the server's owning process disappears.
  const launcherPid = process.ppid
  const launcherCheck = setInterval(() => {
    try {
      process.kill(launcherPid, 0)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
        clearInterval(launcherCheck)
        app.quit()
      }
    }
  }, 1000)
  launcherCheck.unref()
  app.on('will-quit', () => clearInterval(launcherCheck))
}

function assertSender(event: IpcMainInvokeEvent): void {
  if (
    !window ||
    event.sender !== window.webContents ||
    event.senderFrame !== window.webContents.mainFrame ||
    event.senderFrame.url !== rendererURL
  ) {
    throw new Error('Untrusted IPC sender')
  }
}

function publishSettings(value: Settings): Settings {
  updateWindowTheme()
  window?.webContents.send(channels.settingsChanged, value)
  return value
}

function updateWindowTheme(): void {
  const theme = settings.get().theme
  const dark = theme === 'dark' || (theme === 'system' && nativeTheme.shouldUseDarkColors)
  window?.setBackgroundColor(dark ? '#111111' : '#ffffff')
  if (process.platform === 'win32') {
    window?.setTitleBarOverlay({
      color: dark ? '#161616' : '#fafafa',
      symbolColor: dark ? '#e5e5e5' : '#202020',
      height: 47,
    })
  }
}

function createWindow(): void {
  window = new BrowserWindow({
    width: 1380,
    height: 920,
    minWidth: 960,
    minHeight: 640,
    title: 'RevUI',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#111111' : '#ffffff',
    show: false,
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 16, y: 17 } }
      : { titleBarStyle: 'hidden' as const, titleBarOverlay: { height: 47 } }),
    webPreferences: {
      backgroundThrottling: app.isPackaged || process.env.REVUI_TEST_HIDDEN !== '1',
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  })
  updateWindowTheme()
  window.removeMenu()
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  window.webContents.on('will-attach-webview', (event) => event.preventDefault())
  window.once('ready-to-show', () => {
    if (app.isPackaged || process.env.REVUI_TEST_HIDDEN !== '1') window?.show()
    else app.dock?.hide()
  })
  window.on('closed', () => {
    window = null
  })
  void window.loadURL(rendererURL)
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (window?.isMinimized()) window.restore()
    window?.focus()
  })
  app
    .whenReady()
    .then(async () => {
      settings = new SettingsStore(app.getPath('userData'))
      await settings.load()
      session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) =>
        callback(false),
      )
      session.defaultSession.setPermissionCheckHandler(() => false)

      ipcMain.handle(channels.bootstrap, (event): Bootstrap => {
        assertSender(event)
        return {
          settings: settings.get(),
          warning: settings.warning,
          platform: process.platform,
          systemTheme: nativeTheme.shouldUseDarkColors ? 'dark' : 'light',
          versions: {
            app: app.getVersion(),
            electron: process.versions.electron,
            node: process.versions.node,
            chrome: process.versions.chrome,
          },
        }
      })
      ipcMain.handle(channels.preferences, async (event, patch: unknown) => {
        assertSender(event)
        return publishSettings(
          await settings.updatePreferences(preferencesPatchSchema.parse(patch)),
        )
      })
      ipcMain.handle(channels.chooseRepository, async (event) => {
        assertSender(event)
        const result = await dialog.showOpenDialog(window!, {
          title: 'Open a Git repository',
          properties: ['openDirectory'],
        })
        if (result.canceled || !result.filePaths[0]) return null
        const repository = await inspectRepository(result.filePaths[0])
        publishSettings(await settings.rememberRepository(repository.path))
        return repository
      })
      ipcMain.handle(channels.reopenRepository, async (event, value: unknown) => {
        assertSender(event)
        const path = z.string().min(1).max(32768).parse(value)
        if (!settings.get().recentRepositories.includes(path))
          throw new Error('Choose this repository using the folder picker first.')
        const repository = await inspectRepository(path)
        publishSettings(await settings.rememberRepository(repository.path))
        return repository
      })
      ipcMain.handle(channels.openWebLink, (event, value: unknown) => {
        assertSender(event)
        const url = new URL(z.string().min(1).max(32768).parse(value))
        if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password)
          throw new Error('Only HTTP(S) links without embedded credentials can be opened.')
        return shell.openExternal(url.href)
      })
      ipcMain.handle(channels.copyRelativePath, (event, path: unknown) => {
        assertSender(event)
        return clipboard.writeText(z.string().min(1).max(32768).parse(path))
      })
      ipcMain.handle(channels.copyText, (event, text: unknown) => {
        assertSender(event)
        return clipboard.writeText(z.string().max(100000).parse(text))
      })
      const reviews = new ReviewService(app.getPath('userData'))
      const gitlab = await registerGitLabIPC(
        app.getPath('userData'),
        reviews,
        assertSender,
        () => settings.get().recentRepositories,
      )
      const repositoryPath = (value: unknown) => {
        const path = z.string().min(1).max(32768).parse(value)
        if (!settings.get().recentRepositories.includes(path))
          throw new Error('Choose this repository using the folder picker first.')
        return path
      }
      ipcMain.handle(channels.getRepositoryRefs, (event, repository: unknown) => {
        assertSender(event)
        return reviews.refs(repositoryPath(repository))
      })
      ipcMain.handle(
        channels.searchReviewContents,
        (event, id: unknown, query: unknown, paths: unknown, options: unknown) => {
          assertSender(event)
          return reviews.search(
            z.string().parse(id),
            z
              .string()
              .min(1)
              .max(1000)
              .refine((value) => !/[\0\r\n]/.test(value))
              .parse(query),
            z.array(z.string()).optional().parse(paths),
            z
              .object({
                matchCase: z.boolean().optional(),
                wholeWord: z.boolean().optional(),
                regex: z.boolean().optional(),
              })
              .optional()
              .parse(options),
          )
        },
      )
      ipcMain.handle(
        channels.openComparison,
        (event, repository: unknown, comparison: unknown, requestId: unknown, refresh: unknown) => {
          assertSender(event)
          intelligence.close()
          ai.close()
          return reviews.open(
            repositoryPath(repository),
            comparisonSchema.parse(comparison),
            z.string().uuid().parse(requestId),
            z.boolean().optional().parse(refresh),
          )
        },
      )
      ipcMain.handle(channels.recentComparison, (event, repository: unknown) => {
        assertSender(event)
        return reviews.recent(repositoryPath(repository))
      })
      ipcMain.handle(channels.cancelComparison, (event, requestId: unknown) => {
        assertSender(event)
        reviews.cancel(z.string().uuid().parse(requestId))
      })
      ipcMain.handle(
        channels.loadReviewFile,
        (event, id: unknown, path: unknown, force: unknown) => {
          assertSender(event)
          return reviews.content(
            z.string().parse(id),
            z.string().min(1).max(32768).parse(path),
            z.boolean().parse(force),
          )
        },
      )
      ipcMain.handle(channels.getReviewRecord, (event, id: unknown) => {
        assertSender(event)
        return reviews.records(z.string().parse(id))
      })
      ipcMain.handle(channels.updateReviewRecord, (event, id: unknown, action: unknown) => {
        assertSender(event)
        return reviews.update(z.string().parse(id), actionSchema.parse(action))
      })
      app.on('will-quit', () => reviews.cancel())
      nativeTheme.on('updated', () => {
        updateWindowTheme()
        window?.webContents.send(
          channels.systemThemeChanged,
          nativeTheme.shouldUseDarkColors ? 'dark' : 'light',
        )
      })
      const workspaceTools = await registerWorkspaceIPC(
        app.getPath('userData'),
        reviews,
        settings,
        assertSender,
        () => window,
      )
      const intelligence = new IntelligenceService(reviews, workspaceTools.workspaces)
      ipcMain.handle(channels.intelligence, (event, value: unknown) => {
        assertSender(event)
        return intelligence.query(
          z
            .object({
              snapshot: z.string().uuid(),
              workspace: z.string().uuid().nullable(),
              path: z.string().min(1).max(32768),
              line: z.number().int().min(0).max(10000000),
              character: z.number().int().min(0).max(10000000),
              kind: z.enum(['hover', 'definition', 'references']),
            })
            .parse(value),
        )
      })
      const ai = registerAIIPC(
        app.getPath('userData'),
        reviews,
        workspaceTools.workspaces,
        assertSender,
        () => window,
        () => settings.get().aiTasks,
        () => settings.get().aiLanguage,
        (snapshot) => gitlab.aiContext(snapshot),
        () => settings.get().aiProviders,
      )
      app.on('before-quit', () => {
        intelligence.close()
        ai.close()
        workspaceTools.stopScripts()
      })
      createWindow()
      const guardClose = () => {
        const current = window
        if (!current) return
        let allowed = false
        let prompting = false
        current.on('close', (event) => {
          if (allowed) return
          const repositories = [
            ...new Set(
              workspaceTools.workspaces
                .list()
                .filter((record) => record.kind === 'in-place' && record.phase !== 'restored')
                .map((record) => record.repository),
            ),
          ]
          if (!repositories.length) workspaceTools.stopScripts()
          event.preventDefault()
          if (prompting) return
          prompting = true
          void (async () => {
            try {
              for (const path of repositories)
                if (!(await workspaceTools.leave(path))) {
                  quitting = false
                  return
                }
              intelligence.close()
              await ai.close()
              await ai.flush()
              allowed = true
              if (quitting) app.quit()
              else current.close()
            } catch (error) {
              dialog.showErrorBox('Workspace restoration failed', String(error))
            } finally {
              prompting = false
            }
          })()
        })
      }
      guardClose()
      app.on('activate', () => {
        if (!window) {
          createWindow()
          guardClose()
        }
      })
    })
    .catch((error: unknown) => {
      dialog.showErrorBox(
        'RevUI could not start',
        error instanceof Error ? error.message : String(error),
      )
      app.exit(1)
    })
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
