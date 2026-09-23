import { _electron as electron, expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('GitLab lookup retry, side overlay, comments, approval and revision updates', async ({}, testInfo) => {
  const root = await mkdtemp(join(tmpdir(), 'revui-gitlab-ui-'))
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
      .toString()
      .trim()
  git('init', '-b', 'main')
  await writeFile(join(repository, 'file.ts'), 'export const value = 1\n')
  git('add', '.')
  git('commit', '-m', 'base')
  const base = git('rev-parse', 'HEAD')
  git('checkout', '-b', 'feature')
  await writeFile(join(repository, 'file.ts'), 'export const value = 2\n')
  git('commit', '-am', 'change')
  const head = git('rev-parse', 'HEAD')
  let exists = false
  let delay = 0
  let searches = 0
  let writeGate: Promise<void> | undefined
  let failWrite = false
  let failBody = ''
  const replies = new Map<string, { id: number; body: string }[]>()
  let approved = false
  let currentHead = head
  const comments: string[] = []
  const deletedNotes = new Set<number>()
  const positions: unknown[] = []
  let baseURL = ''
  const server = createServer(async (request, response) => {
    const url = new URL(request.url!, baseURL)
    if (url.pathname === '/avatar.png') {
      response.setHeader('Content-Type', 'image/png')
      response.end(
        Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
          'base64',
        ),
      )
      return
    }
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}
    if (request.method === 'POST') {
      await writeGate
      if (failWrite || (failBody && body.body === failBody)) {
        response.writeHead(403, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ message: 'Posting denied' }))
        return
      }
    }
    const mr = {
      iid: 3,
      project_id: 1,
      source_project_id: 1,
      title: 'Fixture MR',
      description: 'Review description',
      source_branch: 'feature',
      target_branch: 'main',
      sha: currentHead,
      diff_refs: { base_sha: base, head_sha: currentHead, start_sha: base },
      author: { id: 1, name: 'Reviewer', avatar_url: `${baseURL}/avatar.png` },
      reviewers: [{ id: 1, name: 'Reviewer', avatar_url: `${baseURL}/avatar.png` }],
      labels: ['ready'],
      state: 'opened',
      draft: false,
      head_pipeline: { status: 'success', web_url: `${baseURL}/group/repo/-/pipelines/42` },
      web_url: `${baseURL}/group/repo/-/merge_requests/3`,
    }
    let data: unknown = mr
    if (url.pathname.endsWith('/user')) data = { id: 1 }
    else if (url.pathname.endsWith('/environments'))
      data = [
        { id: 1, name: 'review/feature', external_url: `${baseURL}/preview`, state: 'available' },
      ]
    else if (url.pathname.endsWith('/environments/1'))
      data = {
        id: 1,
        name: 'review/feature',
        external_url: `${baseURL}/preview`,
        state: 'available',
        last_deployment: { ref: 'feature', sha: head, status: 'success' },
      }
    else if (url.pathname.endsWith('/version')) data = { version: '18.0.0-fixture' }
    else if (decodeURIComponent(url.pathname).endsWith('/projects/group/repo')) data = { id: 1 }
    else if (url.pathname.endsWith('/merge_requests')) {
      searches++
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay))
      data = exists ? [mr] : []
    } else if (url.pathname.endsWith('/versions'))
      data = [
        { id: 1, head_commit_sha: currentHead, base_commit_sha: base, start_commit_sha: base },
      ]
    else if (url.pathname.endsWith('/versions/1'))
      data = {
        diffs: [
          {
            old_path: 'file.ts',
            new_path: 'file.ts',
            diff: '@@ -1 +1 @@\n-export const value = 1\n+export const value = 2\n',
          },
        ],
      }
    else if (url.pathname.endsWith('/approve')) {
      expect(body.sha).toBe(currentHead)
      approved = true
      data = {}
    } else if (url.pathname.endsWith('/unapprove')) {
      approved = false
      data = {}
    } else if (url.pathname.endsWith('/approvals'))
      data = {
        approved,
        approved_by: approved
          ? [{ user: { id: 1, name: 'Reviewer', avatar_url: `${baseURL}/avatar.png` } }]
          : [],
      }
    else if (request.method === 'DELETE' && /\/notes\/\d+$/.test(url.pathname)) {
      deletedNotes.add(Number(url.pathname.split('/').at(-1)))
      response.writeHead(204)
      response.end()
      return
    } else if (request.method === 'POST' && /\/discussions\/[^/]+\/notes$/.test(url.pathname)) {
      const discussion = url.pathname.split('/').at(-2)!
      const notes = replies.get(discussion) ?? []
      const note = { id: 1000 + notes.length, body: body.body }
      notes.push(note)
      replies.set(discussion, notes)
      data = note
    } else if (url.pathname.endsWith('/discussions')) {
      if (request.method === 'POST') {
        comments.push(body.body)
        positions.push(body.position)
        data = { id: String(comments.length - 1) }
      } else
        data = comments
          .map((body, index) => ({
            id: String(index),
            individual_note: false,
            notes: [
              {
                id: index + 1,
                author: { id: 1, name: 'Reviewer', avatar_url: `${baseURL}/avatar.png` },
                body,
                resolvable: true,
                resolved: false,
                system: false,
                updated_at: new Date().toISOString(),
                position: positions[index],
              },
              ...(replies.get(String(index)) ?? []).map((note) => ({
                ...note,
                author: { id: 1, name: 'Reviewer' },
                resolvable: true,
                resolved: false,
                system: false,
                updated_at: new Date().toISOString(),
              })),
            ],
          }))
          .filter((discussion) => !deletedNotes.has(discussion.notes[0].id))
    }
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify(data))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  baseURL = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  git('remote', 'add', 'origin', `${baseURL}/group/repo.git`)
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
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await page.getByRole('tab', { name: 'GitLab', exact: true }).click()
    await page.getByRole('textbox', { name: 'GitLab instance URL' }).fill(baseURL)
    await page.getByLabel('GitLab token', { exact: true }).fill('fixture-token')
    await page.getByRole('button', { name: 'Connect', exact: true }).click()
    await expect(page.getByRole('status')).toContainText('Connected')
    expect(await readFile(join(root, 'data', 'gitlab.json'), 'utf8')).not.toContain('fixture-token')
    await page.getByRole('button', { name: 'Close settings' }).click()
    await application.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
    }, repository)
    await page.getByRole('button', { name: 'Open repository', exact: true }).click()
    await page.getByRole('button', { name: 'Open folder…', exact: true }).click()
    await page.getByRole('combobox', { name: 'Old', exact: true }).fill('main')
    await page.getByRole('combobox', { name: 'Old', exact: true }).press('Escape')
    await page.getByRole('combobox', { name: 'New', exact: true }).fill('feature')
    await page.getByRole('combobox', { name: 'New', exact: true }).press('Escape')
    const button = page.getByRole('button', { name: 'Merge request', exact: true })
    await expect.poll(() => searches).toBe(1)
    await expect(button).not.toHaveClass(/text-git-deleted/)
    delay = 400
    await button.click()
    await expect(button).toHaveAttribute('aria-busy', 'true')
    await expect(button.locator('.animate-spin')).toBeVisible()
    await expect(button).toHaveClass(/text-git-deleted/)
    await expect(button).not.toHaveClass(/text-git-deleted/)
    expect(searches).toBe(2)
    exists = true
    delay = 0
    await button.click()
    const overlay = page.getByRole('dialog', { name: '!3 Fixture MR' })
    await expect(overlay).toBeVisible()
    await expect(overlay).toContainText('Review description')
    await application.evaluate(({ shell }) => {
      shell.openExternal = async (url) => {
        ;(globalThis as { openedApp?: string }).openedApp = url
      }
    })
    await overlay.getByRole('button', { name: 'View app', exact: true }).click()
    expect(await application.evaluate(() => (globalThis as { openedApp?: string }).openedApp)).toBe(
      `${baseURL}/preview`,
    )
    await overlay.getByRole('button', { name: 'Copy app link', exact: true }).click()
    await expect
      .poll(() => application.evaluate(({ clipboard }) => clipboard.readText()))
      .toBe(`${baseURL}/preview`)
    await overlay.getByRole('button', { name: 'View pipeline', exact: true }).click()
    expect(await application.evaluate(() => (globalThis as { openedApp?: string }).openedApp)).toBe(
      `${baseURL}/group/repo/-/pipelines/42`,
    )
    await overlay.getByRole('button', { name: 'Copy pipeline link', exact: true }).click()
    await expect
      .poll(() => application.evaluate(({ clipboard }) => clipboard.readText()))
      .toBe(`${baseURL}/group/repo/-/pipelines/42`)
    await expect(overlay.locator('footer')).toHaveCount(0)
    await expect(
      overlay.locator('header').getByRole('button', { name: 'Approve', exact: true }),
    ).toBeVisible()
    await expect(overlay.locator('dt').filter({ hasText: 'Approved by' })).toBeVisible()
    await overlay.getByRole('button', { name: 'Copy MR link', exact: true }).click()
    await expect
      .poll(() => application.evaluate(({ clipboard }) => clipboard.readText()))
      .toBe(`${baseURL}/group/repo/-/merge_requests/3`)
    const bounds = await overlay.boundingBox(),
      viewport =
        page.viewportSize() ??
        (await page.evaluate(() => ({ width: innerWidth, height: innerHeight })))
    expect(bounds!.x).toBeGreaterThan(viewport.width / 3)
    await overlay
      .getByRole('textbox', { name: 'GitLab comment', exact: true })
      .fill('General comment')
    await expect(overlay.getByRole('button', { name: 'Save draft', exact: true })).toHaveCount(0)
    let releaseWrite!: () => void
    writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve
    })
    failWrite = true
    await overlay.getByRole('button', { name: 'Post now', exact: true }).click()
    await expect(overlay.locator('[data-discussion-id^="pending-"]')).toContainText(
      'General comment',
    )
    expect(comments).toEqual([])
    releaseWrite()
    await expect(overlay.locator('[data-discussion-id^="pending-"]')).toHaveCount(0)
    await expect(overlay.getByRole('textbox', { name: 'GitLab comment', exact: true })).toHaveValue(
      'General comment',
    )
    await expect(overlay.getByRole('alert').first()).toContainText('permission denied')
    failWrite = false
    writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve
    })
    await overlay.getByRole('button', { name: 'Post now', exact: true }).click()
    await expect(overlay.locator('[data-discussion-id^="pending-"]')).toContainText(
      'General comment',
    )
    expect(comments).toEqual([])
    releaseWrite()
    writeGate = undefined
    await expect.poll(() => comments).toEqual(['General comment'])
    await expect(overlay.locator('[data-discussion-id^="pending-"]')).toHaveCount(0)
    writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve
    })
    await overlay.getByRole('button', { name: 'Approve', exact: true }).click()
    await expect(overlay.getByRole('button', { name: 'Unapprove', exact: true })).toBeVisible()
    expect(approved).toBe(false)
    releaseWrite()
    writeGate = undefined
    await expect(overlay.getByRole('button', { name: 'Unapprove', exact: true })).toBeEnabled()
    await page.getByRole('button', { name: 'Close merge request' }).click()
    const file = page.getByRole('article', { name: 'file.ts', exact: true })
    await file.locator('[data-additions] [data-column-number="1"]').hover()
    await file.locator('[data-utility-button]').click()
    const composer = file.getByTestId('thread-composer')
    await expect(composer.getByRole('button', { name: 'GitLab', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    await expect(composer.getByRole('group', { name: 'Comment range' })).toContainText('From line')
    await composer
      .getByRole('textbox', { name: 'GitLab comment', exact: true })
      .fill('Inline suggestion')
    await composer.getByRole('button', { name: 'Insert suggestion' }).click()
    await expect(
      composer.getByRole('textbox', { name: 'GitLab comment', exact: true }),
    ).toHaveValue('Inline suggestion\n\n```suggestion:-0+0\nexport const value = 2\n```')
    await composer.getByRole('button', { name: 'Post now', exact: true }).click()
    await expect(composer).toBeHidden()
    await button.click()
    await expect.poll(() => comments.length).toBe(2)
    expect(positions[1]).toEqual({
      position_type: 'text',
      base_sha: base,
      head_sha: head,
      start_sha: base,
      old_path: 'file.ts',
      new_path: 'file.ts',
      new_line: 1,
    })
    await page.getByRole('button', { name: 'Close merge request' }).click()
    await expect(file.getByRole('region', { name: 'GitLab discussion' })).toContainText(
      'Inline suggestion',
    )
    const inlineDiscussion = file.getByRole('region', { name: 'GitLab discussion' })
    await expect(inlineDiscussion).not.toContainText('file.ts:')
    const editBounds = await inlineDiscussion
      .getByRole('button', { name: 'Edit', exact: true })
      .boundingBox()
    const resolveBounds = await inlineDiscussion
      .getByRole('button', { name: 'Resolve', exact: true })
      .boundingBox()
    expect(editBounds!.x).toBeLessThan(resolveBounds!.x)
    expect(editBounds!.y).toBe(resolveBounds!.y)
    await button.click()
    await overlay
      .getByRole('region', { name: 'GitLab discussion' })
      .filter({ hasText: 'Inline suggestion' })
      .getByRole('button', { name: 'View in diff' })
      .click()
    await expect(overlay).toBeHidden()
    await expect(file.getByRole('region', { name: 'GitLab discussion' })).toContainText(
      'Inline suggestion',
    )
    await file.locator('[data-additions] [data-column-number="1"]').hover()
    await file.locator('[data-utility-button]').click()
    const localComposer = file.getByTestId('thread-composer')
    await localComposer.getByRole('button', { name: 'Local', exact: true }).click()
    await localComposer
      .getByRole('textbox', { name: 'Comment on file.ts' })
      .fill('Upload this local comment')
    await localComposer.getByRole('button', { name: 'Post now', exact: true }).click()
    const localThread = file.getByTestId('local-thread')
    await localThread.getByRole('button', { name: 'Upload to GitLab', exact: true }).click()
    const uploaded = file
      .getByRole('region', { name: 'GitLab discussion' })
      .filter({ hasText: 'Upload this local comment' })
    await expect(uploaded).toBeVisible()
    expect(comments.at(-1)).toBe('Upload this local comment')
    expect(positions.at(-1)).toMatchObject({ new_path: 'file.ts', new_line: 1 })
    await expect(localThread).toHaveCount(0)
    await uploaded.getByRole('button', { name: 'Edit', exact: true }).click()
    await uploaded.getByRole('button', { name: 'Insert suggestion' }).click()
    await expect(uploaded.getByRole('textbox', { name: 'Edit GitLab comment' })).toHaveValue(
      'Upload this local comment\n\n```suggestion:-0+0\nexport const value = 2\n```',
    )
    await uploaded.getByRole('button', { name: 'Cancel', exact: true }).click()
    await uploaded.getByRole('button', { name: 'Delete comment' }).click()
    const confirmation = page.getByRole('dialog', { name: 'Delete comment?' })
    await expect(confirmation).toContainText('Upload this local comment')
    await expect(confirmation.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused()
    expect(deletedNotes.size).toBe(0)
    await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(uploaded).toBeVisible()
    await uploaded.getByRole('button', { name: 'Delete comment' }).click()
    await confirmation.getByRole('button', { name: 'Delete comment', exact: true }).click()
    await expect(uploaded).toHaveCount(0)
    await expect(localThread).toHaveCount(0)
    await file.locator('[data-additions] [data-column-number="1"]').hover()
    await file.locator('[data-utility-button]').click()
    await localComposer.getByRole('button', { name: 'Local', exact: true }).click()
    await localComposer.getByRole('textbox', { name: 'Comment on file.ts' }).fill('Batch root')
    await localComposer.getByRole('button', { name: 'Post now', exact: true }).click()
    await localThread.locator('summary').click()
    await localThread.getByRole('textbox', { name: 'Reply', exact: true }).fill('Batch reply')
    await localThread.getByRole('button', { name: 'Post now', exact: true }).click()
    await button.click()
    const overlayLocal = overlay.getByTestId('local-thread')
    await expect(overlayLocal.getByTestId('local-tag')).toHaveText('Local')
    await expect(
      overlayLocal.getByRole('button', { name: 'Upload to GitLab', exact: true }),
    ).toHaveCount(2)
    await expect(
      overlayLocal.getByRole('button', { name: 'Upload to GitLab', exact: true }).first(),
    ).toBeEnabled()
    await expect(overlayLocal).toContainText('file.ts:1')
    await overlayLocal.getByRole('button', { name: 'View in diff' }).click()
    await expect(overlay).toBeHidden()
    await expect(localThread).toBeVisible()
    await button.click()
    failBody = 'Batch reply'
    await overlay.getByRole('button', { name: 'Publish all local comments', exact: true }).click()
    await expect(overlay.getByRole('alert').first()).toContainText('permission denied')
    await expect(overlayLocal).toContainText('Batch reply')
    await expect(overlayLocal).not.toContainText('Batch root')
    expect(comments.filter((body) => body === 'Batch root')).toHaveLength(1)
    failBody = ''
    await overlayLocal.getByRole('button', { name: 'Upload to GitLab', exact: true }).click()
    await expect(overlayLocal).toHaveCount(0)
    await expect(
      overlay.getByRole('region', { name: 'GitLab discussion' }).filter({ hasText: 'Batch root' }),
    ).toContainText('Batch reply')
    expect(comments.filter((body) => body === 'Batch root')).toHaveLength(1)
    await page.getByRole('button', { name: 'Close merge request' }).click()
    comments.push('File review')
    positions.push({
      position_type: 'file',
      base_sha: base,
      head_sha: head,
      start_sha: base,
      old_path: 'file.ts',
      new_path: 'file.ts',
    })
    await button.click()
    await overlay.getByRole('button', { name: 'Refresh', exact: true }).click()
    await overlay
      .getByRole('region', { name: 'GitLab discussion' })
      .filter({ hasText: 'File review' })
      .getByRole('button', { name: 'View in diff' })
      .click()
    await expect(overlay).toBeHidden()
    await expect(
      file.getByRole('region', { name: 'GitLab discussion' }).filter({ hasText: 'File review' }),
    ).toBeVisible()
    await page.getByRole('button', { name: 'Filter files', exact: true }).click()
    await page.getByRole('menuitemradio', { name: 'Unresolved threads', exact: true }).click()
    await expect(file).toBeVisible()
    await button.click()
    const fileDiscussion = overlay
      .getByRole('region', { name: 'GitLab discussion' })
      .filter({ hasText: 'File review' })
    await fileDiscussion.getByRole('button', { name: 'Edit', exact: true }).click()
    await fileDiscussion.getByRole('button', { name: 'Insert suggestion' }).click()
    await expect(fileDiscussion.getByRole('textbox', { name: 'Edit GitLab comment' })).toHaveValue(
      'File review\n\n```suggestion\nexport const value = 2\n```',
    )
    await fileDiscussion.getByRole('button', { name: 'Cancel', exact: true }).click()
    git('commit', '--allow-empty', '-m', 'Equivalent MR revision')
    currentHead = git('rev-parse', 'HEAD')
    await overlay.getByRole('button', { name: 'Refresh', exact: true }).click()
    await expect(overlay.getByRole('button', { name: 'Refresh', exact: true })).toBeEnabled()
    await expect(overlay).not.toContainText('Your comparison differs')
    await expect(overlay).not.toContainText('A new revision is available')
    await overlay.getByRole('button', { name: 'Unapprove', exact: true }).click()
    writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve
    })
    await overlay.getByRole('button', { name: 'Approve', exact: true }).click()
    await expect(overlay.getByRole('button', { name: 'Unapprove', exact: true })).toBeVisible()
    expect(approved).toBe(false)
    releaseWrite()
    writeGate = undefined
    await expect(overlay.getByRole('button', { name: 'Unapprove', exact: true })).toBeEnabled()
    currentHead = 'e'.repeat(40)
    await overlay.getByRole('button', { name: 'Refresh', exact: true }).click()
    await expect(overlay).toContainText('new revision')
    await expect(page.getByText('Passed', { exact: true })).toBeVisible()
    await expect
      .poll(() =>
        page
          .locator('img[src^="data:image/png"]')
          .evaluateAll(
            (images) =>
              images.length > 0 &&
              images.every((image) => (image as HTMLImageElement).naturalWidth > 0),
          ),
      )
      .toBe(true)
    await page.screenshot({ path: testInfo.outputPath('gitlab-overlay.png') })
    await page.getByRole('button', { name: 'Close merge request' }).click()
    const before = searches
    await button.click()
    await expect(overlay).toBeVisible()
    expect(searches).toBe(before)
    await page.getByRole('button', { name: 'Close merge request' }).click()
    // In-flight results from a previous comparison must not reopen its MR overlay.
    delay = 400
    await page.getByRole('combobox', { name: 'New', exact: true }).fill('main')
    await page.getByRole('combobox', { name: 'New', exact: true }).press('Escape')
    await expect.poll(() => searches).toBe(before + 1)
    await page.getByRole('combobox', { name: 'New', exact: true }).fill('Uncommitted')
    await page.getByRole('combobox', { name: 'New', exact: true }).press('Escape')
    await expect(button).toHaveAttribute('aria-busy', 'false')
    await button.click()
    await expect(button).toHaveClass(/text-git-deleted/)
    await expect(page.getByRole('dialog')).toBeHidden()
    // Opening a branch comparison finds the MR automatically without opening the overlay.
    currentHead = head
    delay = 0
    await page.getByRole('combobox', { name: 'New', exact: true }).fill('feature')
    await page.getByRole('combobox', { name: 'New', exact: true }).press('Escape')
    await expect.poll(() => searches).toBe(before + 2)
    await expect(button).toHaveAttribute('aria-busy', 'false')
    await expect(page.getByRole('dialog')).toBeHidden()
    await button.click()
    await expect(overlay).toBeVisible()
    expect(searches).toBe(before + 2)
    comments.push(
      '[Compare with previous version](?diff_id=123) [Website](https://example.com/docs) [Unsafe](javascript:alert%281%29)',
    )
    await overlay.getByRole('button', { name: 'Refresh', exact: true }).click()
    await overlay.getByRole('link', { name: 'Compare with previous version' }).click()
    expect(await application.evaluate(() => (globalThis as { openedApp?: string }).openedApp)).toBe(
      `${baseURL}/group/repo/-/merge_requests/3?diff_id=123`,
    )
    await overlay.getByRole('link', { name: 'Website', exact: true }).click()
    expect(await application.evaluate(() => (globalThis as { openedApp?: string }).openedApp)).toBe(
      'https://example.com/docs',
    )
    await expect(overlay.getByRole('link', { name: 'Unsafe' })).toHaveCount(0)
    await expect(overlay).toBeVisible()
    expect(
      await page.evaluate(() =>
        window.desktop.openWebLink('file:///tmp/test').then(
          () => false,
          () => true,
        ),
      ),
    ).toBe(true)
    expect(errors).toEqual([])
  } finally {
    await application.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(root, { recursive: true, force: true })
  }
})
