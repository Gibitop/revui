import { _electron as electron, expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('OpenCode provider settings, chat, approvals, cancellation, review, order and restart', async () => {
  test.skip(
    process.platform === 'win32',
    'POSIX executable fixture; adapter tests are cross-platform.',
  )
  const root = await mkdtemp(join(tmpdir(), 'revui-opencode-ui-'))
  const repository = join(root, 'repo'),
    bin = join(root, 'bin')
  await mkdir(repository)
  await mkdir(bin)
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
  await writeFile(join(repository, 'file.ts'), 'export const value = 1\n')
  git('add', '.')
  git('commit', '-m', 'base')
  await writeFile(join(repository, 'file.ts'), 'export const value = 2\n')
  for (const provider of ['codex', 'opencode']) {
    await writeFile(
      join(bin, provider),
      `#!${process.execPath}\n${await readFile(`tests/fixtures/${provider}-server.cjs`, 'utf8')}`,
    )
    await chmod(join(bin, provider), 0o755)
  }
  const env: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
    PATH: `${bin}:${process.env.PATH}`,
    REVUI_USER_DATA: join(root, 'data'),
    REVUI_TEST_HIDDEN: '1',
    REVUI_OPENCODE_FINDING: '1',
    REVUI_OPENCODE_LOG: join(root, 'opencode-requests.jsonl'),
  }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  let app = await electron.launch({ args: ['.'], env })
  try {
    let page = await app.firstWindow()
    await page.clock.install()
    await page.reload()
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
    }, repository)
    await page.getByRole('button', { name: 'Open repository', exact: true }).click()
    await page.getByRole('button', { name: 'Open folder…', exact: true }).click()
    await expect(page.getByRole('article', { name: 'file.ts', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await page.getByRole('tab', { name: 'AI Providers', exact: true }).click()
    const provider = page
      .locator('section')
      .filter({ has: page.getByRole('heading', { name: 'OpenCode', exact: true }) })
    await expect(page.getByRole('switch', { name: /^Enable / })).toHaveCount(0)
    await provider.getByText('Configuration').click()
    await expect(provider.getByRole('textbox', { name: 'OpenCode binary path' })).toHaveValue(
      'opencode',
    )
    await expect(provider).toContainText('1 models available')
    await expect(page.getByRole('tab').filter({ hasText: /^AI / })).toHaveText([
      'AI Providers',
      'AI Scenarios',
    ])
    await page.screenshot({ path: test.info().outputPath('providers.png') })
    const checks = (await readFile(join(root, 'opencode-requests.jsonl'), 'utf8'))
      .split('\n')
      .filter((line) => line.includes('"path":"/api/model"')).length
    await page.keyboard.press('Escape')
    await page.clock.fastForward(300_000)
    await expect
      .poll(
        async () =>
          (await readFile(join(root, 'opencode-requests.jsonl'), 'utf8'))
            .split('\n')
            .filter((line) => line.includes('"path":"/api/model"')).length,
      )
      .toBe(checks + 1)
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await page.getByRole('tab', { name: 'AI Providers', exact: true }).click()
    await expect(provider).toContainText('Connected · 1 models available')
    await page.getByRole('tab', { name: 'AI Scenarios', exact: true }).click()
    await expect(page.getByRole('tabpanel').locator('select')).toHaveCount(0)
    const header = page.getByRole('dialog').locator('header')
    const headerBeforeScroll = await header.boundingBox()
    await page
      .getByRole('combobox', { name: 'Review order provider', exact: true })
      .scrollIntoViewIfNeeded()
    expect(await header.boundingBox()).toEqual(headerBeforeScroll)
    await expect(header.getByRole('heading', { name: 'AI Scenarios', exact: true })).toBeVisible()
    await expect(header.getByRole('button', { name: 'Close settings' })).toBeVisible()

    const discoveryRequests = await readFile(join(root, 'opencode-requests.jsonl'), 'utf8')
    for (const task of ['Chat', 'Code review', 'Review order']) {
      await page.getByRole('combobox', { name: `${task} provider`, exact: true }).click()
      await expect(
        page.getByRole('option', { name: 'OpenCode', exact: true }).locator('img'),
      ).toBeVisible()
      await page.getByRole('option', { name: 'OpenCode', exact: true }).click()
      await page.getByRole('combobox', { name: `${task} model`, exact: true }).click()
      await expect(
        page.getByRole('option', { name: 'fixture/Claude Fixture', exact: true }).locator('img'),
      ).toBeVisible()
      if (task === 'Chat')
        await page.screenshot({ path: test.info().outputPath('model-icons.png') })
      if (task === 'Chat') {
        const search = page.getByRole('combobox', { name: 'Search Chat models', exact: true })
        await search.fill('no-such-model')
        await expect(page.getByText('No matching models.', { exact: true })).toBeVisible()
        await search.fill('FIXTURE/model')
        await expect(page.getByRole('option')).toHaveCount(1)
        await expect(
          page.getByRole('option', { name: 'fixture/Claude Fixture', exact: true }),
        ).toBeVisible()
        await search.fill('claude')
        await expect(page.getByRole('option')).toHaveCount(1)
        await page.keyboard.press('ArrowDown')
        await page.keyboard.press('Enter')
      } else {
        await page.getByRole('option', { name: 'fixture/Claude Fixture', exact: true }).click()
      }
      await expect(
        page.getByRole('combobox', { name: `${task} model`, exact: true }).locator('img'),
      ).toBeVisible()
      if (task === 'Chat') {
        await page.getByRole('combobox', { name: 'Chat model', exact: true }).click()
        await expect(
          page.getByRole('combobox', { name: 'Search Chat models', exact: true }),
        ).toHaveValue('')
        await expect(page.getByRole('option')).toHaveCount(2)
        await page.keyboard.press('Escape')
        await expect(
          page.getByRole('combobox', { name: 'Search Chat models', exact: true }),
        ).toHaveCount(0)
        await expect(page.getByRole('combobox', { name: 'Chat model', exact: true })).toContainText(
          'fixture/Claude Fixture',
        )
      }
      await expect(
        page.getByRole('combobox', { name: `${task} reasoning effort`, exact: true }),
      ).toBeEnabled()
      await page.getByRole('combobox', { name: `${task} reasoning effort`, exact: true }).click()
      await page.getByRole('option', { name: 'high', exact: true }).click()
    }
    expect(await readFile(join(root, 'opencode-requests.jsonl'), 'utf8')).toBe(discoveryRequests)
    await expect(page.getByText('Loading available models…')).toHaveCount(0)
    await page.screenshot({ path: test.info().outputPath('ai-settings.png') })
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Close settings', exact: true })
      .click()
    await page.getByRole('button', { name: 'AI review', exact: true }).click()
    // The snapshot may already have an unsent Codex tab; new tabs follow the settings.
    await page.getByRole('button', { name: 'New chat', exact: true }).click()
    let panel = page.getByRole('complementary', { name: 'OpenCode review panel' })
    await panel.getByRole('textbox', { name: 'Message OpenCode' }).fill('Explain the change')
    await expect(panel.getByRole('button', { name: 'Send', exact: true })).toBeEnabled()
    await panel.getByRole('textbox', { name: 'Message OpenCode' }).press('Enter')
    await expect(panel).toContainText('OpenCode streamed answer')
    await expect(
      panel.getByRole('combobox', { name: 'Chat permissions' }).locator('option[value="auto"]'),
    ).toBeDisabled()
    await panel.getByRole('combobox', { name: 'Chat permissions' }).selectOption('ask')
    await panel.getByRole('button', { name: 'Initialize workspace', exact: true }).click()
    await panel.getByRole('textbox', { name: 'Message OpenCode' }).fill('Approval now')
    await expect(panel.getByRole('button', { name: 'Send', exact: true })).toBeEnabled()
    await panel.getByRole('textbox', { name: 'Message OpenCode' }).press('Enter')
    const approval = panel.getByRole('alertdialog', { name: 'AI approval' })
    await expect(approval).toBeVisible()
    await approval.getByRole('button', { name: 'Deny', exact: true }).click()
    await expect(panel).toContainText('Denied tool')
    await panel.getByRole('textbox', { name: 'Message OpenCode' }).fill('Hold now')
    await expect(panel.getByRole('button', { name: 'Send', exact: true })).toBeEnabled()
    await panel.getByRole('textbox', { name: 'Message OpenCode' }).press('Enter')
    await panel.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(panel.getByRole('button', { name: 'Cancel', exact: true })).toHaveCount(0)
    await panel.getByRole('button', { name: 'Review changes', exact: true }).click()
    await expect(page.getByTestId('ai-review-notification')).toContainText('1 new issue found')
    await expect(page.getByRole('article', { name: 'file.ts', exact: true })).toContainText(
      'The changed value breaks the existing contract.',
    )
    await page.getByRole('button', { name: 'File ordering', exact: true }).click()
    await page.getByRole('menuitemradio', { name: 'AI review order', exact: true }).click()
    await expect(page.getByRole('region', { name: 'Review step 1: Public behavior' })).toBeVisible()
    await app.close()
    app = await electron.launch({ args: ['.'], env })
    page = await app.firstWindow()
    await page
      .getByRole('region', { name: 'Recent repositories' })
      .getByRole('button', { name: /^repo / })
      .click()
    panel = page.getByRole('complementary', { name: 'OpenCode review panel' })
    await expect(panel).toContainText('OpenCode streamed answer')
    await expect(panel.getByRole('combobox', { name: 'Chat permissions' })).toHaveValue('ask')
    await panel.getByRole('button', { name: 'Initialize workspace', exact: true }).click()
    await panel.getByRole('textbox', { name: 'Message OpenCode' }).fill('Continue')
    await expect(panel.getByRole('button', { name: 'Send', exact: true })).toBeEnabled()
    await panel.getByRole('textbox', { name: 'Message OpenCode' }).press('Enter')
    await expect(panel.getByText('OpenCode streamed answer', { exact: true })).toHaveCount(2)
    await expect(panel).not.toContainText('Replayed content')
  } finally {
    await app.close()
    await rm(root, { recursive: true, force: true })
  }
})
