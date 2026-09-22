import { _electron as electron, expect, test } from '@playwright/test'
import { createServer } from 'vite'
import { resolveConfig } from 'electron-vite'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('development highlighting survives switching repositories', async () => {
  test.setTimeout(60000)
  const root = await mkdtemp(join(tmpdir(), 'revui-dev-test-'))
  const repositories = [join(root, 'first'), join(root, 'second')]
  for (const path of repositories) {
    await mkdir(path)
    await promisify(execFile)('git', ['init', '-b', 'main', path])
    await writeFile(join(path, 'example.ts'), 'export const count: number = 1;\n')
  }
  const config = await resolveConfig({ mode: 'development' }, 'serve')
  const server = await createServer({ ...config.config!.renderer, server: { host: '127.0.0.1', port: 0 } })
  await server.listen()
  const address = server.httpServer!.address() as { port: number }
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined))
  env.REVUI_USER_DATA = join(root, 'data')
  env.ELECTRON_RENDERER_URL = `http://127.0.0.1:${address.port}/`
  env.REVUI_TEST_HIDDEN = '1'
  delete env.ELECTRON_RUN_AS_NODE
  const application = await electron.launch({ args: ['.'], env })
  try {
    const page = await application.firstWindow()
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })
    for (let index = 0; index < repositories.length; index++) {
      await application.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }) }, repositories[index])
      await page.getByRole('button', { name: index ? 'first' : 'Open repository', exact: true }).click()
      await page.getByRole('button', { name: 'Add repository', exact: true }).click()
      await expect.poll(() => page.getByRole('article', { name: 'example.ts', exact: true }).locator('[data-line] span[style]').count(), { timeout: 15000 }).toBeGreaterThan(0)
    }
    expect(errors).toEqual([])
  } finally {
    await application.close()
    await server.close()
    await rm(root, { recursive: true, force: true })
  }
})
