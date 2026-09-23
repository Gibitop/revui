import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { realpath } from 'node:fs/promises'
import { basename } from 'node:path'
import type { Repository } from '../shared/desktop'

const execFileAsync = promisify(execFile)

export async function inspectRepository(directory: string): Promise<Repository> {
  let root: string
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['--no-optional-locks', '-C', directory, 'rev-parse', '--show-toplevel'],
      {
        timeout: 10_000,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      },
    )
    root = await realpath(stdout.replace(/\r?\n$/, ''))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        'Git or the repository folder could not be found. Check that Git is installed and the folder still exists.',
      )
    }
    throw new Error(
      'This folder could not be opened as a Git working tree. Check the folder and its Git permissions.',
    )
  }
  const { stdout } = await execFileAsync(
    'git',
    ['--no-optional-locks', '-C', root, 'symbolic-ref', '--quiet', '--short', 'HEAD'],
    {
      timeout: 10_000,
      windowsHide: true,
    },
  ).catch(() => ({ stdout: '' }))
  const branch = stdout.trim()
  return { name: basename(root), path: root, branch: branch && branch !== 'HEAD' ? branch : null }
}
