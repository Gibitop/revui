import type { Snapshot } from '../../shared/review'

type MarkdownNode = {
  type: string
  value?: string
  url?: string
  children?: MarkdownNode[]
}

export function chatFileReferences(snapshot?: Snapshot) {
  const aliases = new Map<string, string | null>()
  const paths = new Set([
    ...(snapshot?.paths ?? []),
    ...(snapshot?.files.map((file) => file.path) ?? []),
  ])
  for (const path of paths) {
    const name = path.split('/').at(-1)!
    aliases.set(name, aliases.has(name) ? null : path)
  }
  for (const file of snapshot?.files ?? []) {
    if (file.oldPath && file.oldPath !== file.path && !paths.has(file.oldPath))
      aliases.set(file.oldPath, file.path)
  }
  for (const path of paths) {
    aliases.set(path, path)
    aliases.set(`./${path}`, path)
    aliases.set(`${snapshot!.repository}/${path}`, path)
  }
  const resolve = (reference: string) => {
    let value = reference
    try {
      value = decodeURIComponent(value)
    } catch {
      return undefined
    }
    if (value.startsWith('file://')) value = value.slice(7)
    const location = /(?::(\d+)(?::\d+)?(?:-\d+)?|#L(\d+)(?:C\d+)?(?:-L?\d+)?)$/.exec(value)
    const filename = (location ? value.slice(0, location.index) : value).replace(/\\/g, '/')
    let path = aliases.get(filename)
    // Chat may run in an isolated worktree, including one from a previous session.
    // Resolve its repository-relative suffix, never open the supplied absolute path.
    if (
      !path &&
      (/^\//.test(filename) || /^[A-Za-z]:\//.test(filename)) &&
      !filename.split('/').includes('..')
    ) {
      const matches = [...paths].filter((candidate) => filename.endsWith(`/${candidate}`))
      matches.sort((a, b) => b.length - a.length)
      path = matches[0]
    }
    if (!path) return undefined
    const line = location ? Number(location[1] ?? location[2]) : undefined
    return { path, line: line && Number.isSafeInteger(line) ? line : undefined }
  }
  const names = [...aliases].filter(([, path]) => path).map(([name]) => name)
  const pattern = names.length
    ? new RegExp(
        `(?<![\\w./\\\\-])(?:${names
          .sort((a, b) => b.length - a.length)
          .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
          .join(
            '|',
          )})(?::\\d+(?::\\d+)?(?:-\\d+)?|#L\\d+(?:C\\d+)?(?:-L?\\d+)?)?(?![\\w/\\\\-]|\\.[\\w])`,
        'g',
      )
    : null
  // Only prose and inline code are linked; fenced code and existing links stay intact.
  const plugin = () => (tree: MarkdownNode) => {
    const visit = (node: MarkdownNode) => {
      if (!node.children || ['link', 'linkReference', 'code', 'html'].includes(node.type)) return
      node.children = node.children.flatMap((child) => {
        if (child.type === 'inlineCode' && resolve(child.value ?? '')) {
          return [
            {
              type: 'link',
              url: `#review-file=${encodeURIComponent(child.value!)}`,
              children: [child],
            },
          ]
        }
        if (child.type !== 'text' || !pattern) {
          visit(child)
          return [child]
        }
        const result: MarkdownNode[] = []
        const value = child.value ?? ''
        let offset = 0
        for (const match of value.matchAll(pattern)) {
          if (match.index > offset)
            result.push({ type: 'text', value: value.slice(offset, match.index) })
          result.push({
            type: 'link',
            url: `#review-file=${encodeURIComponent(match[0])}`,
            children: [{ type: 'text', value: match[0] }],
          })
          offset = match.index + match[0].length
        }
        if (offset < value.length) result.push({ type: 'text', value: value.slice(offset) })
        return result.length ? result : [child]
      })
    }
    visit(tree)
  }
  return { resolve, plugin }
}
