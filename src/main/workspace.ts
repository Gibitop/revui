import { homedir } from 'node:os'
import { access } from 'node:fs/promises'
import { ideChoices, type IDE } from '../shared/workspace'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, realpath, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { z } from 'zod'
import type { Snapshot } from '../shared/review'
import type { Workspace, ToolCommands } from '../shared/workspace'

const exec = promisify(execFile)
export async function workspaceGit(path: string, args: string[], env = process.env) {
  const { stdout } = await exec('git', ['-C', path, ...args], {
    env,
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  })
  return stdout.trimEnd()
}
const recordSchema = z.object({
  id: z.string().uuid(),
  repository: z.string(),
  path: z.string(),
  snapshot: z.string(),
  kind: z.enum(['worktree', 'in-place']),
  original: z.string(),
  branch: z.string().nullable(),
  target: z.string(),
  stash: z.string().nullable(),
  initialized: z.boolean().default(false),
  phase: z.enum(['preparing', 'ready', 'restoring', 'restored', 'failed']),
  error: z.string().nullable(),
})
export const commandsSchema = z
  .object({
    script: z.string().max(32000),
  })
  .strict()

export class IgnoredWorkspaceFiles extends Error {
  constructor(public files: string) {
    super('Worktree contains ignored files. Confirm their removal before deleting the worktree.')
  }
}

