import { memo, type MouseEvent } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { rehypeEmoji } from './rehypeEmoji'
import rehypeHighlight from 'rehype-highlight'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize from 'rehype-sanitize'
import { diffLines } from 'diff'
import { visit } from 'unist-util-visit'
import type { Element, Root } from 'hast'
import type { GitLabSuggestion } from '../../shared/gitlab'

export type SuggestionSource = { contents: string; line: number }

function rehypeSuggestions({
  suggestions,
  suggestionSource,
}: {
  suggestions?: GitLabSuggestion[]
  suggestionSource?: SuggestionSource
}) {
  const sourceLines = suggestionSource?.contents.split('\n')
  if (sourceLines?.at(-1) === '') sourceLines.pop()
  return (tree: Root) => {
    let index = 0
    visit(tree, 'element', (node, _, parent) => {
      if (
        node.tagName !== 'code' ||
        parent?.type !== 'element' ||
        parent.tagName !== 'pre' ||
        !Array.isArray(node.properties.className) ||
        !node.properties.className.some((name) =>
          /^language-suggestion(?::-\d+\+\d+)?$/.test(String(name)),
        )
      )
        return
      const suggestion = suggestions?.[index++]
      const proposed = node.children
        .map((child) => (child.type === 'text' ? child.value : ''))
        .join('')
      let original: string
      let replacement = proposed
      if (suggestion) {
        // Never pair a changed/optimistic comment with stale source metadata.
        if (proposed.replace(/\n$/, '') !== suggestion.to_content.replace(/\n$/, '')) return
        original = suggestion.from_content
        replacement = suggestion.to_content
      } else if (suggestionSource && sourceLines) {
        const language = node.properties.className.find((name) =>
          String(name).startsWith('language-suggestion'),
        )
        const range = /^language-suggestion(?::-(\d+)\+(\d+))?$/.exec(String(language))!
        const start = suggestionSource.line - Number(range[1] ?? 0)
        const end = suggestionSource.line + Number(range[2] ?? 0)
        if (
          start < 1 ||
          end > sourceLines.length ||
          !Number.isSafeInteger(start) ||
          !Number.isSafeInteger(end)
        )
          return
        original = sourceLines.slice(start - 1, end).join('\n') + '\n'
      } else return
      const changes = diffLines(original, replacement, { timeout: 100 })
      if (!changes) return
      node.properties['data-suggestion-diff'] = true
      node.children = changes.flatMap((change) => {
        const lines = change.value.split('\n')
        if (lines.at(-1) === '') lines.pop()
        return lines.map((line): Element => ({
          type: 'element',
          tagName: 'span',
          properties: {
            className: ['suggestion-line'],
            'data-change': change.removed ? 'removed' : change.added ? 'added' : 'context',
          },
          children: [
            {
              type: 'element',
              tagName: 'span',
              properties: { className: ['suggestion-sign'], ariaHidden: 'true' },
              children: [{ type: 'text', value: change.removed ? '−' : change.added ? '+' : ' ' }],
            },
            { type: 'text', value: line },
          ],
        }))
      })
    })
  }
}

export const CommentMarkdown = memo(function CommentMarkdown({
  body,
  linkBase,
  suggestions,
  suggestionSource,
  onError,
}: {
  body: string
  linkBase?: string
  suggestions?: GitLabSuggestion[]
  suggestionSource?: SuggestionSource
  onError: (error: string) => void
}) {
  return (
    <div className="markdown text-sm leading-[1.7] wrap-anywhere">
      <Markdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[
          rehypeRaw,
          rehypeSanitize,
          rehypeEmoji,
          [rehypeHighlight, { detect: true, plainText: ['text', 'plaintext', 'txt'] }],
          [rehypeSuggestions, { suggestions, suggestionSource }],
        ]}
        components={{
          img: ({ alt }) => <span>{alt}</span>,
          code: ({ className, children, node }) => (
            <code
              className={className}
              data-suggestion-diff={node?.properties['data-suggestion-diff']}
            >
              {className?.split(' ').some((name) => name.startsWith('language-suggestion')) && (
                <span className="mb-2 block border-b pb-2 font-sans text-xs font-medium text-muted-foreground">
                  Suggested change
                </span>
              )}
              {children}
            </code>
          ),
          a: ({ href, children }) => {
            let url: URL
            try {
              if (!href) return <span>{children}</span>
              url = new URL(href, linkBase)
              if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password)
                return <span>{children}</span>
            } catch {
              return <span>{children}</span>
            }
            const open = (event: MouseEvent<HTMLAnchorElement>) => {
              event.preventDefault()
              if (event.type === 'auxclick' && event.button !== 1) return
              void window.desktop
                .openWebLink(url.href)
                .catch((error: Error) => onError(error.message))
            }
            return (
              <a href={url.href} onClick={open} onAuxClick={open}>
                {children}
              </a>
            )
          },
        }}
      >
        {body}
      </Markdown>
    </div>
  )
})
