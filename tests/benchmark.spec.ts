import { _electron as electron, expect, test } from '@playwright/test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir, cpus, totalmem, platform, arch, release } from 'node:os'
import { join } from 'node:path'
import type { AIRequest, AIState } from '../src/shared/ai'
import type { GitLabRequest, GitLabReview } from '../src/shared/gitlab'

test('100,000 tracked files and 1,000 changed files', async ({}, testInfo) => {
  test.skip(process.env.REVUI_BENCHMARK !== '1', 'Opt-in desktop performance measurement')
  test.setTimeout(180000)
  const root = await mkdtemp(join(tmpdir(), 'revui-benchmark-'))
  const repository = join(root, 'repository')
  const data = join(root, 'data')
  await mkdir(repository)
  await mkdir(data)
  const git = (...args: string[]) => promisify(execFile)('git', ['-C', repository, ...args])
  await git('init', '-b', 'main')
  const source = Array.from({ length: 40 }, (_, i) => `export const value${i} = ${i};\n`).join('')
  const modified = source.replace('value20 = 20', 'value20 = 200')
  const paths = Array.from(
    { length: 99900 },
    (_, index) =>
      `packages/pkg-${String(Math.floor(index / 999)).padStart(3, '0')}/src/group-${String(Math.floor(index / 100)).padStart(4, '0')}/file-${String(index).padStart(6, '0')}.ts`,
  )
  const changedPaths = paths.filter((_, index) => index % 99 === 0).slice(0, 1000)
  const manifests = Array.from(
    { length: 100 },
    (_, index) => `packages/pkg-${String(index).padStart(3, '0')}/package.json`,
  )
  const manifest = '{"private":true}\n'
  const stream = [
    `blob\nmark :4\ndata ${Buffer.byteLength(manifest)}\n${manifest}\n`,
    `blob\nmark :1\ndata ${Buffer.byteLength(source)}\n${source}\n`,
    'commit refs/heads/main\nmark :2\ncommitter Benchmark <benchmark@example.com> 1700000000 +0000\ndata 7\nInitial\n',
    ...paths.map((path) => `M 100644 :1 ${path}\n`),
    ...manifests.map((path) => `M 100644 :4 ${path}\n`),
    '\n',
    `blob\nmark :3\ndata ${Buffer.byteLength(modified)}\n${modified}\n`,
    'commit refs/heads/main\ncommitter Benchmark <benchmark@example.com> 1700000001 +0000\ndata 6\nChange\nfrom :2\n',
    ...changedPaths.map((path) => `M 100644 :3 ${path}\n`),
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
      // Never discover an installed/authenticated provider, even before fixture IPC is attached.
      aiProviders: {
        codex: { executable: join(root, 'unavailable-codex') },
        opencode: { executable: join(root, 'unavailable-opencode') },
      },
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
    // Fixture only the external services; Git reads, workers and rendering remain real.
    await application.evaluate(({ ipcMain, BrowserWindow }) => {
      const state = globalThis as unknown as {
        benchmarkAI: AIState
        benchmarkChunks: number
        benchmarkRefreshes: number
        startBenchmarkStream: () => void
        stopBenchmarkStream?: () => void
      }
      state.benchmarkChunks = 0
      state.benchmarkRefreshes = 0
      ipcMain.removeHandler('ai:models')
      ipcMain.handle('ai:models', () => [])
      ipcMain.removeHandler('ai:request')
      ipcMain.handle('ai:request', (_event, request: AIRequest): AIState => {
        state.benchmarkAI = {
          snapshot: request.snapshot,
          record: {
            version: 1,
            permission: 'read-only',
            chatId: 'benchmark',
            chatCreated: 0,
            otherChats: [],
            generation: 'benchmark',
            parameterContext: true,
            session: null,
            messages: [],
            findings: [],
            stale: false,
            walkthroughKey: null,
            walkthrough: [],
          },
          running: false,
          chats: {},
          order: { running: false, error: null },
          review: { running: false, error: null, completed: 0, comments: 0 },
          error: null,
          approvals: [],
          capabilities: {
            provider: 'Codex',
            version: 'fixture',
            commands: false,
            resume: false,
            structuredResults: true,
          },
        }
        return state.benchmarkAI
      })
      const refs = { base_sha: 'a'.repeat(40), start_sha: 'a'.repeat(40), head_sha: 'b'.repeat(40) }
      const review: GitLabReview = {
        session: 'benchmark',
        pinned: refs,
        aligned: false,
        userId: 1,
        discussions: [],
        approvals: null,
        mr: {
          iid: 1,
          project_id: 1,
          source_project_id: 1,
          title: 'Monorepo benchmark',
          description: 'Synthetic GitLab refresh load',
          web_url: 'https://gitlab.invalid/benchmark/-/merge_requests/1',
          source_branch: 'feature',
          target_branch: 'main',
          state: 'opened',
          draft: false,
          labels: [],
          author: { id: 1, name: 'Benchmark' },
          reviewers: [],
          sha: refs.head_sha,
          diff_refs: refs,
          head_pipeline: null,
        },
      }
      ipcMain.removeHandler('gitlab:request')
      ipcMain.handle('gitlab:request', (_event, request: GitLabRequest) => {
        if (request.kind === 'lookup') return { matches: [review.mr] }
        if (request.kind === 'refresh') {
          state.benchmarkRefreshes++
          review.discussions = Array.from({ length: 100 }, (_, i) => ({
            id: String(i),
            individual_note: true,
            notes: [
              {
                id: i,
                body: `Refresh ${state.benchmarkRefreshes}: discussion ${i}`,
                author: review.mr.author,
                system: false,
                resolvable: false,
                resolved: false,
                updated_at: new Date().toISOString(),
              },
            ],
          }))
        }
        return { review }
      })
      state.startBenchmarkStream = () => {
        const timer = setInterval(() => {
          state.benchmarkChunks++
          const ai = state.benchmarkAI
          ai.running = state.benchmarkChunks < 120
          ai.record.messages = [
            {
              id: 'stream',
              role: 'assistant',
              text: 'Reviewing **package** dependencies.\n\n'.repeat(state.benchmarkChunks),
            },
          ]
          BrowserWindow.getAllWindows()[0].webContents.send('ai:changed', ai)
          if (!ai.running) clearInterval(timer)
        }, 50)
        state.stopBenchmarkStream = () => clearInterval(timer)
      }
    })
    await page
      .getByRole('region', { name: 'Recent repositories' })
      .getByRole('button')
      .first()
      .click()
    await page.getByRole('button', { name: 'Edit comparison', exact: true }).click()
    await page.getByRole('combobox', { name: 'New', exact: true }).fill('HEAD')
    await page.getByRole('combobox', { name: 'New', exact: true }).press('Escape')
    await page.getByRole('combobox', { name: 'Old', exact: true }).fill('HEAD~1')
    await page.getByRole('combobox', { name: 'Old', exact: true }).press('Escape')
    await expect(page.getByRole('button', { name: 'Compare', exact: true })).toBeEnabled({
      timeout: 30000,
    })
    const firstVisibleMs = await page.evaluate(
      () =>
        new Promise<number>((resolve, reject) => {
          const started = performance.now()
          document
            .querySelector<HTMLButtonElement>(
              '[role="dialog"][data-state="open"] button[type="submit"]',
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
            else if (performance.now() - started > 10000)
              reject(new Error('Diff did not render within 10 seconds'))
            else requestAnimationFrame(check)
          }
          requestAnimationFrame(check)
        }),
    )
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await page.getByRole('radio', { name: 'Focused file', exact: true }).click()
    await page.getByRole('button', { name: 'Close settings' }).click()
    await page.getByRole('button', { name: 'Next file', exact: true }).click()
    await expect(
      page
        .getByRole('article', { name: changedPaths[1], exact: true })
        .locator('[data-line]')
        .first(),
    ).toBeVisible()
    const cachedNavigationMs = await page.evaluate(
      (path) =>
        new Promise<number>((resolve, reject) => {
          const started = performance.now()
          ;[...document.querySelectorAll<HTMLButtonElement>('button')]
            .find((button) => button.getAttribute('aria-label') === 'Previous file')!
            .click()
          const check = () => {
            const article = document.querySelector('article')
            const rendered =
              article?.getAttribute('aria-label') === path &&
              [...article.querySelectorAll('*')].some((element) =>
                element.shadowRoot?.querySelector('[data-line]'),
              )
            if (rendered) resolve(performance.now() - started)
            else if (performance.now() - started > 10000)
              reject(new Error('Diff did not render within 10 seconds'))
            else requestAnimationFrame(check)
          }
          requestAnimationFrame(check)
        }),
      changedPaths[0],
    )
    await page.getByRole('button', { name: 'Filter files', exact: true }).click()
    await page.getByRole('menuitemradio', { name: 'All files', exact: true }).click()
    await expect(page.getByTestId('line-totals')).toContainText('100000 files')
    await expect(page.getByRole('tree')).toBeVisible()
    await expect(page.getByRole('treeitem', { name: /file-000001.ts/ })).toBeVisible({
      timeout: 30000,
    })
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await page.getByRole('radio', { name: 'Continuous', exact: true }).click()
    await page.getByRole('button', { name: 'Close settings' }).click()
    await page.getByRole('button', { name: 'AI review', exact: true }).click()
    await expect(page.getByRole('tabpanel')).toBeVisible()
    await application.evaluate(() =>
      (globalThis as unknown as { startBenchmarkStream: () => void }).startBenchmarkStream(),
    )
    const scrolling = await page.evaluate(
      () =>
        new Promise<{ p95FrameMs: number; maxFrameMs: number; frames: number; scrollTop: number }>(
          (resolve) => {
            // Hidden windows have no native focus; exercise the real focus-refresh handler.
            Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => true })
            const refresh = setInterval(() => window.dispatchEvent(new Event('focus')), 500)
            const pane = document.querySelector('[data-testid="diff-scroll"]')!.firstElementChild!
            const gaps: number[] = []
            const started = performance.now()
            let previous = started
            const frame = (now: number) => {
              gaps.push(now - previous)
              previous = now
              pane.scrollTop += 35
              if (now - started < 6000) requestAnimationFrame(frame)
              else {
                clearInterval(refresh)
                delete (document as unknown as { hasFocus?: unknown }).hasFocus
                gaps.sort((a, b) => a - b)
                resolve({
                  p95FrameMs: Math.round(gaps[Math.floor(gaps.length * 0.95)]),
                  maxFrameMs: Math.round(gaps.at(-1)!),
                  frames: gaps.length,
                  scrollTop: pane.scrollTop,
                })
              }
            }
            requestAnimationFrame(frame)
          },
        ),
    )
    const activity = await application.evaluate(() => {
      const state = globalThis as unknown as { benchmarkChunks: number; benchmarkRefreshes: number }
      return { chunks: state.benchmarkChunks, refreshes: state.benchmarkRefreshes }
    })
    expect(activity.chunks).toBeGreaterThan(50)
    expect(activity.refreshes).toBeGreaterThan(5)
    expect(scrolling.scrollTop).toBeGreaterThan(1000)
    const result = {
      scrolling,
      activity,
      machine: {
        platform: platform(),
        release: release(),
        arch: arch(),
        cpu: cpus()[0].model,
        cores: cpus().length,
        memoryGiB: Math.round(totalmem() / 1024 ** 3),
      },
      measuredAt: new Date().toISOString(),
      packages: 100,
      linesPerFile: 40,
      firstVisibleMs: Math.round(firstVisibleMs),
      cachedNavigationMs: Math.round(cachedNavigationMs),
      tracked: 100000,
      changed: 1000,
    }
    console.log(JSON.stringify(result))
    const reportPath = testInfo.outputPath('benchmark.json')
    await writeFile(reportPath, JSON.stringify(result, null, 2) + '\n')
    await testInfo.attach('benchmark.json', {
      path: reportPath,
      contentType: 'application/json',
    })
    expect(scrolling.p95FrameMs, 'scroll frame responsiveness').toBeLessThan(100)
    expect(scrolling.maxFrameMs, 'no one-second renderer stalls').toBeLessThan(1000)
    expect(firstVisibleMs, 'first visible diff target').toBeLessThan(3000)
    expect(cachedNavigationMs, 'cached navigation target').toBeLessThan(150)
  } finally {
    // Stop fixture events before closing their window; an uncaught send after
    // destruction can open Electron's native error dialog and block cleanup.
    await application
      .evaluate(() =>
        (globalThis as unknown as { stopBenchmarkStream?: () => void }).stopBenchmarkStream?.(),
      )
      .catch(() => undefined)
    await application.close()
    await rm(root, { recursive: true, force: true })
  }
})
