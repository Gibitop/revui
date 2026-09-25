import { test, expect, _electron as electron } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

test('large search results stay responsive and retain syntax and match highlighting', async () => {
  const root = await mkdtemp(join(tmpdir(), 'revui-search-'))
  const repository = join(root, 'repo')
  await mkdir(repository)
  const git = (...args: string[]) => execFileSync('git', ['-C', repository, ...args])
  git('init', '-b', 'main')
  await writeFile(join(repository, 'large.ts'), 'export const original = true;\n')
  git('add', '.')
  git(
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.com',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-m',
    'initial',
  )
  await writeFile(
    join(repository, 'large.ts'),
    Array.from(
      { length: 600 },
      (_, index) => `export const needle${index} = { value: "needle", enabled: true };`,
    ).join('\n'),
  )
  for (let index = 0; index < 12; index++) {
    await writeFile(
      join(repository, `before-${index}.ts`),
      Array.from({ length: 100 }, (_, line) => `export const value${line} = ${line};`).join('\n'),
    )
  }
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
    await application.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
    }, repository)
    await page.getByRole('button', { name: 'Open repository', exact: true }).click()
    await page
      .getByRole('dialog', { name: 'Open repository' })
      .getByRole('button', { name: 'Open folder…', exact: true })
      .click()
    await expect(page.getByRole('article', { name: 'large.ts', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Search contents', exact: true }).click()
    const input = page.getByRole('textbox', { name: 'Search file contents' })
    const results = page.getByRole('region', { name: 'Content search results' })
    const resultRows = results.getByRole('button', { name: /^large\.ts:\d+/ })
    await input.fill('needle')
    await expect(resultRows).toHaveCount(500)
    await expect(results.locator('mark').first()).toHaveText('needle')
    await expect(results.locator('span[style*="color"]').first()).toBeVisible()

    const card = results.locator('details')
    const header = card.locator('summary')
    await header.click()
    await expect(card).not.toHaveAttribute('open')
    await expect(header).toContainText('large.ts')
    await expect(header).toContainText('500')
    await expect(results.locator('mark').first()).toBeHidden()
    await header.press('Enter')
    await expect(card).toHaveAttribute('open')
    await expect(results.locator('mark').first()).toBeVisible()
    await input.focus()

    // Typing must not tear down the existing 500-row list during the debounce.
    const firstResult = await resultRows.first().elementHandle()
    await input.press('9')
    await expect(input).toHaveValue('needle9')
    expect(await firstResult!.evaluate((node) => node.isConnected)).toBe(true)
    await expect(resultRows).toHaveCount(11)
    await expect(results.locator('mark').first()).toHaveText('needle9')

    // A newer request must win over any in-flight highlight work.
    await input.fill('needle')
    await expect(resultRows).toHaveCount(500)
    await input.fill('needle599')
    await expect(resultRows).toHaveCount(1)
    await expect(results.locator('mark').first()).toHaveText('needle599')
    await expect(results.locator('span[style*="color"]').first()).toBeVisible()
    await resultRows.click()
    await expect(page.getByRole('dialog')).toBeHidden()
    await expect(page.getByRole('article')).toHaveCount(13)
    const matchLine = page
      .getByRole('article', { name: 'large.ts', exact: true })
      .locator('[data-line="600"]')
      .last()
    await expect(matchLine).toBeInViewport()
    await page.locator('[data-testid="diff-scroll"] > div').evaluate((pane) => {
      pane.scrollTop = 0
    })
    await page.getByRole('button', { name: 'Search contents', exact: true }).click()
    await expect(resultRows).toHaveCount(1)
    await expect(results.locator('span[style*="color"]').first()).toBeVisible()
    await resultRows.click()
    await expect(page.getByRole('article')).toHaveCount(13)
    await expect(matchLine).toBeInViewport()
  } finally {
    await application.close()
    await rm(root, { recursive: true, force: true })
  }
})
