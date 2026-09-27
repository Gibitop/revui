import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it } from 'vitest'
import { IntelligenceService } from './intelligence'
import { ReviewService } from './review'
import { WorkspaceService, workspaceGit as git } from './workspace'
import type { IntelligenceRequest } from '../shared/intelligence'

const roots: string[] = []
const services: IntelligenceService[] = []
afterEach(async () => {
  for (const service of services.splice(0)) service.close()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function fixture(files: Record<string, string> = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'revui-intelligence-')))
  const data = await mkdtemp(join(tmpdir(), 'revui-intelligence-data-'))
  roots.push(root, data)
  await git(root, ['init', '-b', 'main'])
  await git(root, ['config', 'user.email', 'test@example.com'])
  await git(root, ['config', 'user.name', 'Test'])
  await mkdir(join(root, 'src'))
  await writeFile(
    join(root, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        jsx: 'preserve',
        allowJs: true,
        baseUrl: '.',
        paths: { '@/*': ['src/*'] },
      },
      include: ['src'],
    }),
  )
  await writeFile(join(root, 'src/model.ts'), 'export const answer: number = 42\n')
  await writeFile(
    join(root, 'src/main.tsx'),
    "import { answer } from '@/model'\nexport const result = answer\n",
  )
  await writeFile(
    join(root, 'src/plain.js'),
    "import { answer } from './model'\nexport const result = answer\n",
  )
  for (const [path, contents] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), contents)
  }
  await git(root, ['add', '.'])
  await git(root, ['commit', '-m', 'fixture'])
  const reviews = new ReviewService(data)
  const workspaces = new WorkspaceService(data)
  await workspaces.load()
  const snapshot = await reviews.open(
    root,
    { base: { kind: 'commit', ref: 'HEAD' }, target: { kind: 'working' }, mode: 'direct' },
    randomUUID(),
  )
  const service = new IntelligenceService(reviews, workspaces)
  services.push(service)
  const request: IntelligenceRequest = {
    snapshot: snapshot.id,
    workspace: null,
    path: 'src/main.tsx',
    line: 1,
    character: 23,
    kind: 'hover',
  }
  return { root, service, reviews, request, workspaces }
}
it('provides real TSX/JS hovers, alias/import definitions and references without source writes', async () => {
  const { root, service, request } = await fixture()
  expect((await service.query(request)).hover).toContain('number')
  const definition = await service.query({ ...request, kind: 'definition' })
  expect(definition.locations).toEqual([{ path: 'src/model.ts', line: 1, character: 13 }])
  expect(
    (await service.query({ ...request, kind: 'definition', line: 0, character: 27 })).locations[0]
      .path,
  ).toBe('src/model.ts')
  const references = await service.query({ ...request, kind: 'references' })
  expect(references.locations).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ path: 'src/model.ts' }),
      expect.objectContaining({ path: 'src/main.tsx', line: 2 }),
    ]),
  )
  expect((await service.query({ ...request, path: 'src/plain.js' })).hover).toContain('number')
  expect(
    (
      await service.query({
        ...request,
        path: 'src/model.ts',
        line: 0,
        character: 16,
        kind: 'definition',
      })
    ).locations,
  ).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'src/main.tsx', line: 2 })]))
  expect(await git(root, ['status', '--porcelain'])).toBe('')
  expect(await readFile(join(root, 'src/model.ts'), 'utf8')).toBe(
    'export const answer: number = 42\n',
  )
}, 30000)
it('resolves hovers and definitions into an unbuilt referenced TypeScript project without emitting files', async () => {
  const { root, service, request } = await fixture({
    'tsconfig.json': JSON.stringify({
      files: [],
      references: [{ path: './packages/shared' }, { path: './packages/app' }],
    }),
    'packages/shared/tsconfig.json': JSON.stringify({
      compilerOptions: { composite: true, strict: true, rootDir: 'src', outDir: 'dist' },
      include: ['src'],
    }),
    'packages/shared/src/model.ts': 'export const answer: number = 42\n',
    'packages/app/tsconfig.json': JSON.stringify({
      compilerOptions: {
        composite: true,
        strict: true,
        rootDir: 'src',
        outDir: 'dist',
        baseUrl: '.',
        paths: { '@shared/*': ['../shared/dist/*'] },
      },
      references: [{ path: '../shared' }],
      include: ['src'],
    }),
    'packages/app/src/main.ts':
      "import { answer } from '@shared/model'\nexport const result = answer\n",
  })
  const target = { ...request, path: 'packages/app/src/main.ts' }
  expect((await service.query(target)).hover).toContain('number')
  expect((await service.query({ ...target, kind: 'definition' })).locations).toEqual([
    { path: 'packages/shared/src/model.ts', line: 1, character: 13 },
  ])
  expect(await git(root, ['status', '--porcelain', '--untracked-files=all'])).toBe('')
}, 30000)

