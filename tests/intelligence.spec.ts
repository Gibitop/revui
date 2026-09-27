import { _electron as electron, expect, test, type Locator } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

async function tokenPoint(line: Locator, word: string) {
  await expect(line).toBeVisible()
  return line.evaluate((element, word) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
    let node: Node | null
    while ((node = walker.nextNode())) {
      const start = node.textContent!.indexOf(word)
      if (start < 0) continue
      const range = document.createRange()
      range.setStart(node, start)
      range.setEnd(node, start + word.length)
      const rect = range.getBoundingClientRect()
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
    }
    throw new Error(`Token ${word} not found`)
  }, word)
}

test('type hovers and modifier navigation work in split, unified and unchanged full files', async () => {
  test.setTimeout(60000)
  const root = await mkdtemp(join(tmpdir(), 'revui-intelligence-ui-'))
  const repository = join(root, 'repo')
  await mkdir(repository)
  const git = (...args: string[]) =>
    execFileSync('git', [
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
  git('init', '-b', 'main')
  await writeFile(
    join(repository, 'tsconfig.json'),
    '{"compilerOptions":{"strict":true},"include":["*.ts"]}',
  )
  await writeFile(join(repository, 'model.ts'), 'export const answer: number = 42\n')
  await writeFile(
    join(repository, 'main.ts'),
    "import { answer } from './model'\nexport const result = answer\n",
  )
  git('add', '.')
  git('commit', '-m', 'base')
  // Shifts context line numbers between old and new in unified diffs.
  await writeFile(
    join(repository, 'main.ts'),
    "// new line\nimport { answer } from './model'\nexport const result = answer + 1 // trailingComment\nexport const unresolved = missingTarget\n/* blockComment\ncontinuedComment\n*/ export const afterComment = 2\n/** @see documentedSymbol */\n",
  )
  const env: Record<string, string> = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  )
  env.REVUI_USER_DATA = join(root, 'data')
  env.REVUI_TEST_HIDDEN = '1'
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  const application = await electron.launch({ args: ['.'], env })
  try {
    const page = await application.firstWindow()
    await page.evaluate(() => {
      const state = window as typeof window & { reviewWorkers: number }
      state.reviewWorkers = 0
      window.Worker = new Proxy(window.Worker, {
        construct(Target, args: ConstructorParameters<typeof Worker>) {
          if (String(args[0]).includes('review.worker')) state.reviewWorkers++
          return new Target(...args)
        },
      })
    })
    await application.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
    }, repository)
    await page.getByRole('button', { name: 'Open repository', exact: true }).click()
    await page
      .getByRole('dialog', { name: 'Open repository' })
      .getByRole('button', { name: 'Open folder…', exact: true })
      .click()
    const main = page.getByRole('article', { name: 'main.ts', exact: true })
    await expect(main).toBeVisible()
    const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'
    await application.evaluate(({ ipcMain }) => {
      // Observe the real handler so this test catches unwanted IPC, not just hidden popups.
      const handlers = (
        ipcMain as unknown as {
          _invokeHandlers: Map<string, (...args: unknown[]) => unknown>
        }
      )._invokeHandlers
      const handler = handlers.get('intelligence:query')!
      let calls = 0
      ipcMain.removeHandler('intelligence:query')
      ipcMain.handle('intelligence:query', (...args) => {
        calls++
        return handler(...args)
      })
      ipcMain.handle('test:intelligence-calls', () => calls)
    })
    await page.evaluate(() => window.desktop.updatePreferences({ diffLayout: 'split' }))
    const initialLine = main.locator('[data-code][data-additions] [data-line="3"]')
    const point = await tokenPoint(initialLine, 'answer')
    await page.mouse.move(point.x, point.y)
    await page.waitForTimeout(650) // Exceeds the hover debounce.
    await page.keyboard.down(modifier)
    await page.mouse.click(point.x, point.y)
    await page.keyboard.up(modifier)
    expect(
      await application.evaluate(({ ipcMain }) => {
        const handler = (
          ipcMain as unknown as {
            _invokeHandlers: Map<string, () => number>
          }
        )._invokeHandlers.get('test:intelligence-calls')!
        return handler()
      }),
    ).toBe(0)
    await expect(page.getByRole('tooltip', { name: 'TypeScript information' })).toHaveCount(0)
    // Normal clicks may select code while intelligence is disabled; cancel any composer.
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'Initialize workspace', exact: true }).click()
    await expect(
      page.getByRole('button', { name: 'Initialize workspace', exact: true }),
    ).toHaveClass(/text-yellow-500/)
    for (const layout of ['split', 'unified'] as const) {
      await page.evaluate(
        (layout) =>
          window.desktop.updatePreferences({
            diffLayout: layout,
            reviewLayout: layout === 'split' ? 'continuous' : 'focused',
            theme: layout === 'split' ? 'light' : 'dark',
          }),
        layout,
      )
      const code = main.locator(
        layout === 'split' ? '[data-code][data-additions]' : '[data-code][data-unified]',
      )
      const answer = code.locator('[data-line="3"]')
      await expect(code.locator('[data-line="3"]')).toBeVisible()
      await page.mouse.move(10, 10)
      await page.mouse.move(
        ...(Object.values(await tokenPoint(answer, 'answer')) as [number, number]),
      )
      await expect(page.getByRole('tooltip', { name: 'TypeScript information' })).toContainText(
        'number',
        { timeout: 15000 },
      )
      await expect
        .poll(async () =>
          page
            .getByRole('tooltip', { name: 'TypeScript information' })
            .locator('code span[style]')
            .evaluateAll(
              (spans) =>
                new Set(spans.map((span) => (span as HTMLElement).style.color).filter(Boolean))
                  .size,
            ),
        )
        .toBeGreaterThan(1)
      const tooltip = page.getByRole('tooltip', { name: 'TypeScript information' })
      // Crossing the gap must not dismiss the popup; entering it cancels the grace timer.
      const bounds = await tooltip.boundingBox()
      await page.mouse.move(bounds!.x + 6, bounds!.y - 4)
      await page.waitForTimeout(100)
      await expect(tooltip).toBeVisible()
      await page.mouse.move(bounds!.x + 24, bounds!.y + 24)
      await page.waitForTimeout(650)
      await expect(tooltip).toContainText('number')
      const previousClipboard = await application.evaluate(({ clipboard }) => clipboard.readText())
      try {
        await tooltip.locator('code').first().click({ clickCount: 3 })
        await page.keyboard.press(`${modifier}+c`)
        await expect
          .poll(() => application.evaluate(({ clipboard }) => clipboard.readText()))
          .toContain('answer')
        await expect(tooltip).toBeVisible()
      } finally {
        await application.evaluate(
          ({ clipboard }, text) => clipboard.writeText(text),
          previousClipboard,
        )
      }
      await page.keyboard.press('Escape')
      await expect(tooltip).toHaveCount(0)
      // Keep the popup within the viewport after the window becomes narrower.
      await application.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].setSize(1000, 680),
      )
      // Layout scrolling can dismiss a hover; show it again at the new code position.
      await page.mouse.move(10, 10)
      await page.mouse.move(
        ...(Object.values(await tokenPoint(answer, 'answer')) as [number, number]),
      )
      await expect(tooltip).toBeVisible()
      await expect
        .poll(() =>
          tooltip.evaluate((element) => {
            const rect = element.getBoundingClientRect()
            return (
              rect.left >= 8 &&
              rect.top >= 8 &&
              rect.right <= document.documentElement.clientWidth - 8 &&
              rect.bottom <= document.documentElement.clientHeight - 8
            )
          }),
        )
        .toBe(true)
      await application.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].setSize(1380, 920),
      )
      // Modifier previews are local and appear without sending any intelligence requests.
      for (const key of ['Meta', 'Control'] as const) {
        await page.mouse.move(
          ...(Object.values(await tokenPoint(answer, 'answer')) as [number, number]),
        )
        const callsBefore = await application.evaluate(({ ipcMain }) =>
          (
            ipcMain as unknown as { _invokeHandlers: Map<string, () => number> }
          )._invokeHandlers.get('test:intelligence-calls')!(),
        )
        await page.keyboard.down(key)
        expect(await page.locator('[data-code-link]').count()).toBeGreaterThan(0)
        await page.waitForTimeout(650)
        expect(
          await application.evaluate(({ ipcMain }) =>
            (
              ipcMain as unknown as { _invokeHandlers: Map<string, () => number> }
            )._invokeHandlers.get('test:intelligence-calls')!(),
          ),
        ).toBe(callsBefore)
        await expect(answer).toHaveCSS('cursor', 'pointer')
        await page.keyboard.up(key)
        await expect(page.locator('[data-code-link]')).toHaveCount(0)
        await expect(answer).not.toHaveCSS('cursor', 'pointer')
      }
      // Keywords are not navigation candidates and clicking them must not query LSP.
      await page.keyboard.down(modifier)
      const callsBeforeKeywords = await application.evaluate(({ ipcMain }) =>
        (ipcMain as unknown as { _invokeHandlers: Map<string, () => number> })._invokeHandlers.get(
          'test:intelligence-calls',
        )!(),
      )
      for (const word of ['export', 'const']) {
        const keyword = await tokenPoint(answer, word)
        await page.mouse.move(keyword.x, keyword.y)
        await expect(page.locator('[data-code-link]')).toHaveCount(0)
        await expect(answer).not.toHaveCSS('cursor', 'pointer')
        await page.mouse.click(keyword.x, keyword.y)
      }
      for (const [line, word] of [
        [1, 'line'],
        [3, 'trailingComment'],
        [5, 'blockComment'],
        [6, 'continuedComment'],
        [8, 'documentedSymbol'],
      ] as const) {
        const comment = code.locator(`[data-line="${line}"]`)
        const point = await tokenPoint(comment, word)
        await page.mouse.move(point.x, point.y)
        await expect(page.locator('[data-code-link]')).toHaveCount(0)
        await expect(comment).not.toHaveCSS('cursor', 'pointer')
        await page.mouse.click(point.x, point.y)
      }
      const afterComment = await tokenPoint(code.locator('[data-line="7"]'), 'afterComment')
      await page.mouse.move(afterComment.x, afterComment.y)
      expect(await page.locator('[data-code-link]').count()).toBeGreaterThan(0)
      await page.waitForTimeout(650)
      expect(
        await application.evaluate(({ ipcMain }) =>
          (
            ipcMain as unknown as { _invokeHandlers: Map<string, () => number> }
          )._invokeHandlers.get('test:intelligence-calls')!(),
        ),
      ).toBe(callsBeforeKeywords)
      await expect(page.getByRole('tooltip', { name: 'TypeScript information' })).toHaveCount(0)
      // Unresolved identifiers remain candidates and report failure only on click.
      const unresolved = await tokenPoint(code.locator('[data-line="4"]'), 'missingTarget')
      await page.mouse.move(unresolved.x, unresolved.y)
      expect(await page.locator('[data-code-link]').count()).toBeGreaterThan(0)
      await page.mouse.click(unresolved.x, unresolved.y)
      await expect(page.getByRole('tooltip', { name: 'TypeScript information' })).toHaveText(
        'No locations found in this review.',
      )
      await page.keyboard.up(modifier)
      await page.mouse.click(10, 10)
      await expect(page.getByRole('tooltip', { name: 'TypeScript information' })).toHaveCount(0)
      await page.keyboard.down(modifier)
      await page.keyboard.down('Shift')
      await page.mouse.click(
        ...(Object.values(await tokenPoint(answer, 'answer')) as [number, number]),
      )
      await page.keyboard.up('Shift')
      await page.keyboard.up(modifier)
      const locations = page.getByRole('dialog', { name: 'TypeScript information' })
      await expect(locations).toContainText('model.ts:1:')
      // Entering the popup must not prevent later outside-click dismissal.
      await locations.getByText('locations', { exact: false }).first().hover()
      await page.mouse.click(
        ...(Object.values(await tokenPoint(answer, 'result')) as [number, number]),
      )
      await expect(locations).toHaveCount(0)
      // Import string navigation works on context lines whose old/new numbers differ.
      const imported = code.locator('[data-line="2"]:not([data-line-type="change-deletion"])')
      await page.keyboard.down(modifier)
      const importPoint = await tokenPoint(imported, './model')
      await page.mouse.move(importPoint.x, importPoint.y)
      await expect.poll(() => page.locator('[data-code-link]').count()).toBeGreaterThan(0)
      await expect(imported).toHaveCSS('cursor', 'pointer')
      await main.evaluate((element) => element.setAttribute('data-navigation-retained', 'true'))
      const workersBeforeNavigation = await page.evaluate(
        () => (window as typeof window & { reviewWorkers: number }).reviewWorkers,
      )
      await page.mouse.click(importPoint.x, importPoint.y)
      await page.keyboard.up(modifier)
      const model = page.getByRole('article', { name: 'model.ts', exact: true })
      await expect(model).toBeVisible()
      await expect(main).toBeHidden()
      expect(
        await page.getByTestId('diff-scroll').evaluate((pane) => {
          const review = pane.closest('section[aria-label="Code review"]')!
          return pane.getBoundingClientRect().right <= review.getBoundingClientRect().right + 1
        }),
      ).toBe(true)
      await expect(page.getByTestId('diff-scroll').getByRole('article')).toHaveCount(1)
      for (const key of ['Control', 'Meta']) {
        await page.keyboard.press(`${key}+[`)
        await expect(model).toHaveCount(0)
        await expect(imported).toBeVisible()
        await expect(main).toHaveAttribute('data-navigation-retained', 'true')
        expect(
          await main.evaluate((file) => {
            const review = file.closest('section[aria-label="Code review"]')!
            return file.getBoundingClientRect().right <= review.getBoundingClientRect().right + 1
          }),
        ).toBe(true)
        await page.keyboard.press(`${key}+]`)
        await expect(model).toBeVisible()
        // Forward at the end of the history is a no-op.
        await page.keyboard.press(`${key}+]`)
        await expect(model).toBeVisible()
      }
      expect(
        await page.evaluate(
          () => (window as typeof window & { reviewWorkers: number }).reviewWorkers,
        ),
      ).toBe(workersBeforeNavigation)
      const declaration = model.locator('[data-code] [data-line="1"]')
      await declaration.hover()
      await page.mouse.move(
        ...(Object.values(await tokenPoint(declaration, 'answer')) as [number, number]),
      )
      await expect(page.getByRole('tooltip', { name: 'TypeScript information' })).toContainText(
        'number',
      )
      await page.keyboard.down(modifier)
      await page.keyboard.down('Shift')
      await page.mouse.click(
        ...(Object.values(await tokenPoint(declaration, 'answer')) as [number, number]),
      )
      await page.keyboard.up('Shift')
      await page.keyboard.up(modifier)
      await expect(locations).toContainText('main.ts:3:')
      await locations.getByRole('button', { name: /main.ts:3:/ }).click()
      await expect(main).toBeVisible()
      await page.keyboard.press(`${modifier}+[`)
      await expect(model).toBeVisible()
      // The declaration's original location and the clicked reference source are one visit.
      await page.keyboard.press(`${modifier}+[`)
      await expect(model).toHaveCount(0)
      await expect(imported).toBeVisible()
      await page.keyboard.press(`${modifier}+]`)
      await expect(model).toBeVisible()
      await page.keyboard.press(`${modifier}+]`)
      await expect(model).toHaveCount(0)
      await expect(answer).toBeVisible()
      await answer.hover()
      await page.keyboard.down(modifier)
      await page.mouse.click(
        ...(Object.values(await tokenPoint(answer, 'answer')) as [number, number]),
      )
      await page.keyboard.up(modifier)
      await expect(model).toBeVisible()
      await declaration.hover()
      await page.keyboard.down(modifier)
      await page.keyboard.down('Shift')
      await page.mouse.click(
        ...(Object.values(await tokenPoint(declaration, 'answer')) as [number, number]),
      )
      await page.keyboard.up('Shift')
      await page.keyboard.up(modifier)
      await locations.getByRole('button', { name: /main.ts:3:/ }).click()
    }
    expect(git('diff', '--name-only').toString().trim()).toBe('main.ts')
  } finally {
    await application.close()
    await rm(root, { recursive: true, force: true })
  }
})
