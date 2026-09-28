import { describe, expect, it } from 'vitest'
import type { Snapshot } from '../../shared/review'
import { chatFileReferences } from './chatFiles'

const snapshot = {
  repository: '/repo',
  paths: ['src/app.ts', 'src/a/index.ts', 'src/b/index.ts', 'docs/my guide.md'],
  files: [{ path: 'src/app.ts', oldPath: 'src/old.ts' }],
} as Snapshot

describe('chat file references', () => {
  it('resolves repository paths, unique names, renamed paths, and line references', () => {
    const { resolve } = chatFileReferences(snapshot)
    for (const reference of [
      'src/app.ts:12:3',
      './src/app.ts#L12-L15',
      '/repo/src/app.ts:12',
      'file:///repo/src/app.ts#L12',
      'app.ts:12',
      '/other/src/app.ts:12',
      '/Users/gibito/Library/Application%20Support/RevUI/worktrees/4f51a866-2328-4c61-b7e6-dc382ca72e30/src/app.ts:12',
      'file:///tmp/review-worktree/src/app.ts#L12',
      'C:\\worktrees\\review\\src\\app.ts:12',
    ])
      expect(resolve(reference)).toEqual({ path: 'src/app.ts', line: 12 })
    expect(resolve('src/old.ts')?.path).toBe('src/app.ts')
    expect(resolve('docs/my%20guide.md')?.path).toBe('docs/my guide.md')
    for (const reference of [
      'index.ts',
      '../src/app.ts',
      'missing.ts',
      '/tmp/review/missing.ts',
      '/tmp/review/../src/app.ts',
      '/tmp/review/index.ts',
      'https://example.com/src/app.ts',
      '%XX',
    ])
      expect(resolve(reference)).toBeUndefined()
  })

  it('links prose and inline code without changing fenced code or existing links', () => {
    const tree = {
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [
            {
              type: 'text',
              value: 'See src/app.ts:12, app.ts and src/app.tsx. index.ts is ambiguous.',
            },
            { type: 'inlineCode', value: 'docs/my guide.md' },
            {
              type: 'link',
              url: 'https://example.com',
              children: [{ type: 'text', value: 'src/app.ts' }],
            },
          ],
        },
        { type: 'code', value: 'src/app.ts' },
      ],
    }
    chatFileReferences(snapshot).plugin()(tree)
    expect(tree.children[0].children?.map((node) => node.type)).toEqual([
      'text',
      'link',
      'text',
      'link',
      'text',
      'link',
      'link',
    ])
    expect(tree.children[0].children?.[1]).toMatchObject({ url: '#review-file=src%2Fapp.ts%3A12' })
    expect(tree.children[0].children?.at(-1)).toMatchObject({
      children: [{ type: 'text', value: 'src/app.ts' }],
    })
    expect(tree.children[1]).toEqual({ type: 'code', value: 'src/app.ts' })
  })
})

it('links large-repository references without building a repository-sized regular expression', () => {
  const paths = Array.from({ length: 100000 }, (_, i) => `packages/pkg-${i}/src/file-${i}.ts`)
  paths.push('docs/my guide.md', 'docs/my', 'src/a+b[1].ts')
  const references = chatFileReferences({
    repository: '/repo',
    paths,
    files: [],
  } as unknown as Snapshot)
  const tree = {
    type: 'root',
    children: [
      {
        type: 'text',
        value:
          'Reviewing package dependencies. See packages/pkg-99999/src/file-99999.ts:20, docs/my guide.md and src/a+b[1].ts. file-99999.tsx is not a file.',
      },
    ],
  }
  references.plugin()(tree)
  expect(tree.children.filter((node) => node.type === 'link')).toEqual([
    {
      type: 'link',
      url: '#review-file=packages%2Fpkg-99999%2Fsrc%2Ffile-99999.ts%3A20',
      children: [{ type: 'text', value: 'packages/pkg-99999/src/file-99999.ts:20' }],
    },
    {
      type: 'link',
      url: '#review-file=docs%2Fmy%20guide.md',
      children: [{ type: 'text', value: 'docs/my guide.md' }],
    },
    {
      type: 'link',
      url: '#review-file=src%2Fa%2Bb%5B1%5D.ts',
      children: [{ type: 'text', value: 'src/a+b[1].ts' }],
    },
  ])
  expect(references.resolve('/another/worktree/packages/pkg-99999/src/file-99999.ts:20')).toEqual({
    path: paths[99999],
    line: 20,
  })
})