export class WorkspaceService {
  private records: Workspace[] = []
  private busy = false
  constructor(private directory: string) {}
  async load() {
    await mkdir(this.directory, { recursive: true })
    try {
      const value = z
        .object({ version: z.literal(1), records: z.array(recordSchema) })
        .parse(JSON.parse(await readFile(join(this.directory, 'workspaces.json'), 'utf8')))
      this.records = value.records
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw new Error(
          'Workspace recovery records cannot be read. Preserve workspaces.json and repair it before continuing.',
          { cause: error },
        )
    }
  }
  list(repository?: string) {
    return structuredClone(
      this.records.filter((record) => !repository || record.repository === repository),
    )
  }
  async pruneMissing() {
    // Never reconcile while a managed checkout is being created or removed.
    if (this.busy) return
    this.busy = true
    try {
      const missing = new Set<string>()
      for (const record of this.records) {
        if (record.kind !== 'worktree' || record.phase === 'preparing') continue
        try {
          await access(record.path)
        } catch (error) {
          // Permission and other I/O errors do not mean a worktree was deleted.
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') missing.add(record.id)
        }
      }
      if (missing.size) {
        this.records = this.records.filter((record) => !missing.has(record.id))
        await this.save()
      }
    } finally {
      this.busy = false
    }
  }
  get(id: string) {
    const record = this.records.find((record) => record.id === id)
    if (!record) throw new Error('Unknown workspace')
    return record
  }
  async findMatching(snapshot: Snapshot & { indexTree?: string }) {
    await this.pruneMissing()
    const target = snapshot.comparison.target
    if (target.kind === 'working') return null
    const revision =
      target.kind === 'commit'
        ? await workspaceGit(snapshot.repository, [
            'rev-parse',
            '--verify',
            `${target.ref}^{commit}`,
          ])
        : snapshot.indexTree
    if (!revision) return null
    const records = this.records
      .filter(
        (record) =>
          record.repository === snapshot.repository &&
          record.kind === 'worktree' &&
          record.phase === 'ready',
      )
      .sort((a, b) => Number(!!b.initialized) - Number(!!a.initialized))
    for (const record of records) {
      const actual = await workspaceGit(record.path, [
        'rev-parse',
        '--verify',
        target.kind === 'commit' ? 'HEAD^{commit}' : 'HEAD^{tree}',
      ]).catch(() => null)
      if (actual === revision) return structuredClone(record)
    }
    return null
  }
  async markInitialized(id: string, initialized: boolean) {
    this.get(id).initialized = initialized
    await this.save()
  }
  private async save() {
    const path = join(this.directory, 'workspaces.json')
    const temporary = `${path}.${randomUUID()}.tmp`
    await writeFile(temporary, JSON.stringify({ version: 1, records: this.records }), {
      mode: 0o600,
      flag: 'wx',
    })
    await rename(temporary, path)
  }
  async prepare(
    snapshot: Snapshot & { indexTree?: string },
    kind: Workspace['kind'],
    allowStash: boolean,
  ) {
    if (this.busy) throw new Error('Another workspace operation is running')
    this.busy = true
    let record: Workspace | undefined
    try {
      const repository = snapshot.repository
      if (snapshot.comparison.target.kind === 'working')
        throw new Error('Working-tree reviews already use the current workspace.')
      if (
        this.records.some(
          (r) => r.repository === repository && r.kind === 'in-place' && r.phase !== 'restored',
        )
      )
        throw new Error('Restore the existing in-place workspace first.')
      if (snapshot.comparison.target.kind === 'index' && kind === 'in-place')
        throw new Error('Index reviews require an isolated worktree.')
      const original = await workspaceGit(repository, ['rev-parse', '--verify', 'HEAD']).catch(
        () => '',
      )
      if (!original && kind === 'in-place')
        throw new Error('An unborn branch requires an isolated worktree.')
      const branch = await workspaceGit(repository, ['symbolic-ref', '-q', 'HEAD']).catch(
        () => null,
      )
      let target =
        snapshot.comparison.target.kind === 'commit' ? snapshot.comparison.target.ref : ''
      if (!target) {
        const tree = snapshot.indexTree
        if (!tree) throw new Error('An immutable index tree is required.')
        target = await workspaceGit(repository, [
          '-c',
          'user.name=RevUI',
          '-c',
          'user.email=revui@localhost',
          'commit-tree',
          tree,
          ...(original ? ['-p', original] : []),
          '-m',
          'RevUI isolated index snapshot',
        ])
      }
      const id = randomUUID()
      record = {
        id,
        repository,
        path: kind === 'in-place' ? repository : join(this.directory, 'worktrees', id),
        snapshot: snapshot.id,
        kind,
        original,
        branch,
        target,
        stash: null,
        phase: 'preparing',
        error: null,
      }
      if (
        kind === 'in-place' &&
        (await workspaceGit(repository, [
          'status',
          '--porcelain',
          '--untracked-files=all',
          '--ignore-submodules=none',
        ])) &&
        !allowStash
      )
        throw new Error('Stashing tracked and untracked changes requires confirmation.')
      this.records.push(record)
      await this.save()
      if (kind === 'worktree') {
        await mkdir(join(this.directory, 'worktrees'), { recursive: true })
        await workspaceGit(repository, ['worktree', 'add', '--detach', record.path, target])
      } else {
        if (
          await workspaceGit(repository, [
            'status',
            '--porcelain',
            '--untracked-files=all',
            '--ignore-submodules=none',
          ])
        ) {
          await workspaceGit(repository, [
            'stash',
            'push',
            '--include-untracked',
            '-m',
            `RevUI ${id}`,
          ])
          record.stash =
            (await workspaceGit(repository, ['stash', 'list', '--format=%H %gs']))
              .split('\n')
              .find((line) => line.endsWith(`RevUI ${id}`))
              ?.split(' ')[0] ?? null
          if (!record.stash)
            throw new Error('Git did not create the expected stash. Checkout was blocked.')
          await this.save()
        }
        if (
          await workspaceGit(repository, [
            'status',
            '--porcelain',
            '--untracked-files=all',
            '--ignore-submodules=none',
          ])
        )
          throw new Error('Workspace is still dirty after stashing; checkout blocked.')
        await workspaceGit(repository, ['checkout', '--no-overwrite-ignore', '--detach', target])
      }
      record.phase = 'ready'
      await this.save()
      return structuredClone(record)
    } catch (error) {
      if (record) {
        record.phase = 'failed'
        record.error = String(error)
        await this.save()
      }
      throw error
    } finally {
      this.busy = false
    }
  }
  async restore(id: string) {
    if (this.busy) throw new Error('Another workspace operation is running')
    const record = this.get(id)
    this.busy = true
    try {
      if (record.kind !== 'in-place' || record.phase === 'restored')
        throw new Error('This workspace does not need restoration')
      if (record.phase === 'restoring')
        throw new Error(
          'An earlier restoration was interrupted. Inspect the workspace and recover the recorded stash manually before proceeding.',
        )
      // Recover the exact stash if the process stopped between stash creation and journal update.
      if (!record.stash) {
        const stashes = await workspaceGit(record.repository, ['stash', 'list', '--format=%H %gs'])
        record.stash =
          stashes
            .split('\n')
            .find((line) => line.endsWith(`RevUI ${record.id}`))
            ?.split(' ')[0] ?? null
      }
      if (
        await workspaceGit(record.path, [
          'status',
          '--porcelain',
          '--untracked-files=all',
          '--ignore-submodules=none',
        ])
      )
        throw new Error(
          'New workspace changes exist. Commit or stash them yourself before restoring; nothing was overwritten.',
        )
      const head = await workspaceGit(record.path, ['rev-parse', 'HEAD'])
      if (head !== record.target && head !== record.original)
        throw new Error(
          'Checkout changed outside RevUI. Restore manually to avoid losing new work.',
        )
      if (
        record.branch &&
        (await workspaceGit(record.path, ['rev-parse', record.branch])) !== record.original
      )
        throw new Error('Original branch moved. Restore manually; no checkout was changed.')
      record.phase = 'restoring'
      await this.save()
      await workspaceGit(record.path, [
        'checkout',
        '--no-overwrite-ignore',
        record.branch ? record.branch.replace(/^refs\/heads\//, '') : '--detach',
        ...(record.branch ? [] : [record.original]),
      ])
      if (record.stash) await workspaceGit(record.path, ['stash', 'apply', '--index', record.stash])
      // Keep the stash as a recovery copy. Never drop a stash by its shifting stack position.
      record.phase = 'restored'
      record.error = null
      await this.save()
    } catch (error) {
      record.error = `${String(error)}${record.stash ? ` Recovery stash: ${record.stash}. Use git stash apply --index ${record.stash} only after resolving the workspace state.` : ''}`
      await this.save()
      throw new Error(record.error)
    } finally {
      this.busy = false
    }
  }
  async acknowledgeRestoration(id: string) {
    if (this.busy) throw new Error('Another workspace operation is running')
    this.busy = true
    try {
      const record = this.get(id)
      if (record.kind !== 'in-place') throw new Error('Only in-place workspaces need restoration')
      if (
        (await workspaceGit(record.path, ['rev-parse', 'HEAD'])) !== record.original ||
        (await workspaceGit(record.path, ['symbolic-ref', '-q', 'HEAD']).catch(() => null)) !==
          record.branch ||
        (await workspaceGit(record.path, ['ls-files', '--unmerged']))
      )
        throw new Error(
          'Return to the original checkout and resolve all conflicts before marking recovery complete.',
        )
      record.phase = 'restored'
      record.error = null
      await this.save()
    } finally {
      this.busy = false
    }
  }
  async remove(id: string, removeIgnored = false) {
    if (this.busy) throw new Error('Another workspace operation is running')
    this.busy = true
    try {
      const record = this.get(id)
      if (record.kind !== 'worktree') throw new Error('Only managed worktrees can be removed')
      // Ignored setup output can be removed with confirmation; source changes cannot.
      if (
        await workspaceGit(record.path, [
          'status',
          '--porcelain',
          '--untracked-files=all',
          '--ignore-submodules=none',
        ])
      )
        throw new Error(
          'Worktree contains tracked changes or untracked files. Commit, stash, or move them before removal.',
        )
      if ((await workspaceGit(record.path, ['rev-parse', 'HEAD'])) !== record.target)
        throw new Error('Worktree HEAD changed. Preserve your commits before cleanup.')
      const ignored = await workspaceGit(record.path, [
        'ls-files',
        '--others',
        '--ignored',
        '--exclude-standard',
        '--directory',
      ])
      if (ignored && !removeIgnored) throw new IgnoredWorkspaceFiles(ignored)
      await workspaceGit(record.repository, [
        'worktree',
        'remove',
        ...(ignored ? ['--force'] : []),
        record.path,
      ])
      this.records = this.records.filter((r) => r.id !== id)
      await this.save()
    } finally {
      this.busy = false
    }
  }
}

export async function workspaceMatches(snapshot: Snapshot & { indexTree?: string }, path: string) {
  const target = snapshot.comparison.target
  if (target.kind === 'working') return path === snapshot.repository
  if (target.kind === 'index') {
    if (path !== snapshot.repository)
      return (
        (await workspaceGit(path, ['rev-parse', 'HEAD^{tree}']).catch(() => '')) ===
        snapshot.indexTree
      )
    // A staged snapshot matches the checkout only when tracked files have no unstaged edits.
    return (
      (await workspaceGit(path, ['write-tree']).catch(() => '')) === snapshot.indexTree &&
      !(await workspaceGit(path, ['diff-files', '--name-only']))
    )
  }
  const [head, commit] = await Promise.all([
    workspaceGit(path, ['rev-parse', '--verify', 'HEAD^{commit}']).catch(() => ''),
    workspaceGit(snapshot.repository, ['rev-parse', '--verify', `${target.ref}^{commit}`]),
  ])
  return head === commit
}

export async function runWorkspaceScript(
  path: string,
  commands: ToolCommands,
  output: (data: string) => void,
  signal?: AbortSignal,
) {
  const command = commands.script
  if (!command.trim()) return
  signal?.throwIfAborted()
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, {
      cwd: path,
      shell: true,
      windowsHide: true,
      detached: process.platform !== 'win32',
    })
    let escalation: NodeJS.Timeout | undefined
    const cancel = () => {
      if (!child.pid) return
      if (process.platform === 'win32') {
        execFile(
          'taskkill',
          ['/pid', String(child.pid), '/T', '/F'],
          { windowsHide: true },
          () => {},
        )
      } else {
        try {
          process.kill(-child.pid, 'SIGTERM')
        } catch {
          /* Already exited. */
        }
        escalation = setTimeout(() => {
          try {
            process.kill(-child.pid!, 'SIGKILL')
          } catch {
            /* Already exited. */
          }
        }, 1000)
        escalation.unref()
      }
    }
    signal?.addEventListener('abort', cancel, { once: true })
    child.stdout.on('data', (chunk) => output(String(chunk)))
    child.stderr.on('data', (chunk) => output(String(chunk)))
    child.on('error', (error) => {
      signal?.removeEventListener('abort', cancel)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(escalation)
      signal?.removeEventListener('abort', cancel)
      if (signal?.aborted)
        reject(
          new Error(
            'Post-checkout script canceled. Inspect any files it changed before continuing.',
          ),
        )
      else if (code === 0) resolve()
      else reject(new Error(`Post-checkout script exited with ${code}`))
    })
    if (signal?.aborted) cancel()
  })
}

