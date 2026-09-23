import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { inspectRepository } from './repository'

const exec = promisify(execFile)
const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

it('opens a repository from a nested folder with spaces and Unicode', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'revui repo Ω-'))
  directories.push(directory)
  await exec('git', ['init', '-b', 'main', directory])
  expect((await inspectRepository(directory)).branch).toBe('main')
  await mkdir(join(directory, 'nested'))
  await writeFile(join(directory, 'file.txt'), 'hello')
  await exec('git', ['-C', directory, 'add', '.'])
  await exec('git', [
    '-C',
    directory,
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.com',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-m',
    'Initial',
  ])
  expect(await inspectRepository(join(directory, 'nested'))).toMatchObject({
    path: await realpath(directory),
    branch: 'main',
  })
  await exec('git', ['-C', directory, 'checkout', '--detach'])
  expect((await inspectRepository(directory)).branch).toBeNull()
})

it('rejects a folder outside a working tree', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'revui-not-a-repo-'))
  directories.push(directory)
  await expect(inspectRepository(directory)).rejects.toThrow('Git working tree')
})
