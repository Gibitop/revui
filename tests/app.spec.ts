import { _electron as electron, expect, test } from '@playwright/test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

test('desktop startup, repository picker, IPC isolation, preferences, and restart', async ({}, testInfo) => {
  const directory = await mkdtemp(join(tmpdir(), 'revui-e2e-'))
  const repository = await mkdtemp(join(tmpdir(), 'revui-example-'))
  await promisify(execFile)('git', ['init', '-b', 'main', repository])
  const env: Record<string, string> = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  )
  env.REVUI_USER_DATA = directory
  env.REVUI_TEST_HIDDEN = '1'
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  let application = await electron.launch({ args: ['.'], env })
  try {
    let page = await application.firstWindow()
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await expect(page.getByRole('heading', { name: 'Welcome to RevUI' })).toBeVisible()
    expect(
      await page.evaluate(() => typeof (window as unknown as { require?: unknown }).require),
    ).toBe('undefined')
    expect(
      await page.evaluate(() => typeof (window as unknown as { process?: unknown }).process),
    ).toBe('undefined')

    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await page.getByRole('radio', { name: 'Light', exact: true }).click()
    await expect(page.locator('html')).not.toHaveClass('dark')
    await page.getByRole('button', { name: 'Close settings' }).click()
    await page.screenshot({
      path: testInfo.outputPath('welcome-light.png'),
      animations: 'disabled',
    })
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await page.getByRole('radio', { name: 'Dark', exact: true }).click()
    await expect(page.locator('html')).toHaveClass('dark')
    await page.screenshot({
      path: testInfo.outputPath('settings-dark.png'),
      animations: 'disabled',
    })
    await page.getByRole('button', { name: 'Close settings' }).click()

    await expect(
      page.evaluate(() => window.desktop.updatePreferences({ theme: 'not-a-theme' } as never)),
    ).rejects.toThrow()
    await expect(
      page.evaluate(() => window.desktop.reopenRepository('/not-selected')),
    ).rejects.toThrow('folder picker')

    await application.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
    }, repository)
    await page.getByRole('button', { name: 'Open repository', exact: true }).click()
    await expect(page.getByRole('dialog', { name: 'Open repository' })).toBeVisible()
    await page
      .getByRole('dialog', { name: 'Open repository' })
      .getByRole('button', { name: 'Open folder…', exact: true })
      .click()
    await expect(
      page.getByRole('button', { name: new RegExp(basename(repository)) }).first(),
    ).toBeVisible()
    await page.screenshot({
      path: testInfo.outputPath('repository-dark.png'),
      animations: 'disabled',
    })
    await page.getByRole('combobox', { name: 'New', exact: true }).fill('main')
    await page.getByRole('combobox', { name: 'New', exact: true }).press('Escape')
    await page.getByRole('button', { name: 'About merge-base' }).hover()
    await expect(page.getByRole('tooltip')).toContainText('common ancestor')
    expect(
      await application.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().every((window) => !window.isVisible()),
      ),
    ).toBe(true)
    expect(errors).toEqual([])
    await application.close()

    const saved = JSON.parse(await readFile(join(directory, 'settings.json'), 'utf8'))
    expect(saved).toMatchObject({ theme: 'dark' })
    expect(saved.recentRepositories).toHaveLength(1)
    application = await electron.launch({ args: ['.'], env })
    page = await application.firstWindow()
    await expect(page.locator('html')).toHaveClass('dark')
    await expect(page.getByRole('region', { name: 'Recent repositories' })).toBeVisible()
    await page.keyboard.press('ControlOrMeta+o')
    const picker = page.getByRole('dialog', { name: 'Open repository' })
    const search = picker.getByRole('textbox', { name: 'Search recent repositories' })
    await expect(search).toBeFocused()
    await search.fill('no-such-repository')
    await expect(picker.getByRole('status')).toContainText('No matching repositories')
    await search.fill(basename(repository).toUpperCase())
    await expect(
      picker.getByRole('button', { name: new RegExp(basename(repository)) }),
    ).toBeVisible()
    await search.press('Escape')
    await page.keyboard.press('ControlOrMeta+o')
    await expect(search).toHaveValue('')
    await search.fill(basename(repository))
    await search.press('Enter')
    await expect(picker).toBeHidden()
    await expect(
      page.getByRole('button', { name: new RegExp(basename(repository)) }).first(),
    ).toBeVisible()
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await expect(page.getByRole('radio', { name: 'Dark', exact: true })).toHaveAttribute(
      'aria-checked',
      'true',
    )
  } finally {
    await application.close()
    await rm(directory, { recursive: true, force: true })
    await rm(repository, { recursive: true, force: true })
  }
})

