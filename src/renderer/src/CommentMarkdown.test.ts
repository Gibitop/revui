import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { CommentMarkdown, type SuggestionSource } from './CommentMarkdown'
import type { GitLabSuggestion } from '../../shared/gitlab'

function render(
  body: string,
  suggestions?: GitLabSuggestion[],
  suggestionSource?: SuggestionSource,
) {
  return renderToStaticMarkup(
    createElement(CommentMarkdown, { body, suggestions, suggestionSource, onError: () => {} }),
  )
}

describe('comment code blocks', () => {
  it.each(['javascript', 'js', 'typescript', 'ts'])(
    'honors the explicit %s language',
    (language) => {
      const html = render('```' + language + '\nconst value = "hello";\n```')
      expect(html).toContain('language-' + language)
      expect(html).toContain('<span class="hljs-keyword">const</span>')
      expect(html).toContain('hljs-string')
    },
  )

  it('detects an unlabeled block', () => {
    const html = render('```\ndef greet(name):\n    print("Hello", name)\n```')
    expect(html).toContain('hljs-keyword')
    expect(html).toContain('hljs-string')
  })

  it.each(['text', 'plaintext', 'txt', 'unknown-language'])(
    'leaves %s blocks uncolored',
    (language) => {
      const html = render('```' + language + '\nconst value = "hello";\n```')
      expect(html).not.toContain('<span')
      expect(html).toContain('const value = &quot;hello&quot;;')
    },
  )

  it('leaves inline code alone and preserves suggestion labels', () => {
    expect(render('`const value = 1`')).not.toContain('hljs')
    expect(render('```suggestion:-2+0\nreplacement\n```')).toContain('Suggested change')
  })

  it('keeps HTML inside code escaped', () => {
    const html = render('```html\n<script>alert("test")</script>\n```')
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;')
    expect(render('<script>alert("test")</script>')).not.toContain('<script>')
  })
})

const suggestion: GitLabSuggestion = {
  id: 1,
  from_line: 10,
  to_line: 12,
  from_content: 'keep\nold\nend\n',
  to_content: 'keep\nnew\nend\n',
  applicable: true,
  applied: false,
}

describe('GitLab suggestion diffs', () => {
  it('shows removed, added and unchanged lines using GitLab source text', () => {
    const html = render('```suggestion:-2+0\nkeep\nnew\nend\n```', [suggestion])
    expect(html).toContain('data-suggestion-diff="true"')
    expect(html).toContain('data-change="removed"')
    expect(html).toContain('data-change="added"')
    expect(html.match(/data-change="context"/g)).toHaveLength(2)
    expect(html).toContain('old')
    expect(html).toContain('new')
  })

  it('keeps multiple suggestions paired with their original ranges', () => {
    const html = render('```suggestion\nnew\n```\n\n```suggestion\nnew\n```', [
      { ...suggestion, from_content: 'first old\n', to_content: 'new\n' },
      { ...suggestion, id: 2, from_content: 'second old\n', to_content: 'new\n' },
    ])
    expect(html.match(/data-suggestion-diff="true"/g)).toHaveLength(2)
    expect(html.indexOf('first old')).toBeLessThan(html.indexOf('second old'))
  })

  it('renders empty replacements as deletions, including applied suggestions', () => {
    const html = render('```suggestion\n```', [{ ...suggestion, to_content: '', applied: true }])
    expect(html).toContain('data-change="removed"')
    expect(html).not.toContain('data-change="added"')
  })

  it('falls back to the proposed code when source data is missing or stale', () => {
    const body = '```suggestion\nchanged again\n```'
    for (const metadata of [undefined, [suggestion]]) {
      const html = render(body, metadata)
      expect(html).not.toContain('data-suggestion-diff')
      expect(html).toContain('Suggested change')
      expect(html).toContain('changed again')
      expect(html).not.toContain('data-change="removed"')
    }
  })
})

describe('local suggestion diffs', () => {
  const source = { contents: 'before\nregistrySource,\nafter\n', line: 2 }
  it('renders the local suggestion without GitLab metadata', () => {
    const html = render(
      '```suggestion:-0+0\nregistrySource: registrySource,\n```',
      undefined,
      source,
    )
    expect(html).toContain('data-suggestion-diff="true"')
    expect(html).toContain('data-change="removed"')
    expect(html).toContain('registrySource,')
    expect(html).toContain('data-change="added"')
    expect(html).toContain('registrySource: registrySource,')
  })
  it('uses offsets around the anchor and supports multiple ranges', () => {
    const html = render(
      '```suggestion:-1+1\nreplacement\n```\n\n```suggestion\nother\n```',
      undefined,
      source,
    )
    expect(html.match(/data-suggestion-diff="true"/g)).toHaveLength(2)
    expect(html.match(/data-change="removed"/g)).toHaveLength(4)
    expect(html).toContain('before')
    expect(html).toContain('after')
  })
  it('does not invent original text for unavailable or invalid ranges', () => {
    for (const language of ['suggestion:-2+0', 'suggestion:-0+2']) {
      expect(render('```' + language + '\nreplacement\n```', undefined, source)).not.toContain(
        'data-suggestion-diff',
      )
    }
    expect(render('```suggestion\nreplacement\n```')).not.toContain('data-suggestion-diff')
  })
  it('supports empty replacements and an empty original line', () => {
    const html = render('```suggestion\n```', undefined, source)
    expect(html).toContain('data-change="removed"')
    expect(html).not.toContain('data-change="added"')
    expect(render('```suggestion\nnew\n```', undefined, { contents: '\n', line: 1 })).toContain(
      'data-suggestion-diff="true"',
    )
  })
})
