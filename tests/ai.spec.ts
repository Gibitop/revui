import { _electron as electron, expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('Codex chat, approvals, cancellation, inline findings, local conversion and walkthrough persistence', async () => {
  test.skip(
    process.platform === 'win32',
    'The executable protocol fixture uses a POSIX shebang; Windows CLI validation is separate.',
  )
  const root = await mkdtemp(join(tmpdir(), 'revui-ai-ui-'))
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
  await mkdir(join(repository, 'helpers'))
  await writeFile(join(repository, 'helpers/a.ts'), 'export const helper = 1\n')
  await writeFile(join(repository, 'z.ts'), 'export const entry = 1\n')
  await writeFile(
    join(bin, 'codex'),
    `#!${process.execPath}\n${await readFile('tests/fixtures/codex-server.cjs', 'utf8')}`,
  )
  await chmod(join(bin, 'codex'), 0o755)
  const env: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
    PATH: `${bin}:${process.env.PATH}`,
    REVUI_USER_DATA: join(root, 'data'),
    REVUI_TEST_HIDDEN: '1',
    REVUI_CODEX_LOG: join(root, 'codex-requests.jsonl'),
  }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  let application = await electron.launch({ args: ['.'], env })
  try {
    let page = await application.firstWindow()
    await application.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
    }, repository)
    await page.getByRole('button', { name: 'Open repository', exact: true }).click()
    await page
      .getByRole('dialog', { name: 'Open repository' })
      .getByRole('button', { name: 'Open folder…', exact: true })
      .click()
    await expect(page.getByRole('article', { name: 'file.ts', exact: true })).toBeVisible()
    await expect
      .poll(async () => readFile(join(root, 'codex-requests.jsonl'), 'utf8').catch(() => ''))
      .toContain('model/list')
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await page.getByRole('tab', { name: 'AI Scenarios', exact: true }).click()
    for (const [label, model, effort] of [
      ['Chat', 'chat-model', 'low'],
      ['Code review', 'review-model', 'high'],
      ['Review order', 'order-model', 'low'],
    ]) {
      await page.getByRole('combobox', { name: `${label} model`, exact: true }).click()
      await page.getByRole('option', { name: model, exact: true }).click()
      await expect(page.getByRole('combobox', { name: `${label} reasoning effort` })).toBeEnabled()
      await page.getByRole('combobox', { name: `${label} reasoning effort` }).click()
      await page.getByRole('option', { name: effort, exact: true }).click()
      await expect
        .poll(() => page.evaluate(() => window.desktop.getBootstrap()))
        .toMatchObject({
          settings: {
            aiTasks: {
              [label === 'Chat' ? 'chat' : label === 'Code review' ? 'review' : 'order']: {
                model,
                effort,
              },
            },
          },
        })
    }
    await page.getByRole('textbox', { name: 'Preferred response language' }).fill('Serbian')
    await page.getByRole('textbox', { name: 'Preferred response language' }).press('Tab')
    await expect
      .poll(() => page.evaluate(() => window.desktop.getBootstrap()))
      .toMatchObject({ settings: { aiLanguage: 'Serbian' } })
    await page.getByRole('button', { name: 'Close settings' }).click()
    await page.getByRole('button', { name: 'File view', exact: true }).click()
    await page.getByRole('menuitemradio', { name: 'Flat list', exact: true }).click()
    await page.getByRole('button', { name: 'File ordering', exact: true }).click()
    await page.getByRole('menuitemradio', { name: 'AI review order', exact: true }).click()
    const order = page.getByRole('complementary', { name: 'Review files' })
    await expect(order.getByRole('status')).toContainText('Preparing your review')
    await expect(order.getByRole('heading', { name: '1. Public behavior' })).toBeVisible()
    const orderNotification = page.getByTestId('ai-order-notification')
    await expect(orderNotification).toContainText('AI review order ready')
    await orderNotification
      .getByRole('button', { name: 'Dismiss review order notification' })
      .click()
    await expect(orderNotification).toHaveCount(0)
    await expect(order.getByRole('checkbox')).toHaveCount(0)
    await expect(order.getByRole('button', { name: 'file.ts', exact: true })).toHaveAttribute(
      'data-git-status',
      'modified',
    )
    await expect(order.getByRole('button', { name: 'z.ts', exact: true })).toHaveAttribute(
      'data-git-status',
      'untracked',
    )
    await expect(
      order.getByRole('button', { name: 'file.ts', exact: true }).locator('svg use'),
    ).toHaveAttribute('href', /.+/)
    await order.getByRole('button', { name: 'z.ts', exact: true }).click()
    await order.getByRole('button', { name: 'Next file', exact: true }).click()
    await expect(order.getByRole('button', { name: 'file.ts', exact: true })).toHaveAttribute(
      'aria-current',
      'true',
    )
    await order.getByRole('button', { name: 'Next file', exact: true }).click()
    await expect(order.getByRole('button', { name: 'helpers/a.ts', exact: true })).toHaveAttribute(
      'aria-current',
      'true',
    )
    await order.getByRole('button', { name: 'Next file', exact: true }).click()
    await expect(order.getByRole('button', { name: 'z.ts', exact: true })).toHaveAttribute(
      'aria-current',
      'true',
    )
    await page.locator('body').press('ArrowRight')
    await expect(order.getByRole('button', { name: 'file.ts', exact: true })).toHaveAttribute(
      'aria-current',
      'true',
    )
    await order.getByRole('button', { name: 'Previous file', exact: true }).click()
    await expect(order.getByRole('button', { name: 'z.ts', exact: true })).toHaveAttribute(
      'aria-current',
      'true',
    )
    await order.getByRole('button', { name: 'file.ts', exact: true }).click()
    await expect(page.getByRole('complementary', { name: 'Codex review panel' })).toHaveCount(0)
    const orderRequests = await readFile(join(root, 'codex-requests.jsonl'), 'utf8')
    await page.getByRole('button', { name: 'File view', exact: true }).click()
    await page.getByRole('menuitemradio', { name: 'Tree view', exact: true }).click()
    const firstSection = order.getByRole('region', { name: 'Review step 1: Public behavior' })
    const secondSection = order.getByRole('region', { name: 'Review step 2: Supporting files' })
    await expect(firstSection.locator('file-tree-container')).toHaveCount(1)
    await expect(secondSection.locator('file-tree-container')).toHaveCount(1)
    await expect(firstSection.getByTestId('review-step-header')).toHaveCSS('position', 'sticky')
    await expect(secondSection.getByTestId('review-step-header')).toHaveCSS('top', '0px')
    await expect(firstSection.getByRole('treeitem')).toHaveCount(2)
    await expect(secondSection.getByRole('treeitem', { name: /helpers/ })).toBeVisible()
    await firstSection.getByRole('treeitem', { name: /file.ts/ }).click()
    await order.getByRole('button', { name: 'Next file', exact: true }).click()
    await expect(firstSection.getByRole('treeitem', { selected: true })).toHaveAttribute(
      'data-item-path',
      'z.ts',
    )
    await order.getByRole('button', { name: 'Next file', exact: true }).click()
    await expect(secondSection.getByRole('treeitem', { selected: true })).toHaveAttribute(
      'data-item-path',
      'helpers/a.ts',
    )
    await secondSection.getByRole('treeitem', { name: /helpers/ }).click()
    await expect(secondSection.getByRole('treeitem', { name: /^a.ts/ })).toHaveCount(0)
    await expect(firstSection.getByRole('treeitem')).toHaveCount(2)
    await firstSection.getByRole('treeitem', { name: /file.ts/ }).click()
    await expect(firstSection.getByRole('treeitem', { selected: true })).toHaveAttribute(
      'data-item-path',
      'file.ts',
    )
    await expect(secondSection.getByRole('treeitem', { name: /^a.ts/ })).toHaveCount(0)
    await page.getByRole('button', { name: 'File view', exact: true }).click()
    await page.getByRole('menuitemradio', { name: 'Flat list', exact: true }).click()
    await expect(order.getByRole('heading', { name: '1. Public behavior' })).toBeVisible()
    await page.getByRole('button', { name: 'File ordering', exact: true }).click()
    await page.getByRole('menuitemradio', { name: 'Filesystem order', exact: true }).click()
    await order.locator('button[title="file.ts"]').click()
    await order.getByRole('button', { name: 'Next file', exact: true }).click()
    await expect(order.locator('button[title="z.ts"]')).toHaveAttribute('aria-current', 'true')
    await page.getByRole('button', { name: 'File ordering', exact: true }).click()
    await page.getByRole('menuitemradio', { name: 'AI review order', exact: true }).click()
    await expect(order.getByRole('heading', { name: '1. Public behavior' })).toBeVisible()
    expect(await readFile(join(root, 'codex-requests.jsonl'), 'utf8')).toBe(orderRequests)
    await page.getByRole('button', { name: 'AI review', exact: true }).click()
    let panel = page.getByRole('complementary', { name: 'Codex review panel' })
    await expect(
      panel.getByText('AI works better with an initialized workspace', { exact: true }),
    ).toBeVisible()
    await expect(panel.getByRole('button', { name: 'Suggest review order' })).toHaveCount(0)
    await expect(panel.getByText('Suggest a grouped review order', { exact: false })).toHaveCount(0)
    const divider = page.getByRole('separator', { name: 'Resize AI panel' })
    await divider.press('ArrowLeft')
    await expect(divider).toHaveAttribute('aria-valuenow', '400')
    const grip = (await divider.boundingBox())!
    await page.mouse.move(grip.x + grip.width / 2, grip.y + 100)
    await page.mouse.down()
    await page.mouse.move(grip.x - 40, grip.y + 100)
    await page.mouse.up()
    const panelWidth = await divider.getAttribute('aria-valuenow')
    expect(Number(panelWidth)).toBeGreaterThan(400)
    await panel.getByRole('textbox', { name: 'Message Codex' }).fill('Explain')
    await panel.getByRole('textbox', { name: 'Message Codex' }).press('Shift+Enter')
    await panel.getByRole('textbox', { name: 'Message Codex' }).pressSequentially('the change')
    await expect(panel.getByRole('textbox', { name: 'Message Codex' })).toHaveValue(
      'Explain\nthe change',
    )
    await panel.getByRole('textbox', { name: 'Message Codex' }).press('Enter')
    await expect(
      panel.getByText('The review changes the exported value.', { exact: true }),
    ).toBeVisible()
    await panel.getByRole('textbox', { name: 'Message Codex' }).fill('Keep this draft')
    const messageActions = panel.getByTestId('chat-message-actions').last()
    await expect(messageActions).toHaveCSS('opacity', '0')
    await panel.getByTestId('chat-user-message').last().hover()
    await expect(messageActions).toHaveCSS('opacity', '1')
    await expect(messageActions.locator('time')).toHaveText(/^\d{2}:\d{2}$/)
    await messageActions.getByRole('button', { name: 'Copy message', exact: true }).click()
    await expect(
      messageActions.getByRole('button', { name: 'Message copied', exact: true }),
    ).toBeVisible()

    await panel.getByTestId('chat-user-message').last().hover()
    await panel.getByRole('button', { name: 'Edit last message', exact: true }).click()
    await expect(panel.getByRole('textbox', { name: 'Edit message', exact: true })).toHaveValue(
      'Explain\nthe change',
    )
    await panel.getByRole('textbox', { name: 'Edit message', exact: true }).fill('Cancelled edit')
    await panel.getByRole('button', { name: 'Cancel edit', exact: true }).click()
    await panel.getByTestId('chat-user-message').last().hover()
    await panel.getByRole('button', { name: 'Edit last message', exact: true }).click()
    await panel
      .getByRole('textbox', { name: 'Edit message', exact: true })
      .fill('Explain\nthe revised change')
    await panel.getByRole('button', { name: 'Save & resend', exact: true }).click()
    await expect(panel.getByRole('textbox', { name: 'Edit message', exact: true })).toHaveCount(0)
    await expect(panel.getByRole('textbox', { name: 'Message Codex', exact: true })).toHaveValue(
      'Keep this draft',
    )
    await expect(
      panel.getByText('The review changes the exported value.', { exact: true }),
    ).toHaveCount(1)
    await expect(
      panel.locator('.prose-review').filter({ hasText: 'the revised change' }),
    ).toBeVisible()
    await expect(panel.getByRole('button', { name: 'Send', exact: true })).toBeEnabled()
    await panel.getByRole('textbox', { name: 'Message Codex' }).fill('Files')
    await panel.getByRole('textbox', { name: 'Message Codex' }).press('Enter')
    await panel.getByRole('link', { name: 'z.ts', exact: true }).click()
    await expect(page.getByRole('article', { name: 'z.ts', exact: true })).toBeInViewport()
    await panel.getByRole('link', { name: 'helpers/a.ts:1', exact: true }).click()
    await expect(page.getByRole('article', { name: 'helpers/a.ts', exact: true })).toBeInViewport()
    await panel.getByRole('link', { name: 'the export', exact: true }).click()
    await expect(page.getByRole('article', { name: 'file.ts', exact: true })).toBeInViewport()
    await expect(panel.getByRole('link', { name: 'missing.ts', exact: true })).toHaveCount(0)
    const permissions = panel.getByRole('combobox', { name: 'Chat permissions' })
    await expect(permissions).toHaveValue('read-only')
    await expect(permissions.locator('option')).toHaveText([
      'Read only',
      'Ask for approval',
      'Approve for me',
      'Full access',
    ])
    await panel.getByRole('textbox', { name: 'Message Codex' }).fill('Approval')
    await panel.getByRole('button', { name: 'Send', exact: true }).click()
    await expect(panel.getByRole('alertdialog', { name: 'AI approval' })).toHaveCount(0)
    await expect(panel.getByText('Command denied.', { exact: true })).toBeVisible()
    await permissions.selectOption('ask')
    await expect(permissions).toHaveValue('ask')
    await expect(
      panel.getByText('A matching workspace is required for edits', { exact: true }),
    ).toBeVisible()
    await panel.getByRole('textbox', { name: 'Message Codex' }).fill('Approval')
    await expect(panel.getByRole('button', { name: 'Send', exact: true })).toBeDisabled()
    await panel.getByRole('textbox', { name: 'Message Codex' }).press('Enter')
    await expect(panel.getByRole('alertdialog', { name: 'AI approval' })).toHaveCount(0)
    await panel.getByRole('button', { name: 'Initialize workspace', exact: true }).click()
    await expect(panel.getByRole('button', { name: 'Send', exact: true })).toBeEnabled()
    await expect(
      panel.getByText('A matching workspace is required for edits', { exact: true }),
    ).toHaveCount(0)
    await panel.getByRole('textbox', { name: 'Message Codex' }).fill('Approval')
    await panel.getByRole('button', { name: 'Send', exact: true }).click()
    const approval = panel.getByRole('alertdialog', { name: 'AI approval' })
    await expect(approval).toContainText('npm test')
    await approval.getByRole('button', { name: 'Allow', exact: true }).click()
    await expect(panel.getByText('Command allowed.', { exact: true })).toBeVisible()
    await expect(approval).toHaveCount(0)
    await panel.getByRole('textbox', { name: 'Message Codex' }).fill('Hold')
    await panel.getByRole('button', { name: 'Send', exact: true }).click()
    await expect(panel.locator('.prose-review').filter({ hasText: /^Hold$/ })).toBeVisible()
    await expect(permissions).toBeDisabled()
    await panel.getByRole('button', { name: 'New chat', exact: true }).click()
    await expect(permissions).toHaveValue('read-only')
    await expect(permissions).toBeEnabled()
    await panel.getByRole('textbox', { name: 'Message Codex' }).fill('Hold second chat')
    await panel.getByRole('textbox', { name: 'Message Codex' }).press('Enter')
    await expect(panel.getByRole('button', { name: 'Cancel', exact: true })).toBeVisible()
    await panel.getByRole('tab', { name: 'Explain', exact: true }).click()
    await expect(panel.locator('.prose-review').filter({ hasText: /^Hold$/ })).toBeVisible()
    await expect(panel.getByRole('button', { name: 'Cancel', exact: true })).toBeVisible()
    await panel.getByRole('tab', { name: 'Hold second chat', exact: true }).click()
    await panel.getByRole('button', { name: 'Cancel', exact: true }).click()
    await panel.getByRole('textbox', { name: 'Message Codex' }).fill('Explain second chat')
    await panel.getByRole('textbox', { name: 'Message Codex' }).press('Enter')
    await expect(
      panel.getByText('The review changes the exported value.', { exact: true }),
    ).toBeVisible()
    await panel.getByRole('button', { name: 'Close chat: Hold second chat', exact: true }).click()
    await expect(panel.getByRole('button', { name: 'Cancel', exact: true })).toBeVisible()
    const chatBefore = await panel.locator('.prose-review').allTextContents()
    await panel.getByRole('textbox', { name: 'Message Codex' }).fill('Unsent question')
    await panel.getByRole('button', { name: 'Review changes', exact: true }).click()
    const local = page
      .getByRole('article', { name: 'file.ts', exact: true })
      .getByTestId('local-thread')
    await expect(local).toHaveCount(1)
    const notification = page.getByTestId('ai-review-notification')
    await expect(notification).toContainText('AI review complete')
    await expect(notification).toContainText('1 new issue found.')
    await notification.getByRole('button', { name: 'Dismiss review notification' }).click()
    await expect(notification).toHaveCount(0)

    await expect(local.getByText('AI', { exact: true }).last()).toBeVisible()
    await expect(local).toContainText('The changed value breaks the existing contract.')
    await expect(local.getByTestId('comment-priority')).toHaveText('P1')
    await expect(local.getByText('Suggested change', { exact: true })).toBeVisible()
    await expect(panel.getByRole('textbox', { name: 'Message Codex' })).toHaveValue(
      'Unsent question',
    )
    expect(await panel.locator('.prose-review').allTextContents()).toEqual(chatBefore)
    await expect(panel.getByRole('button', { name: 'Cancel', exact: true })).toBeVisible()
    await panel.getByRole('button', { name: 'Cancel', exact: true }).click()
    await panel.getByRole('button', { name: 'New chat', exact: true }).click()
    await expect(panel.getByRole('tab')).toHaveCount(2)
    await expect(panel.getByText('Talk through this review')).toHaveCount(0)
    await expect(
      panel.getByRole('button', { name: 'Summarize the changes', exact: true }),
    ).toHaveCount(0)
    await panel.getByRole('textbox', { name: 'Message Codex' }).fill('Summarize the changes')
    await expect(panel.getByRole('textbox', { name: 'Message Codex' })).toHaveValue(
      'Summarize the changes',
    )
    await panel.getByRole('tab', { name: 'Explain', exact: true }).click()
    await expect(panel.getByRole('textbox', { name: 'Message Codex' })).toHaveValue(
      'Unsent question',
    )
    await panel.getByRole('tab', { name: 'New chat', exact: true }).click()
    await expect(panel.getByRole('textbox', { name: 'Message Codex' })).toHaveValue(
      'Summarize the changes',
    )
    await panel.getByRole('button', { name: 'Close chat: New chat', exact: true }).click()
    await expect(panel.getByRole('tab')).toHaveCount(1)
    await expect(panel.getByRole('tab', { name: 'Explain', exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    await expect(panel.getByRole('button', { name: /^Findings/ })).toHaveCount(0)
    await expect(panel.getByRole('button', { name: 'Chat', exact: true })).toHaveCount(0)
    await expect(panel.getByRole('button', { name: 'Attach MR context' })).toHaveCount(0)
    await expect(
      panel.getByText('Uses installed Codex authentication.', { exact: false }),
    ).toHaveCount(0)
    await expect(
      page.getByRole('button', { name: 'Attach file.ts to Codex', exact: true }),
    ).toHaveCount(0)
    await local.getByRole('button', { name: 'Edit', exact: true }).click()
    await local
      .getByRole('textbox', { name: 'Edit local comment' })
      .fill('Reviewed and edited finding.')
    await local.getByRole('button', { name: 'Save edit', exact: true }).click()
    await expect(local).toContainText('Reviewed and edited finding.')
    await local.getByRole('button', { name: 'Attach thread to AI' }).click()
    const attachment = panel.getByTestId('chat-attachment')
    await expect(attachment).toContainText('file.ts:1')
    await expect(attachment).toContainText('Reviewed and edited finding.')
    await expect(attachment).toContainText('AI · 0 replies')
    await attachment.getByRole('button', { name: 'file.ts:1', exact: true }).click()
    await expect(page.getByRole('article', { name: 'file.ts', exact: true })).toBeInViewport()
    await attachment.getByRole('button', { name: 'Remove attachment' }).click()
    await expect(attachment).toHaveCount(0)
    await local.getByRole('button', { name: 'Attach thread to AI' }).click()
    await panel.getByRole('textbox', { name: 'Message Codex' }).fill('Explain this thread')
    await panel.getByRole('button', { name: 'Send', exact: true }).click()
    await expect(panel.getByRole('button', { name: 'Cancel', exact: true })).toHaveCount(0)
    await expect(attachment).toHaveCount(1)
    await expect(attachment).toContainText('Reviewed and edited finding.')
    await expect(attachment.getByRole('button', { name: 'Remove attachment' })).toHaveCount(0)
    await expect(panel.locator('.prose-review')).not.toContainText([/Thread [a-f0-9]{8}-/])

    const requests = await readFile(join(root, 'codex-requests.jsonl'), 'utf8')
    const starts = requests
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
      .filter((item) => ['thread/start', 'thread/resume'].includes(item.method))
    for (const [model, effort] of [
      ['chat-model', 'low'],
      ['review-model', 'high'],
      ['order-model', 'low'],
    ])
      expect(
        starts.some(
          (item) =>
            item.params.model === model && item.params.config.model_reasoning_effort === effort,
        ),
      ).toBe(true)
    expect(starts.every((item) => item.params.developerInstructions.includes('Serbian'))).toBe(true)
    expect(requests).not.toContain('export const value')
    expect(requests).toContain('workingDirectory')
    expect(requests).toContain('mergeBase')
    await application.close()
    application = await electron.launch({ args: ['.'], env })
    page = await application.firstWindow()
    expect((await page.evaluate(() => window.desktop.getBootstrap())).settings.aiTasks).toEqual({
      chat: { model: 'chat-model', effort: 'low' },
      review: { model: 'review-model', effort: 'high' },
      order: { model: 'order-model', effort: 'low' },
    })
    await page
      .getByRole('region', { name: 'Recent repositories' })
      .getByRole('button', { name: /^repo / })
      .click()
    expect((await page.evaluate(() => window.desktop.getBootstrap())).settings.aiLanguage).toBe(
      'Serbian',
    )
    panel = page.getByRole('complementary', { name: 'Codex review panel' })
    await expect(panel.getByRole('combobox', { name: 'Chat permissions' })).toHaveValue('ask')
    await expect(panel.getByTestId('chat-attachment')).toContainText('Reviewed and edited finding.')
    await expect(panel.getByText(/The comparison changed/)).toBeVisible()
    await expect(page.getByRole('separator', { name: 'Resize AI panel' })).toHaveAttribute(
      'aria-valuenow',
      panelWidth!,
    )
    await expect(page.getByRole('heading', { name: '1. Public behavior' })).toHaveCount(0)
    await expect(page.getByRole('list', { name: 'File list' })).toBeVisible()
    expect((await page.evaluate(() => window.desktop.getBootstrap())).settings.fileView).toBe(
      'flat',
    )
    await page.getByRole('button', { name: 'File view', exact: true }).click()
    await expect(
      page.getByRole('menuitemradio', { name: 'Flat list', exact: true }),
    ).toHaveAttribute('aria-checked', 'true')
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'File ordering', exact: true }).click()
    await expect(
      page.getByRole('menuitemradio', { name: 'Filesystem order', exact: true }),
    ).toHaveAttribute('aria-checked', 'true')
    await page.getByRole('menuitemradio', { name: 'AI review order', exact: true }).click()
    await expect(
      page
        .getByRole('complementary', { name: 'Review files' })
        .getByRole('heading', { name: '1. Public behavior' }),
    ).toBeVisible()
    await expect(page.getByTestId('ai-order-notification')).toHaveCount(0)
    expect(
      (await readFile(join(root, 'codex-requests.jsonl'), 'utf8'))
        .split('\n')
        .filter((line) => line.includes('"method":"turn/start"')),
    ).toEqual(requests.split('\n').filter((line) => line.includes('"method":"turn/start"')))
    expect(await readFile(join(repository, 'file.ts'), 'utf8')).toBe('export const value = 2\n')
  } finally {
    await application.close()
    await rm(root, { recursive: true, force: true })
  }
})