it('keeps local intelligence available when an imported dependency is not installed', async () => {
  const { root, service, request } = await fixture({
    'package.json': JSON.stringify({
      private: true,
      dependencies: { 'revui-missing-fixture-dependency': '1.0.0' },
    }),
    'src/main.tsx':
      "import { missing } from 'revui-missing-fixture-dependency'\nimport { answer } from './model'\nexport const result = answer\nexport const unresolved = missing\n",
  })
  // An unresolved module has no review destination, but must not fail the request.
  expect(
    (await service.query({ ...request, line: 0, character: 30, kind: 'definition' })).locations,
  ).toEqual([])
  expect((await service.query({ ...request, line: 3, character: 27 })).unavailable).not.toBe(true)
  expect((await service.query({ ...request, line: 2 })).hover).toContain('number')
  expect((await service.query({ ...request, line: 2, kind: 'definition' })).locations).toEqual([
    { path: 'src/model.ts', line: 1, character: 13 },
  ])
  expect(await git(root, ['status', '--porcelain', '--untracked-files=all'])).toBe('')
}, 30000)

it('rejects files outside the snapshot, invalid positions, symlinks and stale file contents', async () => {
  const { root, service, request, reviews } = await fixture()
  await expect(service.query({ ...request, path: '../outside.ts' })).rejects.toThrow(
    'target review',
  )
  await expect(service.query({ ...request, line: 500 })).rejects.toThrow('outside the file')
  await service.query(request)
  await writeFile(join(root, 'src/main.tsx'), 'export const changed = true\n')
  await expect(service.query(request)).rejects.toThrow(/changes?d?/i)
  await rm(join(root, 'src/main.tsx'))
  await symlink(join(roots[1], 'outside.ts'), join(root, 'src/main.tsx'))
  await writeFile(join(roots[1], 'outside.ts'), 'export const secret = 42')
  const snapshot = await reviews.open(
    root,
    { base: { kind: 'commit', ref: 'HEAD' }, target: { kind: 'working' }, mode: 'direct' },
    randomUUID(),
  )
  await expect(service.query({ ...request, snapshot: snapshot.id })).rejects.toThrow(
    'outside the review workspace',
  )
}, 30000)
it('requires the matching historical workspace and supports a staged snapshot with unstaged changes isolated', async () => {
  const { root, reviews, workspaces, service, request } = await fixture()
  const first = await git(root, ['rev-parse', 'HEAD'])
  await writeFile(join(root, 'src/model.ts'), 'export const answer: string = "new"\n')
  await git(root, ['commit', '-am', 'new'])
  const historical = await reviews.open(
    root,
    {
      base: { kind: 'commit', ref: 'HEAD' },
      target: { kind: 'commit', ref: first },
      mode: 'direct',
    },
    randomUUID(),
  )
  const historicRequest = { ...request, snapshot: historical.id }
  await expect(service.query(historicRequest)).resolves.toEqual({
    hover: '',
    locations: [],
    unavailable: true,
  })
  const workspace = await workspaces.prepare(historical, 'worktree', false)
  expect((await service.query({ ...historicRequest, workspace: workspace.id })).hover).toContain(
    'number',
  )
  await writeFile(join(root, 'src/model.ts'), 'export const answer: boolean = true\n')
  await git(root, ['add', '.'])
  const staged = await reviews.open(
    root,
    { base: { kind: 'commit', ref: 'HEAD' }, target: { kind: 'index' }, mode: 'direct' },
    randomUUID(),
  )
  expect((await service.query({ ...request, snapshot: staged.id })).hover).toContain('boolean')
  await writeFile(join(root, 'src/model.ts'), 'export const answer: number = 99\n')
  await expect(service.query({ ...request, snapshot: staged.id })).resolves.toEqual({
    hover: '',
    locations: [],
    unavailable: true,
  })
  const stagedWorkspace = await workspaces.prepare(
    await reviews.workspaceSnapshot(staged.id),
    'worktree',
    false,
  )
  expect(
    (await service.query({ ...request, snapshot: staged.id, workspace: stagedWorkspace.id })).hover,
  ).toContain('boolean')
}, 60000)

it('discards requests on close and refreshes language state after dependency changes', async () => {
  const { root, service, request, reviews } = await fixture()
  const pending = service.query(request)
  service.close()
  await expect(pending).rejects.toThrow('Review changed')
  const concurrent = await Promise.all([
    service.query(request),
    service.query({ ...request, kind: 'definition' }),
  ])
  expect(concurrent[0].hover).toContain('number')
  expect(concurrent[1].locations[0].path).toBe('src/model.ts')
  await writeFile(join(root, 'src/model.ts'), 'export const answer: string = "updated"\n')
  await expect(service.query(request)).rejects.toThrow('Local changes differ')
  service.close()
  const snapshot = await reviews.open(
    root,
    { base: { kind: 'commit', ref: 'HEAD' }, target: { kind: 'working' }, mode: 'direct' },
    randomUUID(),
  )
  expect((await service.query({ ...request, snapshot: snapshot.id })).hover).toContain('string')
}, 30000)
