import AxeBuilder from '@axe-core/playwright'
import { _electron as electron, expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('accessible review surfaces and keyboard-only dialogs, search, navigation and resizing', async ({}, testInfo) => {
  test.setTimeout(90000)
  const root = await mkdtemp(join(tmpdir(), 'revui-accessibility-'))
  const repository = join(root, 'repo')
  await mkdir(repository)
  execFileSync('git', ['init', '-b', 'main', repository])
  await writeFile(join(repository, 'first.ts'), 'export const first = 1\n')
  await writeFile(join(repository, 'second.ts'), 'export const second = 2\n')
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
    await expect(page.getByRole('heading', { name: 'Welcome to RevUI' })).toBeVisible()
    await application.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
    }, repository)
    await page.keyboard.press('ControlOrMeta+o')
    const picker = page.getByRole('dialog', { name: 'Open repository' })
    await expect(picker).toBeVisible()
    await picker.getByRole('button', { name: 'Open folder…' }).focus()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('article', { name: 'first.ts', exact: true })).toBeVisible()

    for (const theme of ['light', 'dark'] as const) {
      await page.evaluate((theme) => window.desktop.updatePreferences({ theme }), theme)
      await expect(page.locator('html')).toHaveClass(theme === 'dark' ? 'dark' : '')
      for (const surface of ['review', 'settings', 'search', 'chat'] as const) {
        if (surface === 'settings') await page.keyboard.press('ControlOrMeta+,')
        if (surface === 'search') await page.keyboard.press('ControlOrMeta+f')
        if (surface === 'chat')
          await page.getByRole('button', { name: 'AI review', exact: true }).click()
        const results = await new AxeBuilder({ page })
          // Electron cannot create the extra browser page used by axe's frame aggregation.
          .setLegacyMode()
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
          .analyze()
        const reportPath = testInfo.outputPath(`${theme}-${surface}-accessibility.json`)
        await writeFile(reportPath, JSON.stringify(results, null, 2) + '\n')
        await testInfo.attach(`${theme}-${surface}-accessibility.json`, {
          path: reportPath,
          contentType: 'application/json',
        })
        expect(results.violations, `${theme} ${surface}`).toEqual([])
        if (surface === 'settings' || surface === 'search') {
          await page.keyboard.press('Escape')
          await expect(page.getByRole('dialog', { includeHidden: true })).toHaveCount(0)
        }
        if (surface === 'chat') await page.getByRole('button', { name: 'Close AI panel' }).click()
      }
    }

    const settingsButton = page.getByRole('button', { name: 'Settings', exact: true })
    await settingsButton.focus()
    await page.keyboard.press('Enter')
    const settings = page.getByRole('dialog', { name: 'Settings', exact: true })
    await settings.getByRole('tab', { name: 'Appearance', exact: true }).focus()
    await page.keyboard.press('ArrowDown')
    await expect(settings.getByRole('tab', { name: 'GitLab', exact: true })).toBeFocused()
    await expect(settings.getByRole('tab', { name: 'GitLab', exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    // Verify focus containment in both directions, including wrapping at each end.
    for (const key of ['Tab', 'Shift+Tab']) {
      for (let i = 0; i < 20; i++) {
        await page.keyboard.press(key)
        expect(await settings.evaluate((dialog) => dialog.contains(document.activeElement))).toBe(
          true,
        )
      }
    }
    await page.keyboard.press('Escape')
    await expect(settings).toBeHidden()
    await expect(settingsButton).toBeFocused()
    await page.keyboard.press('ControlOrMeta+p')
    await expect(page.getByRole('textbox', { name: 'Search files', exact: true })).toBeFocused()
    await page.keyboard.type('second')
    await expect(page.getByRole('treeitem', { name: /second.ts/ })).toBeVisible()
    await page.getByRole('textbox', { name: 'Search files', exact: true }).fill('')
    const divider = page.getByRole('separator', { name: 'Resize file sidebar' })
    const width = Number(await divider.getAttribute('aria-valuenow'))
    await divider.focus()
    await page.keyboard.press('ArrowRight')
    await expect(divider).toHaveAttribute('aria-valuenow', String(width + 20))
    await page.keyboard.press('ArrowLeft')
    await expect(divider).toHaveAttribute('aria-valuenow', String(width))
    await page.keyboard.press('Alt+ArrowDown')
    await expect(page.getByRole('treeitem', { selected: true })).toHaveAttribute(
      'data-item-path',
      'second.ts',
    )
    await page.keyboard.press('ControlOrMeta+f')
    await expect(
      page.getByRole('textbox', { name: 'Search file contents', exact: true }),
    ).toBeFocused()
    await page.keyboard.type('second')
    const hit = page.getByRole('button', { name: /second.ts:1/ })
    await expect(hit).toBeVisible()
    await hit.focus()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('dialog', { name: 'Search file contents' })).toBeHidden()
    await expect(page.getByRole('article', { name: 'second.ts', exact: true })).toBeInViewport()
  } finally {
    await application.close()
    await rm(root, { recursive: true, force: true })
  }
})
