import { _electron as electron, expect, test } from '@playwright/test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Workspace } from '../src/shared/workspace'

test('workspace preparation, setup output, IDE arguments and restoration', async ({}, testInfo) => {
  const repository = await mkdtemp(join(tmpdir(), 'revui-tools-repo-'))
  const data = await mkdtemp(join(tmpdir(), 'revui-tools-data-'))
  const git = (...args: string[]) => promisify(execFile)('git', ['-C', repository, ...args])
  await git('init', '-b', 'main')
  await git('config', 'user.name', 'Test')
  await git('config', 'user.email', 'test@example.com')
  await writeFile(join(repository, 'file.txt'), 'before\n')
  await writeFile(join(repository, 'z-other.txt'), 'before\n')
  await git('add', '.')
  await git('commit', '-m', 'first')
  await git('branch', 'review-branch')
  await git('tag', '-a', 'review-tag', '-m', 'review tag')
  await writeFile(join(repository, 'file.txt'), 'after\n')
  await writeFile(join(repository, 'z-other.txt'), 'after\n')
  await git('commit', '-am', 'second')
  await git('tag', '-a', 'release', '-m', 'release')
  const env: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
    REVUI_USER_DATA: data,
    REVUI_TEST_HIDDEN: '1',
  }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  const application = await electron.launch({ args: ['.'], env })
  let closed = false
  try {
    const page = await application.firstWindow()
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await application.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
      dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false })
    }, repository)
    await page.getByRole('button', { name: 'Open repository', exact: true }).click()
    await page.getByRole('button', { name: 'Add repository', exact: true }).click()
    await page.getByRole('combobox', { name: 'New', exact: true }).fill('HEAD~1')
    await page.getByRole('combobox', { name: 'New', exact: true }).press('Escape')
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await expect(page.getByRole('tab', { name: 'Appearance', exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    const wrap = page.getByRole('switch', { name: 'Wrap long lines' })
    await wrap.click()
    await expect(wrap).toBeChecked()
    await expect(wrap).toHaveAttribute('data-checked', '')
    await page.screenshot({
      path: testInfo.outputPath('settings-appearance.png'),
      animations: 'disabled',
    })
    await page.getByRole('tab', { name: 'Appearance', exact: true }).focus()
    await page.keyboard.press('ArrowDown')
    await expect(page.getByRole('tab', { name: 'Workspace', exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    await page.getByLabel('Post-checkout script').fill('echo REVUI_SETUP_OK')
    await expect(page.getByText('Custom IDE launcher', { exact: true })).toHaveCount(0)
    const ideOutput = join(data, 'ide-args.json')
    // Capture built-in IDE launches without opening applications on the test machine.
    await application.evaluate(
      (_, { output, node }) => {
        const childProcess = process.getBuiltinModule('node:child_process')
        const spawn = childProcess.spawn
        childProcess.spawn = ((
          command: string,
          args: string[],
          options: import('node:child_process').SpawnOptions,
        ) => {
          if (options?.detached && options.stdio === 'ignore') {
            return spawn(
              node,
              [
                '-e',
                "require('node:fs').writeFileSync(process.argv[1], process.argv[2])",
                output,
                JSON.stringify(args),
              ],
              options,
            )
          }
          return spawn(command, args, options)
        }) as typeof spawn
        process.getBuiltinModule('node:module').syncBuiltinESMExports()
      },
      { output: ideOutput, node: process.execPath },
    )
    await page.getByRole('button', { name: 'Save commands' }).click()
    await expect(page.getByRole('status')).toContainText('Changes saved')
    await page.getByRole('radio', { name: 'This repository', exact: true }).click()
    await expect(page.getByLabel('Post-checkout script')).toBeDisabled()
    const override = page.getByRole('switch', { name: 'Repository-specific commands' })
    await override.click()
    await expect(override).toBeChecked()
    await page.getByLabel('Post-checkout script').fill('echo REPOSITORY_ONLY')
    await page.getByRole('button', { name: 'Save commands' }).click()
    await expect(page.getByRole('status')).toContainText('Changes saved')
    await page.getByRole('heading', { name: 'Workspace', exact: true }).scrollIntoViewIfNeeded()
    await page.screenshot({
      path: testInfo.outputPath('settings-workspace.png'),
      animations: 'disabled',
    })
    const configured = await page.evaluate(() => window.desktop.getBootstrap())
    expect(configured.settings.workspaceCommands.script).toBe('echo REVUI_SETUP_OK')
    expect(Object.values(configured.settings.repositoryCommands)[0].script).toBe(
      'echo REPOSITORY_ONLY',
    )
    await override.click()
    await page.getByRole('button', { name: 'Save commands' }).click()
    await expect(page.getByRole('status')).toContainText('Changes saved')
    await expect(page.getByLabel('Post-checkout script')).toHaveValue('echo REVUI_SETUP_OK')
    await page.getByRole('dialog').press('Escape')
    await expect(
      page.getByRole('button', { name: 'Open file.txt in VS Code', exact: true }),
    ).toBeEnabled()
    await page.getByRole('button', { name: 'Choose IDE for file.txt', exact: true }).click()
    await expect(page.getByRole('menuitem').locator('span')).toHaveText([
      'Cursor',
      'VS Code',
      'IntelliJ IDEA',
      'WebStorm',
    ])
    await expect(page.getByRole('menuitem', { name: 'Finder' })).toHaveCount(0)
    await page.screenshot({ path: testInfo.outputPath('file-ide-menu.png') })
    await page.getByRole('menuitem', { name: 'Cursor', exact: true }).click()
    await expect
      .poll(async () => JSON.parse(await readFile(ideOutput, 'utf8').catch(() => '[]')))
      .toEqual(['--goto', `${await realpath(join(repository, 'file.txt'))}:1`])
    await expect(
      page.getByRole('button', { name: 'Open file.txt in Cursor', exact: true }),
    ).toHaveText('')
    await page.getByRole('button', { name: 'Open z-other.txt in Cursor', exact: true }).click()
    await expect
      .poll(async () => JSON.parse(await readFile(ideOutput, 'utf8').catch(() => '[]')))
      .toEqual(['--goto', `${await realpath(join(repository, 'z-other.txt'))}:1`])
    const toolbar = page.getByRole('banner', { name: 'Repository toolbar', includeHidden: true })
    const projectIDE = toolbar.getByRole('button', {
      name: 'Open project in Cursor',
      exact: true,
      includeHidden: true,
    })
    await expect(projectIDE).toBeDisabled()
    await toolbar.getByRole('group', { name: 'Open project in IDE' }).hover()
    await expect(page.getByRole('tooltip')).toContainText('Initialize the workspace')
    await toolbar.getByRole('button', { name: 'Initialize workspace', exact: true }).click()
    await expect(
      page.getByRole('heading', { name: 'Prepare workspace', exact: true }),
    ).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('workspace-checkout.png') })
    await page.evaluate(() =>
      window.desktop.updatePreferences({
        workspaceCommands: { script: 'echo SETUP_FAILED && exit 1' },
      }),
    )
    await page.getByRole('button', { name: 'Prepare workspace', exact: true }).click()
    await expect(page.getByRole('alert')).toContainText('exited with 1')
    await expect(page.getByRole('heading', { name: 'Workspace setup failed' })).toBeVisible()
    await expect(page.getByLabel('Setup output')).toContainText('SETUP_FAILED')
    await expect(projectIDE).toBeDisabled()
    await page.evaluate(() =>
      window.desktop.updatePreferences({ workspaceCommands: { script: 'echo REVUI_SETUP_OK' } }),
    )
    await page.getByRole('button', { name: 'Retry setup', exact: true }).click()
    await expect(projectIDE).toBeEnabled()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    const repo = await realpath(repository)
    const records = await page.evaluate((path) => window.desktop.listWorkspaces(path), repo)
    expect(records).toHaveLength(1)
    expect(await readFile(join(records[0].path, 'file.txt'), 'utf8')).toBe('before\n')
    await expect(projectIDE).toBeEnabled()
    await projectIDE.click()
    await expect
      .poll(async () => JSON.parse(await readFile(ideOutput, 'utf8').catch(() => '[]')))
      .toEqual([await realpath(records[0].path)])
    await page.getByRole('button', { name: 'Open file.txt in Cursor', exact: true }).click()
    await expect
      .poll(async () => JSON.parse(await readFile(ideOutput, 'utf8').catch(() => '[]')))
      .toEqual(['--goto', `${await realpath(join(records[0].path, 'file.txt'))}:1`])
    // A new diff snapshot at the same target restores the initialized worktree automatically.
    await page.getByRole('button', { name: 'Refresh comparison', exact: true }).click()
    await expect(projectIDE).toBeEnabled()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await projectIDE.click()
    await expect
      .poll(async () => JSON.parse(await readFile(ideOutput, 'utf8').catch(() => '[]')))
      .toEqual([await realpath(records[0].path)])
    await toolbar.getByRole('button', { name: 'Initialize workspace', exact: true }).click()
    await expect(projectIDE).toBeEnabled()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    expect(await page.evaluate((path) => window.desktop.listWorkspaces(path), repo)).toHaveLength(1)
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await page.getByRole('tab', { name: 'Worktrees', exact: true }).click()
    await expect(
      page.getByRole('heading', { name: records[0].target.slice(0, 12), exact: true }),
    ).toBeVisible()
    await expect(page.getByText('review-branch', { exact: true })).toBeVisible()
    await expect(page.getByText('review-tag', { exact: true })).toBeVisible()
    await expect(page.getByText('Review worktree', { exact: true })).toHaveCount(0)
    await expect(page.getByText('Ready', { exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Use workspace' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Remove worktree', exact: true })).toHaveText('')
    await page.screenshot({ path: testInfo.outputPath('settings-worktrees.png') })
    await writeFile(join(repository, '.git', 'info', 'exclude'), 'setup-output\n')
    await writeFile(join(records[0].path, 'setup-output'), 'generated by setup')
    await application.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => {
        await new Promise((resolve) => setTimeout(resolve, 1000))
        return { response: 1, checkboxChecked: false }
      }
    })
    await page.getByRole('button', { name: 'Remove worktree', exact: true }).click()
    const deleting = toolbar.getByRole('button', {
      name: 'Deleting workspace',
      exact: true,
      includeHidden: true,
    })
    await expect(deleting).toBeDisabled()
    await expect(deleting).toHaveAttribute('aria-busy', 'true')
    await expect(deleting.locator('svg')).toHaveClass(/animate-spin/)
    await expect(projectIDE).toBeDisabled()
    await expect(page.getByRole('button', { name: 'Remove worktree', exact: true })).toBeEnabled()
    await expect(deleting).toHaveCount(0)
    await expect(projectIDE).toBeEnabled()
    expect(await readFile(join(records[0].path, 'setup-output'), 'utf8')).toBe('generated by setup')
    await application.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false })
    })
    await page.getByRole('button', { name: 'Remove worktree', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Remove worktree' })).toHaveCount(0)
    await page.getByRole('dialog').press('Escape')
    await expect(projectIDE).toBeDisabled()
    await toolbar.getByRole('button', { name: 'Initialize workspace', exact: true }).click()
    await page.getByRole('radio', { name: 'Current checkout', exact: true }).check()
    await application.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => {
        throw new Error('Clean checkout must not ask for confirmation')
      }
    })
    await page.getByRole('button', { name: 'Prepare workspace', exact: true }).click()
    await expect(projectIDE).toBeEnabled()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await application.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false })
    })
    // Comparing again leaves the prepared review and invokes the native restore prompt.
    await page.getByRole('button', { name: 'Refresh comparison', exact: true }).click()
    await expect
      .poll(async () =>
        (await git('symbolic-ref', '--short', 'HEAD').catch(() => ({ stdout: '' }))).stdout.trim(),
      )
      .toBe('main')
    // An annotated tag at HEAD skips the checkout picker entirely.
    await page.evaluate(
      (node) =>
        window.desktop.updatePreferences({
          workspaceCommands: { script: `"${node}" -e "setTimeout(()=>{},1000)"` },
        }),
      process.execPath,
    )
    await page.getByRole('combobox', { name: 'New', exact: true }).fill('release')
    await page.getByRole('combobox', { name: 'New', exact: true }).press('Escape')
    await toolbar.getByRole('button', { name: 'Initialize workspace', exact: true }).click()
    await expect(toolbar.getByRole('button', { name: 'Cancel setup', exact: true })).toBeVisible()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(projectIDE).toBeDisabled()
    await expect(projectIDE).toBeEnabled()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.getByRole('radio', { name: 'New worktree' })).toHaveCount(0)
    await projectIDE.click()
    await expect
      .poll(async () => JSON.parse(await readFile(ideOutput, 'utf8').catch(() => '[]')))
      .toEqual([repo])
    expect(await page.evaluate((path) => window.desktop.listWorkspaces(path), repo)).toHaveLength(1)
    // Failed setup disables project opening and can be retried without another checkout.
    await page.evaluate(() =>
      window.desktop.updatePreferences({
        workspaceCommands: { script: 'echo SETUP_FAILED && exit 1' },
      }),
    )
    await toolbar.getByRole('button', { name: 'Initialize workspace', exact: true }).click()
    await expect(page.getByRole('alert')).toContainText('exited with 1')
    await expect(page.getByRole('heading', { name: 'Workspace setup failed' })).toBeVisible()
    await expect(page.getByLabel('Setup output')).toContainText('SETUP_FAILED')
    await expect(projectIDE).toBeDisabled()
    await page.evaluate(() =>
      window.desktop.updatePreferences({ workspaceCommands: { script: 'echo RETRY_OK' } }),
    )
    await page.getByRole('button', { name: 'Retry setup', exact: true }).click()
    await expect(projectIDE).toBeEnabled()
    await application.close()
    closed = true
    expect((await git('symbolic-ref', '--short', 'HEAD')).stdout.trim()).toBe('main')
    expect(errors).toEqual([])
  } finally {
    if (!closed) await application.close()
    await rm(repository, { recursive: true, force: true })
    await rm(data, { recursive: true, force: true })
  }
})

