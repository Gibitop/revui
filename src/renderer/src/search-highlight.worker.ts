import {
  attachResolvedLanguages,
  attachResolvedThemes,
  getFiletypeFromFileName,
  getSharedHighlighter,
  type ThemeRegistrationResolved,
  type ThemedToken,
} from '@pierre/diffs'
import type { ResolvedLanguage } from '@pierre/diffs/worker'
import type { ContentMatch } from '../../shared/review'

export type SearchHighlightResponse = {
  id: number
  tokens: Map<string, Map<number, ThemedToken[]>>
}

let latestRequest = 0
self.onmessage = async (
  event: MessageEvent<{
    id: number
    matches: ContentMatch[]
    theme: 'light' | 'dark'
    languages: ResolvedLanguage[]
    themes: ThemeRegistrationResolved[]
  }>,
) => {
  const { id, matches, theme, languages, themes } = event.data
  latestRequest = id
  if (!matches.length) return
  try {
    const syntaxTheme = theme === 'dark' ? 'pierre-dark' : 'pierre-light'
    const highlighter = await getSharedHighlighter({
      themes: [],
      langs: [],
      preferredHighlighter: 'shiki-js',
    })
    if (id !== latestRequest) return
    attachResolvedLanguages(languages, highlighter)
    attachResolvedThemes(themes, highlighter)
    const tokensByPath: SearchHighlightResponse['tokens'] = new Map()
    for (let index = 0; index < matches.length; index++) {
      // Allow newer searches to cancel obsolete work while retaining loaded grammars.
      if (index % 20 === 0) await new Promise((resolve) => setTimeout(resolve, 0))
      if (id !== latestRequest) return
      const match = matches[index]
      const lines = tokensByPath.get(match.path) ?? new Map<number, ThemedToken[]>()
      const { tokens } = highlighter.codeToTokens(match.text, {
        lang: getFiletypeFromFileName(match.path),
        theme: syntaxTheme,
      })
      lines.set(match.line, tokens[0] ?? [])
      tokensByPath.set(match.path, lines)
    }
    self.postMessage({ id, tokens: tokensByPath } satisfies SearchHighlightResponse)
  } catch {
    // Keep the existing plain-text snippets and match highlights if a grammar fails.
    if (id === latestRequest)
      self.postMessage({ id, tokens: new Map() } satisfies SearchHighlightResponse)
  }
}