export async function openWorkspaceIDE(root: string, path: string | null, line: number, ide: IDE) {
  const file = await realpath(path === null ? root : resolve(root, path))
  const rel = relative(await realpath(root), file)
  if (
    rel === '..' ||
    rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) ||
    isAbsolute(rel)
  )
    throw new Error('File is outside the workspace')
  const executables = {
    cursor: 'cursor',
    vscode: 'code',
    idea: process.platform === 'win32' ? 'idea64.exe' : 'idea',
    webstorm: process.platform === 'win32' ? 'webstorm64.exe' : 'webstorm',
  }
  const args =
    path === null
      ? [file]
      : ide === 'cursor' || ide === 'vscode'
        ? ['--goto', `${file}:${line}`]
        : ['--line', String(line), file]
  const candidates: string[] = []
  if (process.platform === 'darwin') {
    const bundles = {
      cursor: 'Cursor.app/Contents/Resources/app/bin/cursor',
      vscode: 'Visual Studio Code.app/Contents/Resources/app/bin/code',
      idea: 'IntelliJ IDEA.app/Contents/MacOS/idea',
      webstorm: 'WebStorm.app/Contents/MacOS/webstorm',
    }
    for (const directory of ['/Applications', join(homedir(), 'Applications')])
      candidates.push(join(directory, bundles[ide]))
  } else if (process.platform === 'win32' && (ide === 'cursor' || ide === 'vscode')) {
    const app = ide === 'cursor' ? ['cursor', 'Cursor.exe'] : ['Microsoft VS Code', 'Code.exe']
    if (process.env.LOCALAPPDATA)
      candidates.push(join(process.env.LOCALAPPDATA, 'Programs', ...app))
    if (process.env.ProgramFiles) candidates.push(join(process.env.ProgramFiles, ...app))
  }
  let executable = executables[ide]
  for (const candidate of candidates) {
    if (
      await access(candidate).then(
        () => true,
        () => false,
      )
    ) {
      executable = candidate
      break
    }
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: root,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    })
    child.once('error', (error) =>
      reject(
        new Error(
          `Could not launch ${ideChoices[ide]}. Install the IDE and its command-line launcher. ${error.message}`,
        ),
      ),
    )
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}
