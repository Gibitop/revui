import { _electron as electron, expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AIRequest, AIState } from '../src/shared/ai'

test('large reviews size AI trees to content, preserve selection scroll and resize diffs', async () => {
  test.setTimeout(60000)
  const root = await mkdtemp(join(tmpdir(), 'revui-performance-'))
  const repository = join(root, 'repo')
  const data = join(root, 'data')
  await mkdir(join(repository, 'src'), { recursive: true })
  await mkdir(data)
  execFileSync('git', ['-C', repository, 'init', '-b', 'main'])
  const lines = Array.from({ length: 220 }, (_, i) => `export const value${i + 1} = ${i}`)
  await writeFile(join(repository, 'src/file-000.ts'), lines.join('\n') + '\n')
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
    paths.slice(1).map((path) => writeFile(join(repository, path), 'export const value = 1\n')),
  )
  lines[102] = 'export const value103 = 9999'
  await writeFile(join(repository, paths[0]), lines.join('\n') + '\n')
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
    await page.getByRole('button', { name: 'AI review', exact: true }).click()
    await expect(page.getByRole('complementary', { name: 'Codex review panel' })).toBeVisible()
    await expect(firstDiff).toHaveAttribute('data-diff-type', 'single')
    await page.getByRole('button', { name: 'Hide file sidebar' }).click()
    await expect(page.getByTestId('file-sidebar')).toBeHidden()
    await expect(firstDiff).toHaveAttribute('data-diff-type', 'split')
    await page.getByRole('button', { name: 'Show file sidebar' }).click()
    await expect(page.getByTestId('file-sidebar')).toBeVisible()
    await expect(firstDiff).toHaveAttribute('data-diff-type', 'single')
    await page.getByRole('button', { name: 'Close AI panel', exact: true }).click()
    await expect(page.getByRole('complementary', { name: 'Codex review panel' })).toHaveCount(0)
    await expect(firstDiff).toHaveAttribute('data-diff-type', 'split')
    await expect.poll(() => page.getByRole('treeitem').count()).toBeLessThan(100)
    await page.getByRole('button', { name: 'File ordering' }).click()
    await page.getByRole('menuitemradio', { name: 'AI review order' }).click()
    const section = page.getByRole('region', { name: 'Review step 1: Large section' })
    await section.getByRole('treeitem').first().focus()
    await page.keyboard.press('Home')
    await expect(section.getByRole('treeitem', { name: /^src/ })).toBeVisible()
    await expect(section.getByRole('treeitem')).toHaveCount(paths.length + 1)
    await section.getByRole('treeitem', { name: /file-000.ts/ }).click()
    const file = page.getByRole('article', { name: paths[0], exact: true })
    const hiddenRanges = file.getByText(/\d+ unmodified lines/)
    const hiddenCount = await hiddenRanges.count()
    expect(hiddenCount).toBeGreaterThan(0)
    for (const side of ['additions', 'deletions']) {
      await section.getByRole('treeitem', { name: /file-000.ts/ }).click()
      await file.locator(`[data-${side}] [data-column-number="103"]`).hover()
      await file.locator('[data-utility-button]').click()
      const composer = file.getByTestId('thread-composer')
      await expect(composer.getByRole('textbox')).toBeInViewport()
      await expect(hiddenRanges).toHaveCount(hiddenCount)
      if (side === 'additions') {
        // Extending into folded context must still reveal the range and editor.
        for (let i = 0; i < 5; i++)
          await composer.getByRole('button', { name: 'Decrease start line' }).click()
        await expect(hiddenRanges).toHaveCount(0)
        await expect(composer.getByRole('textbox')).toBeInViewport()
        await composer.getByRole('button', { name: 'Cancel', exact: true }).click()
      } else {
        await composer.getByRole('textbox').fill('Keep this thread beside the change')
        await composer.getByRole('button', { name: 'Post now', exact: true }).click()
        await expect(file.getByText('Keep this thread beside the change')).toBeInViewport()
        await expect(hiddenRanges).toHaveCount(hiddenCount)
      }
    }

    await page.getByRole('button', { name: 'Next file', exact: true }).click()
    await expect(section.getByRole('treeitem', { selected: true })).toHaveAttribute(
      'data-item-path',
      paths[1],
    )
    const order = page.getByLabel('Suggested review order', { exact: true })
    const middleRow = section.locator(`[data-item-path="${paths[240]}"]`)
    await middleRow.evaluate((row) => row.scrollIntoView({ block: 'center' }))
    const scrollTop = await order.evaluate((element) => element.scrollTop)
    await middleRow.click()
    await expect(middleRow).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByRole('article', { name: paths[240], exact: true })).toBeInViewport()
    await expect.poll(() => order.evaluate((element) => element.scrollTop)).toBe(scrollTop)
    await expect(middleRow).toBeInViewport()
    // Keyboard navigation must reveal a row outside the sidebar's viewport.
    await section.getByRole('treeitem', { selected: true }).focus()
    await page.keyboard.press('End')
    await page.keyboard.press('Enter')
    await expect(section.getByRole('treeitem', { selected: true })).toHaveAttribute(
      'data-item-path',
      paths.at(-1)!,
    )
    await expect(section.getByRole('treeitem', { selected: true })).toBeInViewport()
    await expect(section.getByRole('treeitem')).toHaveCount(paths.length + 1)
    await page.getByRole('button', { name: 'Next file', exact: true }).click()
    await expect(section.getByRole('treeitem', { selected: true })).toHaveAttribute(
      'data-item-path',
      paths[0],
    )
    await section.getByRole('treeitem', { name: /^src/ }).click()
    await expect(section.getByRole('treeitem')).toHaveCount(1)
    await section.getByRole('treeitem', { name: /^src/ }).click()
    await expect(section.getByRole('treeitem', { name: /file-000.ts/ })).toBeVisible()
    await expect(section.getByRole('treeitem')).toHaveCount(paths.length + 1)
  } finally {
    await application.close()
    await rm(root, { recursive: true, force: true })
  }
})