test('local review comparisons, file layouts, threads, progress, refresh, and restart', async ({}, testInfo) => {
  test.setTimeout(90000)
  const directory = await mkdtemp(join(tmpdir(), 'revui-local-e2e-'))
  const repository = await mkdtemp(join(tmpdir(), 'revui-review-example-'))
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
  await writeFile(join(repository, 'example.ts'), 'export const value = 1;\n')
  await writeFile(
    join(repository, 'unchanged.ts'),
    Array.from({ length: 300 }, (_, index) => `// line ${index}`).join('\n') +
      '\nexport const stable = true;\n',
  )
  await git('add', '.')
  await git('commit', '-m', 'initial')
  await writeFile(join(repository, 'example.ts'), 'export const value = 2;\n')
  await git('add', '.')
  await writeFile(join(repository, 'example.ts'), 'export const value = 3;\n')
  await writeFile(join(repository, 'new.txt'), 'untracked content\n')
  const env: Record<string, string> = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  )
  env.REVUI_USER_DATA = directory
  env.REVUI_TEST_HIDDEN = '1'
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  let application = await electron.launch({ args: ['.'], env })
  try {
    let page = await application.firstWindow()
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text())
    })
    await application.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
    }, repository)
    await page.getByRole('button', { name: 'Open repository', exact: true }).click()
    await expect(page.getByRole('dialog', { name: 'Open repository' })).toBeVisible()
    await page
      .getByRole('dialog', { name: 'Open repository' })
      .getByRole('button', { name: 'Open folder…', exact: true })
      .click()
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await page.getByRole('radio', { name: 'Light', exact: true }).click()
    await page.getByRole('button', { name: 'Close settings' }).click()
    const file = page.getByRole('article', { name: 'example.ts', exact: true })
    await expect(file.locator('[data-line]')).not.toHaveCount(0)
    await expect(page.getByRole('tree')).toBeVisible()
    await expect(page.getByRole('treeitem', { name: /example.ts/ })).toBeVisible()
    // Highlighted tokens must be present, rather than only plain fallback lines.
    await expect.poll(() => file.locator('[data-line] span[style]').count()).toBeGreaterThan(0)
    const divider = page.getByRole('separator', { name: 'Resize file sidebar' })
    const dividerBox = (await divider.boundingBox())!
    await page.mouse.move(dividerBox.x + dividerBox.width / 2, dividerBox.y + 100)
    await page.mouse.down()
    await page.mouse.move(dividerBox.x + 90, dividerBox.y + 100)
    await page.mouse.up()
    await expect(divider).toHaveAttribute('aria-valuenow', /35[0-9]|36[0-9]/)
    await divider.focus()
    await page.keyboard.press('ArrowRight')
    await expect(divider).toHaveAttribute('aria-valuenow', /37[0-9]|38[0-9]/)
    const expandedWidth = await divider.getAttribute('aria-valuenow')
    await page.getByRole('button', { name: 'Hide file sidebar' }).click()
    await expect(page.getByRole('complementary', { name: 'Review files' })).toBeHidden()
    await expect(divider).toHaveCount(0)
    await page.getByRole('button', { name: 'Show file sidebar' }).click()
    await expect(divider).toHaveAttribute('aria-valuenow', expandedWidth!)
    await application.evaluate(({ clipboard }) => {
      clipboard.writeText = async (text) => {
        clipboard.readText = async () => text
      }
    })
    await file.getByRole('button', { name: 'Copy relative path for example.ts' }).click()
    await expect(file.getByRole('status')).toHaveText('Copied example.ts')
    expect(await application.evaluate(({ clipboard }) => clipboard.readText())).toBe('example.ts')
    const dragWidth = await page
      .locator('[data-testid="window-drag-space"]')
      .evaluate((element) => ({
        width: element.getBoundingClientRect().width,
        region: getComputedStyle(element).getPropertyValue('-webkit-app-region'),
      }))
    expect(dragWidth.width).toBeGreaterThanOrEqual(90)
    expect(dragWidth.region).toBe('drag')
    await expect(page.locator('[data-testid="line-totals"] [data-testid="git-added"]')).toHaveText(
      '+2',
    )
    await expect(
      page.locator('[data-testid="line-totals"] [data-testid="git-deleted"]'),
    ).toHaveText('−1')
    await expect(page.locator('[data-testid="file-sidebar"] h1')).toHaveCount(0)
    await expect(page.getByText(/Saved threads/)).toHaveCount(0)
    await expect(file.locator('[data-testid="file-heading"]')).toHaveAttribute(
      'data-git-status',
      'modified',
    )
    await expect(page.getByRole('treeitem', { name: /example.ts/ })).toHaveAttribute(
      'data-item-git-status',
      'modified',
    )
    await page.getByRole('combobox', { name: 'New', exact: true }).click()
    await expect(page.getByRole('option', { name: 'main', exact: true })).toBeVisible()
    await page.keyboard.press('Escape')
    // Each side gets its own inline composer, immediately after its selected line.
    for (const side of ['deletions', 'additions']) {
      const line = file.locator(`[data-${side}] [data-column-number="1"]`)
      await line.hover()
      const plus = file.locator('[data-utility-button]')
      await expect(plus).toBeVisible()
      await plus.click()
      await expect(file.locator('[data-testid="thread-composer"]')).toBeVisible()
      await file.getByRole('button', { name: 'Cancel', exact: true }).click()
      await line.hover()
      await page.mouse.down()
      await expect(line).toHaveAttribute('data-selected-line')
      await expect(file.locator('[data-testid="thread-composer"]')).toHaveCount(0)
      await page.mouse.up()
      const composer = file.locator('[data-testid="thread-composer"]')
      await expect(composer).toBeVisible()
      const bounds = (await composer.boundingBox())!
      const fileBounds = (await file.boundingBox())!
      expect(bounds.width).toBeLessThan(fileBounds.width * 0.55)
      expect(bounds.x < fileBounds.x + fileBounds.width / 2).toBe(side === 'deletions')
      await expect(composer.getByRole('combobox')).toHaveCount(0)
      await expect(composer.getByRole('spinbutton')).toHaveCount(0)
      await expect(composer.getByText(/New local thread/)).toHaveCount(0)
      await page.screenshot({
        path: testInfo.outputPath(`composer-${side}.png`),
        animations: 'disabled',
      })
      await composer.getByRole('button', { name: 'Cancel', exact: true }).click()
    }
    await page.getByRole('button', { name: basename(repository), exact: true }).click()
    await expect(page.getByRole('dialog', { name: 'Open repository' })).toBeVisible()
    await page
      .getByRole('dialog')
      .getByRole('button', { name: new RegExp(basename(repository)) })
      .click()
    await expect.poll(() => file.locator('[data-line] span[style]').count()).toBeGreaterThan(0)
    await page.getByRole('button', { name: 'Filter files', exact: true }).click()
    await page.getByRole('menuitemradio', { name: 'All files', exact: true }).click()
    await page.getByRole('button', { name: 'Search contents', exact: true }).click()
    await page.getByRole('textbox', { name: 'Search file contents', exact: true }).fill('stable')
    await page
      .getByRole('region', { name: 'Content search results' })
      .getByRole('button', { name: /unchanged.ts:301/ })
      .click()
    await expect(
      page.getByRole('article', { name: 'unchanged.ts' }).locator('[data-line="301"]'),
    ).toBeVisible()
    await expect(page.locator('[data-testid="thread-composer"]')).toHaveCount(0)
    const unchanged = page.getByRole('article', { name: 'unchanged.ts' })
    const startLine = unchanged.locator('[data-column-number="299"]')
    const endLine = unchanged.locator('[data-column-number="301"]')
    await startLine.hover()
    await page.mouse.down()
    await endLine.hover()
    for (const line of [299, 300, 301]) {
      await expect(unchanged.locator(`[data-line="${line}"]`)).toHaveAttribute('data-selected-line')
    }
    await expect(unchanged.locator('[data-testid="thread-composer"]')).toHaveCount(0)
    await page.mouse.up()
    await expect(unchanged.locator('[data-testid="thread-composer"]')).toBeVisible()
    await unchanged.getByRole('button', { name: 'Cancel', exact: true }).click()
    await page.getByRole('button', { name: 'Search contents', exact: true }).click()
    await page.getByRole('button', { name: 'Clear content search' }).click()
    await page.getByRole('button', { name: 'Close search', exact: true }).click()
    await page.getByRole('button', { name: 'Filter files', exact: true }).click()
    await page.getByRole('menuitemradio', { name: 'Changed files', exact: true }).click()
    await page.getByRole('button', { name: 'Next file', exact: true }).click()
    await expect(page.getByRole('tablist', { name: 'Diff layout' })).toHaveCount(0)
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await page.getByRole('radio', { name: 'Unified', exact: true }).click()
    await page.getByRole('radio', { name: 'Focused file', exact: true }).click()
    await page.getByRole('button', { name: 'Close settings' }).click()
    await expect(page.getByRole('article')).toHaveCount(1)
    await file.locator('[data-column-number="1"][data-line-type="change-addition"]').first().click()
    await page.getByLabel('Comment on example.ts').fill('Please **explain** this value.')
    await page.getByRole('button', { name: 'Save thread', exact: true }).click()
    await expect(file.getByText('Please explain this value.')).toBeVisible()
    await expect(file.locator('.markdown strong')).toHaveText('explain')
    await file.getByRole('checkbox', { name: 'Reviewed example.ts' }).check()
    await expect(file.getByRole('button', { name: 'Expand example.ts' })).toHaveAttribute(
      'aria-expanded',
      'false',
    )
    await expect(file.locator('[data-testid="local-thread"]')).toHaveCount(0)
    await file.getByRole('button', { name: 'Expand example.ts' }).click()
    await expect(file.locator('[data-testid="local-tag"]')).toHaveText('Local')
    await expect(file.locator('[data-testid="comment-date"]')).toHaveCount(1)
    await expect(file.locator('[data-testid="comment-date"]')).toContainText(/just now|ago/)
    await expect(file.locator('[data-testid="thread-dates"]')).toHaveCount(0)
    await file.getByLabel('Reply', { exact: true }).fill('It represents the new version.')
    await file.getByRole('button', { name: 'Reply', exact: true }).click()
    await expect(file.getByText('It represents the new version.')).toBeVisible()
    await file
      .locator('[data-testid="thread-message"]')
      .filter({ hasText: 'It represents the new version.' })
      .getByRole('button', { name: 'Delete comment' })
      .click()
    await expect(file.getByText('It represents the new version.')).toHaveCount(0)
    await file.getByRole('button', { name: 'Resolve', exact: true }).click()
    await expect(file.getByRole('button', { name: 'Reopen', exact: true })).toBeVisible()
    await file.getByRole('button', { name: 'Reopen', exact: true }).click()
    await page.getByRole('button', { name: 'Filter files', exact: true }).click()
    await expect(
      page.getByRole('menuitemradio', { name: 'Changed files', exact: true }),
    ).toBeChecked()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('menu', { name: 'File filter' })).toHaveCount(0)
    await page.getByRole('button', { name: 'Filter files', exact: true }).click()
    await page.getByRole('menuitemradio', { name: 'Unresolved threads', exact: true }).click()
    await expect(page.getByRole('menu', { name: 'File filter' })).toHaveCount(0)
    await expect(page.getByRole('treeitem', { name: /example.ts/ })).toBeVisible()
    await page.getByRole('button', { name: 'Filter files', exact: true }).click()
    await page.getByRole('menuitemradio', { name: 'All files', exact: true }).click()
    await page.getByLabel('Search files').fill('unchanged')
    await page.getByRole('treeitem', { name: /unchanged.ts/ }).click()
    await expect(
      page.getByRole('article', { name: 'unchanged.ts' }).locator('[data-line]'),
    ).not.toHaveCount(0)
    await page.getByLabel('Search files').fill('')
    await page.getByRole('treeitem', { name: /example.ts/ }).click()
    await expect(file.locator('[data-line]').first()).toBeVisible()
    await expect(file.locator('[data-testid="local-thread"]')).toBeVisible()
    await page.screenshot({
      path: testInfo.outputPath('local-review-light.png'),
      animations: 'disabled',
    })
    await page.getByRole('button', { name: 'Filter files', exact: true }).click()
    await page.getByRole('menuitemradio', { name: 'Changed files', exact: true }).click()
    await page.getByRole('combobox', { name: 'New', exact: true }).fill('Index')
    await page.getByRole('combobox', { name: 'New', exact: true }).press('Escape')
    await expect(file.locator('[data-line]')).not.toHaveCount(0)
    await expect(file.getByText('Please explain this value.')).toHaveCount(0)
    await expect(page.getByTestId('line-totals')).toContainText('· 1 files')
    await page.getByRole('combobox', { name: 'New', exact: true }).fill('Uncommitted')
    await page.getByRole('combobox', { name: 'New', exact: true }).press('Escape')
    await page.getByRole('combobox', { name: 'Old', exact: true }).fill('Index')
    await page.getByRole('combobox', { name: 'Old', exact: true }).press('Escape')
    await expect(file.locator('[data-line]')).not.toHaveCount(0)
    await page.getByRole('combobox', { name: 'Old', exact: true }).fill('HEAD')
    await page.getByRole('combobox', { name: 'Old', exact: true }).press('Escape')
    await expect(file.getByText('Please explain this value.')).toBeVisible()
    await expect(file.getByRole('checkbox')).toBeChecked()
    await writeFile(join(repository, 'example.ts'), 'export const value = 4;\n')
    await page.getByRole('button', { name: 'Refresh comparison', exact: true }).click()
    await expect(
      file.getByText('1 outdated threads — preserved from earlier content'),
    ).toBeVisible()
    await expect(file.getByRole('checkbox')).not.toBeChecked()
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await page.getByRole('radio', { name: 'Dark', exact: true }).click()
    await page.getByRole('button', { name: 'Close settings' }).click()
    await page.screenshot({
      path: testInfo.outputPath('local-review-dark.png'),
      animations: 'disabled',
    })
    await page.getByRole('combobox', { name: 'New', exact: true }).fill('main')
    await page.getByRole('combobox', { name: 'New', exact: true }).press('Escape')
    await page.getByRole('button', { name: 'About merge-base' }).hover()
    await expect(page.getByRole('tooltip')).toContainText('common ancestor')
    await page.getByRole('switch', { name: 'Merge-base' }).click()
    await expect(page.getByText('No files match this view.')).toBeVisible()
    await page.getByRole('button', { name: 'Swap Old and New' }).click()
    await expect(page.getByRole('combobox', { name: 'Old', exact: true })).toHaveValue('main')
    await expect(page.getByRole('combobox', { name: 'New', exact: true })).toHaveValue('HEAD')
    await page.getByRole('combobox', { name: 'Old', exact: true }).fill('HEAD')
    await page.getByRole('combobox', { name: 'Old', exact: true }).press('Escape')
    await page.getByRole('combobox', { name: 'New', exact: true }).fill('Uncommitted')
    await page.getByRole('combobox', { name: 'New', exact: true }).press('Escape')
    await expect(
      page.getByText('1 outdated threads — preserved from earlier content'),
    ).toBeVisible()
    expect(
      await application.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().every((window) => !window.isVisible()),
      ),
    ).toBe(true)
    expect(errors).toEqual([])
    await application.close()
    application = await electron.launch({ args: ['.'], env })
    page = await application.firstWindow()
    await page.getByRole('region', { name: 'Recent repositories' }).getByRole('button').click()
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await expect(page.getByRole('radio', { name: 'Unified', exact: true })).toHaveAttribute(
      'aria-checked',
      'true',
    )
    await expect(page.getByRole('radio', { name: 'Focused file', exact: true })).toHaveAttribute(
      'aria-checked',
      'true',
    )
    await page.getByRole('button', { name: 'Close settings' }).click()
    await expect(
      page.getByText('1 outdated threads — preserved from earlier content'),
    ).toBeVisible()
    const restoredDivider = page.getByRole('separator', { name: 'Resize file sidebar' })
    const restoredBox = (await restoredDivider.boundingBox())!
    await page.mouse.move(restoredBox.x + 3, restoredBox.y + 100)
    await page.mouse.down()
    await page.mouse.move(0, restoredBox.y + 100)
    await page.mouse.up()
    await expect(page.getByRole('button', { name: 'Show file sidebar' })).toBeVisible()
    await page.keyboard.press('ControlOrMeta+p')
    await expect(page.getByLabel('Search files')).toBeFocused()
    await expect(restoredDivider).toHaveAttribute('aria-valuenow', expandedWidth!)
  } finally {
    await application.close()
    await rm(directory, { recursive: true, force: true })
    await rm(repository, { recursive: true, force: true })
  }
})
