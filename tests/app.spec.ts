import { _electron as electron, expect, test } from '@playwright/test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

test('desktop startup, repository picker, IPC isolation, preferences, and restart', async ({}, testInfo) => {
  const directory = await mkdtemp(join(tmpdir(), 'revui-e2e-'))
  const repository = await mkdtemp(join(tmpdir(), 'revui-example-'))
  await promisify(execFile)('git', ['init', '-b', 'main', repository])
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined))
  env.REVUI_USER_DATA = directory
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  let application = await electron.launch({ args: ['.'], env })
  try {
    let page = await application.firstWindow()
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await expect(page.getByRole('heading', { name: 'No repository open' })).toBeVisible()
    expect(await page.evaluate(() => typeof (window as unknown as { require?: unknown }).require)).toBe('undefined')
    expect(await page.evaluate(() => typeof (window as unknown as { process?: unknown }).process)).toBe('undefined')

    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await page.getByRole('button', { name: 'Light', exact: true }).click()
    await expect(page.locator('html')).not.toHaveClass('dark')
    await page.getByRole('button', { name: 'Close settings' }).click()
    await page.screenshot({ path: testInfo.outputPath('welcome-light.png'), animations: 'disabled' })
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await page.getByRole('button', { name: 'Dark', exact: true }).click()
    await expect(page.locator('html')).toHaveClass('dark')
    await page.screenshot({ path: testInfo.outputPath('settings-dark.png'), animations: 'disabled' })
    await page.getByRole('button', { name: 'Close settings' }).click()

    await expect(page.evaluate(() => window.desktop.updatePreferences({ theme: 'not-a-theme' } as never))).rejects.toThrow()
    await expect(page.evaluate(() => window.desktop.reopenRepository('/not-selected'))).rejects.toThrow('folder picker')

    await application.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
    }, repository)
    await page.getByRole('button', { name: 'Open repository', exact: true }).click()
    await expect(page.getByRole('heading', { name: basename(repository), exact: true })).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('repository-dark.png'), animations: 'disabled' })
    expect(errors).toEqual([])
    await application.close()

    const saved = JSON.parse(await readFile(join(directory, 'settings.json'), 'utf8'))
    expect(saved).toMatchObject({ theme: 'dark' })
    expect(saved.recentRepositories).toHaveLength(1)
    application = await electron.launch({ args: ['.'], env })
    page = await application.firstWindow()
    await expect(page.locator('html')).toHaveClass('dark')
    await expect(page.getByRole('region', { name: 'Recent repositories' })).toBeVisible()
    await page.getByRole('region', { name: 'Recent repositories' }).getByRole('button').click()
    await expect(page.getByRole('heading', { name: basename(repository), exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Dark', exact: true })).toHaveAttribute('aria-pressed', 'true')
  } finally {
    await application.close()
    await rm(directory, { recursive: true, force: true })
    await rm(repository, { recursive: true, force: true })
  }
})