test('manages all repository worktrees without an open repository and exposes path actions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'revui-all-worktrees-'))
  const data = join(root, 'data')
  await mkdir(data)
  const records: Workspace[] = []
  for (const name of ['alpha', 'beta']) {
    const repository = join(root, name)
    const path = join(root, `${name}-worktree`)
    await mkdir(repository)
    const git = async (...args: string[]) =>
      (await promisify(execFile)('git', ['-C', repository, ...args])).stdout.trim()
    await git('init', '-b', 'main')
    await git('config', 'user.name', 'Test')
    await git('config', 'user.email', 'test@example.com')
    await writeFile(join(repository, 'file.txt'), name)
    await git('add', '.')
    await git('commit', '-m', name)
    const target = await git('rev-parse', 'HEAD')
    await git('worktree', 'add', '--detach', path, target)
    records.push({
      id: randomUUID(),
      repository,
      path,
      snapshot: randomUUID(),
      kind: 'worktree',
      original: target,
      branch: 'refs/heads/main',
      target,
      stash: null,
      initialized: true,
      phase: 'ready',
      error: null,
    })
  }
  await writeFile(join(data, 'workspaces.json'), JSON.stringify({ version: 1, records }))
  const env: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
    REVUI_USER_DATA: data,
    REVUI_TEST_HIDDEN: '1',
  }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  const application = await electron.launch({ args: ['.'], env })
  try {
    const page = await application.firstWindow()
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await page.getByRole('tab', { name: 'Worktrees', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'alpha', exact: true })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'beta', exact: true })).toBeVisible()
    const beta = page.getByRole('region', { name: records[1].repository, exact: true })
    await beta.getByRole('button', { name: 'Copy path', exact: true }).click()
    expect(await application.evaluate(({ clipboard }) => clipboard.readText())).toBe(
      records[1].path,
    )
    await beta.getByRole('button', { name: 'Copy revision', exact: true }).click()
    expect(await application.evaluate(({ clipboard }) => clipboard.readText())).toBe(
      records[1].target,
    )
    await application.evaluate(({ shell }) => {
      shell.openPath = async (path) => {
        process.env.REVUI_TEST_OPENED_PATH = path
        return ''
      }
    })
    const fileManager =
      process.platform === 'darwin'
        ? 'Finder'
        : process.platform === 'win32'
          ? 'Explorer'
          : 'file manager'
    await beta.getByRole('button', { name: `Open in ${fileManager}`, exact: true }).click()
    await expect
      .poll(() => application.evaluate(() => process.env.REVUI_TEST_OPENED_PATH))
      .toBe(records[1].path)
    await beta.getByRole('button', { name: 'Remove worktree', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'beta', exact: true })).toHaveCount(0)
    await expect(page.getByRole('heading', { name: 'alpha', exact: true })).toBeVisible()
    expect(
      (await page.evaluate(() => window.desktop.listWorkspaces())).map((record) => record.id),
    ).toEqual([records[0].id])
    // External deletion is reconciled when returning to the app, without a restart.
    await rm(records[0].path, { recursive: true, force: true })
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await expect(page.getByRole('heading', { name: 'alpha', exact: true })).toHaveCount(0)
    await expect(page.getByText('No managed workspaces yet.', { exact: true })).toBeVisible()
    expect(JSON.parse(await readFile(join(data, 'workspaces.json'), 'utf8')).records).toEqual([])
  } finally {
    await application.close()
    await rm(root, { recursive: true, force: true })
  }
})
