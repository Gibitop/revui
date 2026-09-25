import { _electron as electron, expect, test } from '@playwright/test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

test('tree errors recover; shadcn controls and background reads preserve the review session', async ({}, testInfo) => {
  const root = await mkdtemp(join(tmpdir(), 'revui-ui-regressions-'))
  const repository = join(root, 'repo')
  await mkdir(repository)
  const git = (...args: string[]) =>
    promisify(execFile)('git', [
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
  await git('init', '-b', 'main')
  await writeFile(join(repository, 'first.ts'), 'export const first = 1;\n')
  await writeFile(join(repository, 'second.ts'), 'export const second = 1;\n')
  await git('add', '.')
  await git('commit', '-m', 'initial')
  await writeFile(join(repository, 'first.ts'), 'export const first = 2;\n')
  await writeFile(join(repository, 'second.ts'), 'export const second = 2;\n')
  const env: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
    REVUI_USER_DATA: join(root, 'data'),
    REVUI_TEST_HIDDEN: '1',
  }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  const application = await electron.launch({ args: ['.'], env })
  try {
    const page = await application.firstWindow()
    await page.evaluate(() => {
      const NativeWorker = window.Worker
      const state = window as unknown as { treeFailure: 'preparation' | 'runtime' | null }
      state.treeFailure = 'preparation'
      window.Worker = class extends NativeWorker {
        constructor(url: string | URL, options?: WorkerOptions) {
          super(url, options)
          const send = this.postMessage.bind(this)
          this.postMessage = (
            message: unknown,
            options?: StructuredSerializeOptions | Transferable[],
          ) => {
            if (
              message &&
              typeof message === 'object' &&
              'kind' in message &&
              message.kind === 'tree' &&
              state.treeFailure
            ) {
              const failure = state.treeFailure
              queueMicrotask(() =>
                this.dispatchEvent(
                  failure === 'preparation'
                    ? new MessageEvent('message', {
                        data: { error: 'Injected preparation failure' },
                      })
                    : new ErrorEvent('error', { message: 'Injected runtime failure' }),
                ),
              )
              return
            }
            if (Array.isArray(options)) send(message, options)
            else send(message, options)
          }
        }
      }
    })
    await application.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
    }, repository)
    await page.getByRole('button', { name: 'Open repository', exact: true }).click()
    await page
      .getByRole('dialog', { name: 'Open repository' })
      .getByRole('button', { name: 'Open folder…', exact: true })
      .click()
    await expect(page.getByRole('alert')).toContainText('Injected preparation failure')
    await page.evaluate(() => {
      ;(window as unknown as { treeFailure: string }).treeFailure = 'runtime'
    })
    await page.getByRole('button', { name: 'Retry file tree' }).click()
    await expect(page.getByRole('alert')).toContainText('Injected runtime failure')
    await page.evaluate(() => {
      ;(window as unknown as { treeFailure: null }).treeFailure = null
    })
    await page.getByRole('button', { name: 'Retry file tree' }).click()
    await expect(page.getByRole('treeitem', { name: /first.ts/ })).toBeVisible()

    await page.getByRole('button', { name: 'Edit comparison', exact: true }).click()
    const from = page.getByRole('combobox', { name: 'New', exact: true })
    await from.fill('HEAD~0')
    await from.press('Escape')
    await expect(from).toHaveValue('HEAD~0')
    await page.getByRole('button', { name: 'Compare', exact: true }).click()
    await expect(page.getByText('No files match this view.')).toBeVisible()
    await expect(page.getByTestId('comparison-controls')).toHaveCSS('-webkit-app-region', 'no-drag')
    await page.getByRole('button', { name: 'Edit comparison', exact: true }).click()
    const mergeMode = page.getByRole('switch', { name: /Merge-base/ })
    await mergeMode.click()
    await expect(mergeMode).toBeChecked()
    await expect(
      page.getByRole('button', { name: 'Refresh comparison', includeHidden: true }),
    ).toBeEnabled()
    await mergeMode.click()
    await expect(mergeMode).not.toBeChecked()
    await from.fill('Uncommitted')
    await from.press('ArrowDown')
    await from.press('Enter')
    await expect(from).toHaveValue('Uncommitted')
    await page.getByRole('button', { name: 'Compare', exact: true }).click()
    const file = page.getByRole('article', { name: 'first.ts', exact: true })
    await expect(file.locator('[data-line]').first()).toBeVisible()
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    const continuous = page.getByRole('radio', { name: 'Continuous', exact: true })
    await continuous.focus()
    await page.keyboard.down('ArrowRight')
    await expect(page.getByRole('radio', { name: 'Focused file', exact: true })).toBeChecked()
    await page.keyboard.up('ArrowRight')
    await page.keyboard.press('Alt+ArrowDown')
    await page.getByRole('button', { name: 'Close settings' }).click()
    await expect(file).toBeVisible()
    await expect(page.getByRole('article')).toHaveCount(1)
    await file.locator('[data-column-number="1"][data-line-type="change-addition"]').click()
    const draft = page.getByLabel('Comment on first.ts')
    await draft.fill('Keep this draft')
    await draft.press('Alt+ArrowDown')
    await expect(draft).toHaveValue('Keep this draft')

    // Simulate a delayed background refetch without exposing Query internals to production.
    await application.evaluate(({ ipcMain }) => {
      const state = globalThis as unknown as { recentReads: number; finishRecent: () => void }
      state.recentReads = 0
      ipcMain.removeHandler('review:recent')
      ipcMain.handle('review:recent', () => {
        state.recentReads++
        return new Promise((resolve) => {
          state.finishRecent = () => resolve(null)
        })
      })
    })
    await page.evaluate(() => window.dispatchEvent(new Event('offline')))
    await page.evaluate(() => window.dispatchEvent(new Event('online')))
    await expect
      .poll(() =>
        application.evaluate(() => (globalThis as unknown as { recentReads: number }).recentReads),
      )
      .toBeGreaterThan(0)
    await expect(draft).toHaveValue('Keep this draft')
    await application.evaluate(() =>
      (globalThis as unknown as { finishRecent: () => void }).finishRecent(),
    )
    await expect(draft).toHaveValue('Keep this draft')
    await page.getByRole('button', { name: 'Post now', exact: true }).click()
    await expect(file.getByText('Keep this draft')).toBeVisible()
    for (const [width, height] of [
      [960, 640],
      [1380, 920],
    ]) {
      await application.evaluate(
        ({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(size[0], size[1]),
        [width, height],
      )
      for (const theme of ['light', 'dark'] as const) {
        await page.evaluate((theme) => window.desktop.updatePreferences({ theme }), theme)
        await expect(page.locator('html')).toHaveClass(theme === 'dark' ? 'dark' : '')
        await expect(page.getByRole('banner', { name: 'Repository toolbar' })).toBeInViewport()
        expect(
          await page
            .getByTestId('window-drag-space')
            .evaluate((node) => node.getBoundingClientRect().width),
        ).toBeGreaterThanOrEqual(90)
        await page.screenshot({
          path: testInfo.outputPath(`review-${width}-${theme}.png`),
          animations: 'disabled',
        })
      }
    }
    await application.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('review:open')
      ipcMain.handle('review:open', (_event, _repository, _comparison, _requestId, refresh) => {
        if (refresh !== true) throw new Error('Refresh must request a Git fetch')
        return new Promise((_resolve, reject) => {
          ;(globalThis as unknown as { finishRefresh: () => void }).finishRefresh = () =>
            reject(new Error('Injected fetch failure'))
        })
      })
    })
    const refresh = page.getByRole('button', { name: 'Refresh comparison', exact: true })
    await refresh.click()
    await expect(refresh).toBeDisabled()
    await expect(refresh).toHaveAttribute('aria-busy', 'true')
    await expect(refresh.locator('svg')).toHaveClass(/animate-spin/)
    await application.evaluate(() =>
      (globalThis as unknown as { finishRefresh: () => void }).finishRefresh(),
    )
    await expect(page.getByRole('alert')).toContainText('Injected fetch failure')
    await expect(refresh).toBeEnabled()
    await expect(refresh).toHaveAttribute('aria-busy', 'false')
  } finally {
    await application.close()
    await rm(root, { recursive: true, force: true })
  }
})
