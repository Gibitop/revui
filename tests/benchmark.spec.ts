import { _electron as electron, expect, test } from '@playwright/test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir, cpus, totalmem, platform, arch } from 'node:os'
import { join } from 'node:path'

test('100,000 tracked files and 1,000 changed files', async ({}, testInfo) => {
  test.skip(process.env.REVUI_BENCHMARK !== '1', 'Opt-in desktop performance measurement')
  test.setTimeout(120000)
  const root = await mkdtemp(join(tmpdir(), 'revui-benchmark-'))
  const repository = join(root, 'repository')
  const data = join(root, 'data')
  await mkdir(repository)
  await mkdir(data)
  const git = (...args: string[]) => promisify(execFile)('git', ['-C', repository, ...args])
  await git('init', '-b', 'main')
  const source = 'export const value = 1;\n'
  const modified = 'export const value = 2;\n'
  const paths = Array.from(
    { length: 100000 },
    (_, index) =>
      `src/group-${String(Math.floor(index / 100)).padStart(4, '0')}/file-${String(index).padStart(6, '0')}.ts`,
  )
  const stream = [
    `blob\nmark :1\ndata ${Buffer.byteLength(source)}\n${source}\n`,
    'commit refs/heads/main\nmark :2\ncommitter Benchmark <benchmark@example.com> 1700000000 +0000\ndata 7\nInitial\n',
    ...paths.map((path) => `M 100644 :1 ${path}\n`),
    '\n',
    `blob\nmark :3\ndata ${Buffer.byteLength(modified)}\n${modified}\n`,
    'commit refs/heads/main\ncommitter Benchmark <benchmark@example.com> 1700000001 +0000\ndata 6\nChange\nfrom :2\n',
    ...paths.slice(0, 1000).map((path) => `M 100644 :3 ${path}\n`),
    '\n',
  ].join('')
  await new Promise<void>((resolve, reject) => {
    const child = execFile('git', ['-C', repository, 'fast-import', '--quiet'], (error) => {
      if (error) reject(error)
      else resolve()
    })
    child.stdin!.end(stream)
  })
  await git('reset', '--hard', 'HEAD')
  await writeFile(
    join(data, 'settings.json'),
    JSON.stringify({
      version: 1,
      theme: 'light',
      diffLayout: 'split',
      reviewLayout: 'continuous',
      aiPanelOpen: false,
      terminalPanelOpen: false,
      recentRepositories: [repository],
    }),
  )
  const env: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
    REVUI_USER_DATA: data,
  }
  env.REVUI_TEST_HIDDEN = '1'
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  const application = await electron.launch({ args: ['.'], env })
  try {
    const page = await application.firstWindow()
    await page.getByRole('region', { name: 'Recent repositories' }).getByRole('button').click()
    await page.getByRole('combobox', { name: 'From', exact: true }).fill('HEAD')
    await page.getByRole('combobox', { name: 'From', exact: true }).press('Escape')
    await page.getByRole('combobox', { name: 'To', exact: true }).fill('HEAD~1')
    await page.getByRole('combobox', { name: 'To', exact: true }).press('Escape')
    const firstVisibleMs = await page.evaluate(
      () =>
        new Promise<number>((resolve) => {
          const started = performance.now()
          document
            .querySelector<HTMLButtonElement>(
              '[data-testid="comparison-controls"] button[type="submit"]',
            )!
            .click()
          const check = () => {
            const article = document.querySelector('article')
            const rendered =
              article &&
              [...article.querySelectorAll('*')].some((element) =>
                element.shadowRoot?.querySelector('[data-line]'),
              )
            if (rendered) resolve(performance.now() - started)
            else requestAnimationFrame(check)
          }
          requestAnimationFrame(check)
        }),
    )
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await page.getByRole('radio', { name: 'Focused file', exact: true }).click()
    await page.getByRole('button', { name: 'Close settings' }).click()
    await page.getByRole('button', { name: 'Change →', exact: true }).click()
    await expect(
      page.getByRole('article', { name: paths[1], exact: true }).locator('[data-line]').first(),
    ).toBeVisible()
    const cachedNavigationMs = await page.evaluate(
      (path) =>
        new Promise<number>((resolve) => {
          const started = performance.now()
          ;[...document.querySelectorAll<HTMLButtonElement>('button')]
            .find((button) => button.textContent === '← Change')!
            .click()
          const check = () => {
            const article = document.querySelector('article')
            const rendered =
              article?.getAttribute('aria-label') === path &&
              [...article.querySelectorAll('*')].some((element) =>
                element.shadowRoot?.querySelector('[data-line]'),
              )
            if (rendered) resolve(performance.now() - started)
            else requestAnimationFrame(check)
          }
          requestAnimationFrame(check)
        }),
      paths[0],
    )
    await page.getByRole('radio', { name: 'All files', exact: true }).click()
    await expect(page.getByText('100000 files · 0 unresolved')).toBeVisible()
    await expect(page.getByRole('tree')).toBeVisible()
    const result = {
      machine: {
        platform: platform(),
        arch: arch(),
        cpu: cpus()[0].model,
        cores: cpus().length,
        memoryGiB: Math.round(totalmem() / 1024 ** 3),
      },
      firstVisibleMs: Math.round(firstVisibleMs),
      cachedNavigationMs: Math.round(cachedNavigationMs),
      tracked: 100000,
      changed: 1000,
    }
    console.log(JSON.stringify(result))
    await testInfo.attach('benchmark.json', {
      body: JSON.stringify(result, null, 2),
      contentType: 'application/json',
    })
  } finally {
    await application.close()
    await rm(root, { recursive: true, force: true })
  }
})
