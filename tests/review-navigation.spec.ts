import { test, expect, _electron as electron } from '@playwright/test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

test('long-file thread navigation stays inside the review pane; native copy and sidebar collapse work', async () => {
  const root = await mkdtemp(join(tmpdir(), 'revui-navigation-'))
  const repository = join(root, 'repo')
  await mkdir(join(repository, 'src'), { recursive: true })
  const git = (...args: string[]) => promisify(execFile)('git', ['-C', repository, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args])
  await git('init', '-b', 'main')
  const lines = Array.from({ length: 700 }, (_, i) => `export const value${i + 1} = ${i};`)
  await writeFile(join(repository, 'src/long.ts'), lines.join('\n') + '\n')
  await git('add', '.'); await git('commit', '-m', 'initial')
  lines[599] = 'export const needle = 9999;'
  await writeFile(join(repository, 'src/long.ts'), lines.join('\n') + '\n')
  const env: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)), REVUI_USER_DATA: join(root, 'data'), REVUI_TEST_HIDDEN: '1' }
  delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
  const application = await electron.launch({ args: ['.'], env })
  let clipboardSaved = false
  try {
    const page = await application.firstWindow()
    await application.evaluate(({ BrowserWindow, dialog }, path) => {
      BrowserWindow.getAllWindows()[0].setSize(960, 640)
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
    }, repository)
    await page.getByRole('button', { name: 'Open repository', exact: true }).click()
    await page.getByRole('button', { name: 'Add repository', exact: true }).click()
    const file = page.getByRole('article', { name: 'src/long.ts', exact: true })
    await expect(file.locator('[data-line]').first()).toBeVisible()
    await application.evaluate(async ({ clipboard, ClipboardItem }) => {
      const saved = await Promise.all((await clipboard.read()).map(async (item) => new ClipboardItem(Object.fromEntries(await Promise.all(item.types.map(async (type) => [type, await item.getType(type)]))))))
      ;(globalThis as unknown as { restoreClipboard: () => Promise<void> }).restoreClipboard = () => clipboard.write(saved)
    })
    clipboardSaved = true
    await file.getByRole('button', { name: 'Copy relative path for src/long.ts' }).click()
    await expect(file.getByRole('status')).toHaveText('Copied src/long.ts')
    expect(await application.evaluate(({ clipboard }) => clipboard.readText())).toBe('src/long.ts')
    await page.getByRole('button', { name: 'Hide file sidebar' }).click()
    await expect(page.getByRole('complementary', { name: 'Review files' })).toBeHidden()
    await page.getByRole('button', { name: 'Show file sidebar' }).click()
    await expect(page.getByRole('tree')).toBeVisible()
    await page.getByLabel('Search file contents').fill('needle')
    await page.getByRole('region', { name: 'Content search results' }).getByRole('button', { name: /src\/long.ts:600/ }).click()
    await expect(file.locator('[data-line="600"]').last()).toBeVisible()
    await page.getByRole('button', { name: 'Clear content search' }).click()
    await file.locator('[data-column-number="600"][data-line-type="change-addition"]').click()
    await page.getByLabel('Comment on src/long.ts').fill('Review this distant line')
    await page.getByRole('button', { name: 'Save thread', exact: true }).click()
    await expect(file.getByText('Review this distant line')).toBeVisible()
    const stamp = file.locator('.comment-date')
    await expect(stamp).toContainText(/just now|ago/)
    await stamp.hover()
    await expect(page.getByRole('tooltip')).toContainText(String(new Date().getFullYear()))
    for (let i = 0; i < 2; i++) {
      await page.locator('.diff-scroll').evaluate((node) => { node.scrollTop = 0 })
      await page.getByRole('button', { name: 'Thread →', exact: true }).click()
      await expect.poll(() => page.locator('.diff-scroll').evaluate((node) => node.scrollTop)).toBeGreaterThan(5000)
      await expect(file.locator('[data-line="600"]').last()).toBeVisible()
      await expect(file.getByText('Review this distant line')).toBeVisible()
    }
    await file.getByRole('button', { name: 'Delete comment' }).click()
    await expect(file.locator('.local-thread')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Thread →', exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'All changes', exact: true })).toHaveCount(0)
    await expect(page.getByText('1 files · 0 unresolved')).toBeVisible()
    await page.getByRole('treeitem', { name: /long.ts/ }).click()
    await page.mouse.move(800, 400); await page.mouse.wheel(0, 30000)
    await expect(page.getByRole('banner', { name: 'Repository toolbar' })).toBeInViewport()
    expect(await page.evaluate(() => [window.scrollY, document.documentElement.scrollTop, document.body.scrollTop, document.querySelector('.workspace')!.scrollTop])).toEqual([0, 0, 0, 0])
  } finally {
    if (clipboardSaved) await application.evaluate(() => (globalThis as unknown as { restoreClipboard: () => Promise<void> }).restoreClipboard())
    await application.close()
    await rm(root, { recursive: true, force: true })
  }
})
