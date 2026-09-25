import { _electron as electron, expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AIRequest, AIState } from '../src/shared/ai'

test('large reviews keep trees virtualized and resize diffs when sidebars toggle', async () => {
  test.setTimeout(60000)
  const root = await mkdtemp(join(tmpdir(), 'revui-performance-'))
  const repository = join(root, 'repo')
  const data = join(root, 'data')
  await mkdir(join(repository, 'src'), { recursive: true })
  await mkdir(data)
  execFileSync('git', ['-C', repository, 'init', '-b', 'main'])
  await writeFile(join(repository, 'src/file-000.ts'), 'export const value = 0\n')
  execFileSync('git', ['-C', repository, 'add', '.'])
  execFileSync('git', [
    '-C',
    repository,
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.com',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-m',
    'base',
  ])
  const paths = Array.from({ length: 479 }, (_, i) => `src/file-${String(i).padStart(3, '0')}.ts`)
  await Promise.all(
    paths.map((path) => writeFile(join(repository, path), 'export const value = 1\n')),
  )
  await writeFile(
    join(data, 'settings.json'),
    JSON.stringify({
      version: 1,
      theme: 'light',
      diffLayout: 'auto',
      recentRepositories: [],
      reviewLayout: 'continuous',
      aiPanelOpen: false,
    }),
  )
  const env: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
    REVUI_USER_DATA: data,
    REVUI_TEST_HIDDEN: '1',
  }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  const application = await electron.launch({ args: ['.'], env })
  try {
    const page = await application.firstWindow()
    await application.evaluate(
      ({ ipcMain, dialog, BrowserWindow }, { repository, paths }) => {
        BrowserWindow.getAllWindows()[0].setSize(1200, 900)
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [repository] })
        ipcMain.removeHandler('ai:request')
        ipcMain.handle('ai:request', (_event, request: AIRequest): AIState => ({
          snapshot: request.snapshot,
          record: {
            version: 1,
            permission: 'read-only',
            chatId: 'test',
            chatCreated: 0,
            otherChats: [],
            generation: 'test',
            parameterContext: false,
            session: null,
            messages: [],
            findings: [],
            stale: false,
            walkthroughKey: 'test',
            walkthrough: [
              {
                id: 'large',
                title: 'Large section',
                rationale: 'Review all changes.',
                paths,
                done: false,
              },
            ],
          },
          running: false,
          chats: {},
          order: { running: false, error: null },
          review: { running: false, error: null, completed: 0, comments: 0 },
          error: null,
          approvals: [],
          capabilities: {
            provider: 'Codex',
            version: 'test',
            commands: false,
            resume: false,
            structuredResults: true,
          },
        }))
      },
      { repository, paths },
    )
    await page.getByRole('button', { name: 'Open repository', exact: true }).click()
    await page
      .getByRole('dialog', { name: 'Open repository' })
      .getByRole('button', { name: 'Open folder…' })
      .click()
    await expect(page.getByRole('article')).toHaveCount(479)
    const firstDiff = page
      .getByRole('article', { name: paths[0], exact: true })
      .locator('[data-diff-type]')
    await expect(firstDiff).toHaveAttribute('data-diff-type', 'split')
    await page.getByRole('button', { name: 'Codex review', exact: true }).click()
    await expect(page.getByRole('complementary', { name: 'Codex review panel' })).toBeVisible()
    await expect(firstDiff).toHaveAttribute('data-diff-type', 'single')
    await page.getByRole('button', { name: 'Hide file sidebar' }).click()
    await expect(page.getByTestId('file-sidebar')).toBeHidden()
    await expect(firstDiff).toHaveAttribute('data-diff-type', 'split')
    await page.getByRole('button', { name: 'Show file sidebar' }).click()
    await expect(page.getByTestId('file-sidebar')).toBeVisible()
    await expect(firstDiff).toHaveAttribute('data-diff-type', 'single')
    await page.getByRole('button', { name: 'Close Codex', exact: true }).click()
    await expect(page.getByRole('complementary', { name: 'Codex review panel' })).toHaveCount(0)
    await expect(firstDiff).toHaveAttribute('data-diff-type', 'split')
    await page.getByRole('button', { name: 'File ordering' }).click()
    await page.getByRole('menuitemradio', { name: 'AI review order' }).click()
    const section = page.getByRole('region', { name: 'Review step 1: Large section' })
    await section.getByRole('treeitem').first().focus()
    await page.keyboard.press('Home')
    await expect(section.getByRole('treeitem', { name: /^src/ })).toBeVisible()
    await expect.poll(() => section.getByRole('treeitem').count()).toBeLessThan(100)
    await section.getByRole('treeitem', { name: /file-000.ts/ }).click()
    await page.getByRole('button', { name: 'Next file', exact: true }).click()
    await expect(section.getByRole('treeitem', { selected: true })).toHaveAttribute(
      'data-item-path',
      paths[1],
    )
    // Keyboard navigation to an unmounted row must scroll the virtual tree into view.
    await section.getByRole('treeitem', { selected: true }).focus()
    await page.keyboard.press('End')
    await page.keyboard.press('Enter')
    await expect(section.getByRole('treeitem', { selected: true })).toHaveAttribute(
      'data-item-path',
      paths.at(-1)!,
    )
    await expect(section.getByRole('treeitem', { selected: true })).toBeVisible()
    await expect.poll(() => section.getByRole('treeitem').count()).toBeLessThan(100)
    await page.getByRole('button', { name: 'Next file', exact: true }).click()
    await expect(section.getByRole('treeitem', { selected: true })).toHaveAttribute(
      'data-item-path',
      paths[0],
    )
    await section.getByRole('treeitem', { name: /^src/ }).click()
    await expect(section.getByRole('treeitem')).toHaveCount(1)
    await section.getByRole('treeitem', { name: /^src/ }).click()
    await expect(section.getByRole('treeitem', { name: /file-000.ts/ })).toBeVisible()
    await expect.poll(() => section.getByRole('treeitem').count()).toBeLessThan(100)
  } finally {
    await application.close()
    await rm(root, { recursive: true, force: true })
  }
})
