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
      for (
        let slash = filename.indexOf('/');
        slash >= 0;
        slash = filename.indexOf('/', slash + 1)
      ) {
        const suffix = filename.slice(slash + 1)
        if (paths.has(suffix)) {
          path = suffix
          break
        }
      }
    }
    if (!path) return undefined
    const line = location ? Number(location[1] ?? location[2]) : undefined
    return { path, line: line && Number.isSafeInteger(line) ? line : undefined }
  }
  // A regex containing every alias takes seconds to compile for a monorepo and
  // blocks streaming Markdown. Bound text scans by the longest actual alias instead.
  let longestAlias = 0
  const firstCharacters = new Set<string>()
  for (const [name, path] of aliases) {
    if (!path) continue
    longestAlias = Math.max(longestAlias, name.length)
    firstCharacters.add(name[0])
  }
  const lineSuffix = /^(?::\d+(?::\d+)?(?:-\d+)?|#L\d+(?:C\d+)?(?:-L?\d+)?)/
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
        if (child.type !== 'text' || !longestAlias) {
          visit(child)
          return [child]
        }
        const result: MarkdownNode[] = []
        const value = child.value ?? ''
        let offset = 0
        for (let start = 0; start < value.length; start++) {
          if (
            !firstCharacters.has(value[start]) ||
            (start > 0 && /[\w./\\-]/.test(value[start - 1]))
          )
            continue
          let matchedEnd = start
          for (let end = start + 1; end <= Math.min(value.length, start + longestAlias); end++) {
            if (/^(?:[\w/\\-]|\.[\w])/.test(value.slice(end, end + 2))) continue
            if (!aliases.get(value.slice(start, end))) continue
            const suffix = lineSuffix.exec(value.slice(end))?.[0] ?? ''
            const after = end + suffix.length
            if (!/^(?:[\w/\\-]|\.[\w])/.test(value.slice(after, after + 2))) matchedEnd = after
          }
          if (matchedEnd === start) continue
          if (start > offset) result.push({ type: 'text', value: value.slice(offset, start) })
          const reference = value.slice(start, matchedEnd)
          result.push({
            type: 'link',
            url: `#review-file=${encodeURIComponent(reference)}`,
            children: [{ type: 'text', value: reference }],
          })
          offset = matchedEnd
          start = matchedEnd - 1
        }
        if (offset < value.length) result.push({ type: 'text', value: value.slice(offset) })
        return result.length ? result : [child]
      })
    }
    visit(tree)
  }
  return { resolve, plugin }
}
