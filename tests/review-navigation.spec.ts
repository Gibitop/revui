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
  const lines = Array.from({ length: 700 }, (_, i) => `export const value${i + 1} = ${i};`)
  await writeFile(join(repository, 'src/long.ts'), lines.join('\n') + '\n')
  await git('add', '.')
  await git('commit', '-m', 'initial')
  lines[599] = 'export const needle = 9999;'
  await writeFile(join(repository, 'src/long.ts'), lines.join('\n') + '\n')
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
  let clipboardSaved = false
  try {
    const page = await application.firstWindow()
    await application.evaluate(({ BrowserWindow, dialog }, path) => {
      BrowserWindow.getAllWindows()[0].setSize(960, 640)
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
    }, repository)
    await page.getByRole('button', { name: 'Open repository', exact: true }).click()
    await page
      .getByRole('dialog', { name: 'Open repository' })
      .getByRole('button', { name: 'Open folder…', exact: true })
      .click()
    const file = page.getByRole('article', { name: 'src/long.ts', exact: true })
    await expect(file.locator('[data-line]').first()).toBeVisible()
    await application.evaluate(async ({ clipboard, ClipboardItem }) => {
      const saved = await Promise.all(
        (await clipboard.read()).map(
          async (item) =>
            new ClipboardItem(
              Object.fromEntries(
                await Promise.all(item.types.map(async (type) => [type, await item.getType(type)])),
              ),
            ),
        ),
      )
      ;(globalThis as unknown as { restoreClipboard: () => Promise<void> }).restoreClipboard = () =>
        clipboard.write(saved)
    })
    clipboardSaved = true
    await file.getByRole('button', { name: 'Copy relative path for src/long.ts' }).click()
    await expect(file.getByRole('status')).toHaveText('Copied src/long.ts')
    expect(await application.evaluate(({ clipboard }) => clipboard.readText())).toBe('src/long.ts')
    await page.getByRole('button', { name: 'Hide file sidebar' }).click()
    await expect(page.getByRole('complementary', { name: 'Review files' })).toBeHidden()
    await page.getByRole('button', { name: 'Show file sidebar' }).click()
    await expect(page.getByRole('tree')).toBeVisible()
    const toolbar = page.getByRole('banner', { name: 'Repository toolbar' })
    await expect(toolbar.getByRole('button', { name: 'Hide file sidebar' })).toBeVisible()
    await expect(
      toolbar.getByRole('button', { name: 'Search contents', exact: true }),
    ).toBeVisible()
    await expect(
      page
        .getByRole('complementary', { name: 'Review files' })
        .getByRole('button', { name: 'Next file' }),
    ).toBeVisible()
    await page.keyboard.press('Control+f')
    await expect(
      page.getByRole('textbox', { name: 'Search file contents', exact: true }),
    ).toBeFocused()
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'Search contents', exact: true }).click()
    await page.getByRole('textbox', { name: 'Search file contents', exact: true }).fill('needle')
    await page
      .getByRole('region', { name: 'Content search results' })
      .getByRole('button', { name: /src\/long.ts:600/ })
      .click()
    await expect(file.locator('[data-line="600"]').last()).toBeVisible()
    await page.getByRole('button', { name: 'Search contents', exact: true }).click()
    await page.getByRole('button', { name: 'Clear content search' }).click()
    await page.getByRole('button', { name: 'Close search', exact: true }).click()
    await file.locator('[data-column-number="600"][data-line-type="change-addition"]').click()
    const composer = file.getByTestId('thread-composer')
    await composer.getByRole('button', { name: 'Decrease start line' }).click()
    await composer.getByRole('button', { name: 'Increase end line' }).click()
    await composer.getByRole('button', { name: 'Insert suggestion' }).click()
    await expect(page.getByLabel('Comment on src/long.ts')).toHaveValue(
      '```suggestion:-2+0\n' + lines.slice(598, 601).join('\n') + '\n```',
    )
    await composer.getByRole('button', { name: 'Increase start line' }).click()
    await composer.getByRole('button', { name: 'Decrease end line' }).click()
    await page.getByLabel('Comment on src/long.ts').fill('Review this distant line')
    await page.getByRole('button', { name: 'Post now', exact: true }).click()
    await expect(file.getByText('Review this distant line')).toBeVisible()
    const stamp = file.locator('[data-testid="comment-date"]')
    await expect(stamp).toContainText(/just now|ago/)
    await stamp.hover()
    await expect(page.getByRole('tooltip')).toContainText(String(new Date().getFullYear()))
    for (const shortcut of [
      'Control+ArrowRight',
      'Meta+ArrowRight',
      'Control+ArrowLeft',
      'Meta+ArrowLeft',
    ]) {
      await page.locator('[data-testid="diff-scroll"] > div').evaluate((node) => {
        node.scrollTop = 0
      })
      await page.getByRole('button', { name: 'Next file', exact: true }).focus()
      await page.keyboard.press(shortcut)
      await expect
        .poll(() =>
          page.locator('[data-testid="diff-scroll"] > div').evaluate((node) => node.scrollTop),
        )
        .toBeGreaterThan(5000)
      await expect(file.locator('[data-line="600"]').last()).toBeVisible()
      await expect(file.getByText('Review this distant line')).toBeVisible()
    }
    await file.getByRole('button', { name: 'Delete comment' }).click()
    await page
      .getByRole('dialog', { name: 'Delete comment?' })
      .getByRole('button', { name: 'Delete comment', exact: true })
      .click()
    await expect(file.locator('[data-testid="local-thread"]')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Next thread', exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'All changes', exact: true })).toHaveCount(0)
    await expect(page.getByTestId('line-totals')).toHaveText('+1−1· 1 files')
    await page.getByRole('treeitem', { name: /long.ts/ }).click()
    await page.mouse.move(800, 400)
    await page.mouse.wheel(0, 30000)
    await expect(page.getByRole('banner', { name: 'Repository toolbar' })).toBeInViewport()
    expect(
      await page.evaluate(() => [
        window.scrollY,
        document.documentElement.scrollTop,
        document.body.scrollTop,
        document.querySelector('[data-testid="workspace"]')!.scrollTop,
      ]),
    ).toEqual([0, 0, 0, 0])
  } finally {
    if (clipboardSaved)
      await application.evaluate(() =>
        (globalThis as unknown as { restoreClipboard: () => Promise<void> }).restoreClipboard(),
      )
    await application.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('file-tree navigation stays aligned as distant diffs load and yields to manual scrolling', async () => {
  const root = await mkdtemp(join(tmpdir(), 'revui-file-navigation-'))
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
  await git('commit', '--allow-empty', '-m', 'initial')
  const paths = Array.from(
    { length: 16 },
    (_, index) => `file-${String(index).padStart(2, '0')}.ts`,
  )
  await Promise.all(
    paths.map((path) =>
      writeFile(
        join(repository, path),
        Array.from({ length: 200 }, (_, i) => `export const value${i} = ${i};`).join('\n') + '\n',
      ),
    ),
  )
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
    await application.evaluate(({ BrowserWindow, dialog }, path) => {
      BrowserWindow.getAllWindows()[0].setSize(1100, 900)
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
    }, repository)
    await page.getByRole('button', { name: 'Open repository', exact: true }).click()
    await page
      .getByRole('dialog', { name: 'Open repository' })
      .getByRole('button', { name: 'Open folder…', exact: true })
      .click()
    const last = page.getByRole('article', { name: paths.at(-1)!, exact: true })
    await expect(last).toContainText('Scroll to load file')
    const selectedItems = page.getByRole('treeitem', { selected: true })
    await expect(selectedItems).toHaveCount(1)
    for (const [button, path] of [
      ['Next file', 'file-01.ts'],
      ['Next file', 'file-02.ts'],
      ['Previous file', 'file-01.ts'],
      ['Previous file', 'file-00.ts'],
    ]) {
      await page.getByRole('button', { name: button, exact: true }).click()
      await expect(selectedItems).toHaveCount(1)
      await expect(selectedItems).toHaveAccessibleName(path)
    }
    for (const [shortcut, path] of [
      ['ArrowRight', 'file-01.ts'],
      ['ArrowRight', 'file-02.ts'],
      ['ArrowLeft', 'file-01.ts'],
      ['ArrowLeft', 'file-00.ts'],
    ]) {
      await page.keyboard.press(shortcut)
      await expect(selectedItems).toHaveCount(1)
      await expect(selectedItems).toHaveAccessibleName(path)
    }
    await page.getByLabel('Search files', { exact: true }).focus()
    await page.keyboard.press('ArrowRight')
    await expect(selectedItems).toHaveAccessibleName('file-00.ts')
    await page.getByRole('treeitem', { name: /file-15.ts/ }).click()
    await expect(selectedItems).toHaveCount(1)
    await expect(selectedItems).toHaveAccessibleName('file-15.ts')
    await expect(last.locator('[data-line]').first()).toBeVisible()
    await expect
      .poll(() =>
        last.evaluate((file) => {
          const scroll = file.closest('[data-testid="diff-scroll"]')!.firstElementChild!
          return Math.abs(file.getBoundingClientRect().top - scroll.getBoundingClientRect().top)
        }),
      )
      .toBeLessThan(2)

    // A late height change above the selected file must also preserve the destination.
    await page.getByRole('article', { name: paths[14], exact: true }).evaluate((file) => {
      file.style.paddingBottom = '800px'
    })
    await expect
      .poll(() =>
        last.evaluate((file) => {
          const scroll = file.closest('[data-testid="diff-scroll"]')!.firstElementChild!
          return Math.abs(file.getBoundingClientRect().top - scroll.getBoundingClientRect().top)
        }),
      )
      .toBeLessThan(2)

    await page.mouse.move(850, 500)
    await page.mouse.wheel(0, 500)
    await expect
      .poll(() =>
        last.evaluate((file) => {
          const scroll = file.closest('[data-testid="diff-scroll"]')!.firstElementChild!
          return file.getBoundingClientRect().top - scroll.getBoundingClientRect().top
        }),
      )
      .toBeLessThan(-100)
    await last.evaluate((file) => {
      file.style.paddingBottom = '200px'
    })
    // Wait for resize observers and their scheduled corrections, if any.
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
        ),
    )
    expect(
      await last.evaluate((file) => {
        const scroll = file.closest('[data-testid="diff-scroll"]')!.firstElementChild!
        return file.getBoundingClientRect().top - scroll.getBoundingClientRect().top
      }),
    ).toBeLessThan(-100)

    await page.getByRole('treeitem', { name: /file-00.ts/ }).click()
    await expect(
      page.getByRole('article', { name: paths[0], exact: true }).locator('[data-line]').first(),
    ).toBeVisible()
    await page.getByRole('treeitem', { name: /file-15.ts/ }).click()
    await expect
      .poll(() =>
        last.evaluate((file) => {
          const scroll = file.closest('[data-testid="diff-scroll"]')!.firstElementChild!
          return Math.abs(file.getBoundingClientRect().top - scroll.getBoundingClientRect().top)
        }),
      )
      .toBeLessThan(2)
  } finally {
    await application.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('diffs and file navigation follow the tree folders-first natural order', async () => {
  const root = await mkdtemp(join(tmpdir(), 'revui-file-order-'))
  const repository = join(root, 'repo')
  await mkdir(join(repository, 'z-folder'), { recursive: true })
  await promisify(execFile)('git', ['-C', repository, 'init', '-b', 'main'])
  await promisify(execFile)('git', [
    '-C',
    repository,
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.com',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '--allow-empty',
    '-m',
    'initial',
  ])
  const expected = ['z-folder/file2.ts', 'z-folder/file10.ts', 'a-root.ts', 'file2.ts', 'file10.ts']
  await Promise.all(
    expected.map((path) => writeFile(join(repository, path), 'export const value = 1;\n')),
  )
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
    const treeFiles = page.locator('[role="treeitem"][data-item-type="file"]')
    await expect(treeFiles).toHaveCount(expected.length)
    expect(
      await treeFiles.evaluateAll((nodes) =>
        nodes.map((node) => node.getAttribute('data-item-path')),
      ),
    ).toEqual(expected)
    expect(
      await page
        .getByRole('article')
        .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('aria-label'))),
    ).toEqual(expected)
    for (const path of expected) {
      await expect(page.getByRole('treeitem', { selected: true })).toHaveAttribute(
        'data-item-path',
        path,
      )
      await page.getByRole('button', { name: 'Next file', exact: true }).click()
    }
    await expect(page.getByRole('treeitem', { selected: true })).toHaveAttribute(
      'data-item-path',
      expected[0],
    )
    await page.getByRole('button', { name: 'Previous file', exact: true }).click()
    await expect(page.getByRole('treeitem', { selected: true })).toHaveAttribute(
      'data-item-path',
      expected.at(-1)!,
    )
  } finally {
    await application.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('unresolved threads remain accessible after an untracked file disappears', async () => {
  const root = await mkdtemp(join(tmpdir(), 'revui-missing-thread-'))
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
  await git('commit', '--allow-empty', '-m', 'initial')
  await writeFile(join(repository, 'temporary.txt'), 'review me\n')
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
    const file = page.getByRole('article', { name: 'temporary.txt', exact: true })
    await file.locator('[data-column-number="1"][data-line-type="change-addition"]').click()
    await page.getByLabel('Comment on temporary.txt').fill('Keep this unresolved note')
    await page.getByRole('button', { name: 'Post now', exact: true }).click()
    await expect(file.getByText('Keep this unresolved note')).toBeVisible()
    await rm(join(repository, 'temporary.txt'))
    await page.getByRole('button', { name: 'Refresh comparison', exact: true }).click()
    await page.getByRole('button', { name: 'Filter files', exact: true }).click()
    await page.getByRole('menuitemradio', { name: 'Unresolved threads', exact: true }).click()
    await page.getByRole('treeitem', { name: /temporary.txt/ }).click()
    await file.getByText('1 outdated threads — preserved from earlier content').click()
    await expect(file.getByText('Keep this unresolved note')).toBeVisible()
    await file.getByRole('button', { name: 'Resolve', exact: true }).click()
    await expect(page.getByRole('treeitem', { name: /temporary.txt/ })).toHaveCount(0)
  } finally {
    await application.close()
    await rm(root, { recursive: true, force: true })
  }
})
